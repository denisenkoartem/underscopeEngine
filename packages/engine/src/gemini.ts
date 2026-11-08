// Thin wrapper around the Gemini Developer API (@google/genai) for the free-text parser:
// key lookup, client construction, one call with one retry on transient failures, a usage
// line per call on the log, and one-line error messages (never a stack trace, never the key).

import { ApiError, GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";

/** The parts of a response the parser reads. A real GenerateContentResponse has all of them. */
export type GeminiResponse = Pick<GenerateContentResponse, "candidates" | "usageMetadata" | "promptFeedback" | "modelVersion">;

/** The one method of the GoogleGenAI client the parser uses; tests inject a fake. */
export interface GeminiClient {
  models: { generateContent(params: GenerateContentParameters): Promise<GeminiResponse> };
}

/** Default model for extraction and (unless PARSER_MARKET_MODEL is set) market fit. */
export const DEFAULT_PARSER_MODEL = "gemini-3.8-flash";
/** Per-request timeout unless PARSER_TIMEOUT_MS is set. A trivial gemini-3.8-flash call once took ~88 s. */
export const DEFAULT_PARSER_TIMEOUT_MS = 180_000;
/** HTTP statuses retried once (by this module, not the SDK). */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** Wait before the one retry: the 429 RetryInfo delay when given (capped), else this. */
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * USD per million tokens for Gemini models. Deliberately EMPTY: no official Google pricing page
 * was checked for these models, so every call logs "cost: n/a (pricing not configured)". Fill a
 * row only from https://ai.google.dev/gemini-api/docs/pricing (and note the date checked).
 */
export const GEMINI_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {};

/** Thrown for every Gemini failure the user must act on. The message is one line, key-free. */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/** GOOGLE_API_KEY, else GEMINI_API_KEY. An empty value counts as missing. */
export function resolveGeminiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.GOOGLE_API_KEY || env.GEMINI_API_KEY || undefined;
}

/** PARSER_TIMEOUT_MS is kept in this range (ms). Node's setTimeout fires at once above 2^31-1 ms. */
export const MIN_PARSER_TIMEOUT_MS = 1_000;
export const MAX_PARSER_TIMEOUT_MS = 1_800_000;

/**
 * The per-request timeout: PARSER_TIMEOUT_MS clamped to MIN..MAX_PARSER_TIMEOUT_MS, or the default
 * when it is unset or not a positive number. `warn` gets one line when the value is not used as set.
 */
export function parserTimeoutMs(env: NodeJS.ProcessEnv, warn?: (line: string) => void): number {
  const raw = env.PARSER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PARSER_TIMEOUT_MS;
  const fromEnv = Number(raw);
  if (!Number.isFinite(fromEnv) || fromEnv <= 0) {
    warn?.(`parse: WARNING PARSER_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive number of milliseconds; using ${DEFAULT_PARSER_TIMEOUT_MS}`);
    return DEFAULT_PARSER_TIMEOUT_MS;
  }
  const clamped = Math.min(MAX_PARSER_TIMEOUT_MS, Math.max(MIN_PARSER_TIMEOUT_MS, Math.round(fromEnv)));
  if (clamped !== fromEnv) {
    warn?.(`parse: WARNING PARSER_TIMEOUT_MS=${raw} is outside ${MIN_PARSER_TIMEOUT_MS}..${MAX_PARSER_TIMEOUT_MS} ms; using ${clamped}`);
  }
  return clamped;
}

/**
 * Gemini Developer API client (generativelanguage.googleapis.com, not Vertex AI) with the
 * per-request timeout. No SDK retries: callGemini retries once itself. Makes no request.
 */
export function createGeminiClient(apiKey: string, env: NodeJS.ProcessEnv = process.env): GeminiClient {
  return new GoogleGenAI({ apiKey, vertexai: false, httpOptions: { timeout: parserTimeoutMs(env) } });
}

/** Per-call usage, as recorded in the parser metadata block. */
export interface GeminiUsage {
  call: string;
  model: string;
  prompt_tokens: number;
  candidates_tokens: number;
  thoughts_tokens: number;
  tool_use_prompt_tokens: number;
  search_queries: number;
  latency_ms: number;
  finish_reason: string | null;
}

export interface CallContext {
  client: GeminiClient;
  log: (line: string) => void;
  /** Every successful call is appended here. */
  usage: GeminiUsage[];
  timeoutMs: number;
  /** The API key, only so it can be scrubbed from any error text. */
  apiKey?: string;
  /** Milliseconds clock for latency; defaults to Date.now. */
  clock?: () => number;
  /** Wait before a retry; defaults to setTimeout. Tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

const oneLine = (s: string, max = 240): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/**
 * Remove the key (and anything shaped like a Google API key, even a cut-off one) from text that
 * may reach the user. Scrub BEFORE truncating, or a cut can leave part of the key behind.
 */
export function scrubKey(text: string, apiKey?: string): string {
  let out = apiKey ? text.split(apiKey).join("[redacted]") : text;
  out = out.replace(/AIza[0-9A-Za-z_-]{8,}/g, "[redacted]");
  return out;
}

interface ErrorBody {
  message?: unknown;
  status?: unknown;
  details?: unknown;
}

/** The JSON error body that an ApiError carries as its message, or null. */
function errorBody(e: unknown): ErrorBody | null {
  if (!(e instanceof Error)) return null;
  try {
    const body = JSON.parse(e.message) as { error?: ErrorBody };
    return body && typeof body.error === "object" && body.error !== null ? body.error : null;
  } catch {
    return null;
  }
}

/** The API's own message from an ApiError (its message is the JSON error body). */
function apiMessage(e: ApiError): string {
  const body = errorBody(e);
  if (!body) return e.message;
  const msg = typeof body.message === "string" ? body.message : "";
  const status = typeof body.status === "string" ? body.status : "";
  return [status, msg].filter(Boolean).join(": ") || e.message;
}

/** Quota details of a 429 body (google.rpc.QuotaFailure and RetryInfo), when present. */
export interface QuotaInfo {
  /** Quota ids that were exceeded, e.g. "GenerateRequestsPerMinutePerProjectPerModel". */
  quotas: string[];
  /** The exceeded limit as the API states it ("0" means this key has no quota for it). */
  limit?: string;
  /** Suggested wait before retrying, in milliseconds. */
  retryDelayMs?: number;
}

export function quotaInfo(e: unknown): QuotaInfo {
  const info: QuotaInfo = { quotas: [] };
  const details = errorBody(e)?.details;
  if (!Array.isArray(details)) return info;
  for (const d of details as Record<string, unknown>[]) {
    const type = typeof d?.["@type"] === "string" ? (d["@type"] as string) : "";
    if (type.endsWith("QuotaFailure") && Array.isArray(d.violations)) {
      for (const v of d.violations as Record<string, unknown>[]) {
        const id = typeof v.quotaId === "string" ? v.quotaId : typeof v.quotaMetric === "string" ? v.quotaMetric : "";
        if (id && !info.quotas.includes(id)) info.quotas.push(id);
        if (info.limit === undefined && (typeof v.quotaValue === "string" || typeof v.quotaValue === "number")) {
          info.limit = String(v.quotaValue);
        }
      }
    }
    if (type.endsWith("RetryInfo") && typeof d.retryDelay === "string") {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay);
      if (m) info.retryDelayMs = Math.round(Number(m[1]) * 1000);
    }
  }
  return info;
}

/**
 * A 429 whose Google error body has neither QuotaFailure nor RetryInfo (live: only a
 * google.rpc.Help link, "check your plan and billing details"). Seen on the Google Search
 * grounded call while plain calls passed. Per-minute limits carry both details, so this is not
 * one of them: waiting a second does not help, and it is not retried.
 */
export function quotaExhaustedWithoutDetails(e: unknown): boolean {
  if (statusOf(e) !== 429 || errorBody(e) === null) return false;
  const q = quotaInfo(e);
  return q.quotas.length === 0 && q.retryDelayMs === undefined;
}

function quotaText(q: QuotaInfo): string {
  const parts = [
    q.quotas.length ? `quota ${q.quotas.join(", ")}` : "",
    q.limit !== undefined ? `limit ${q.limit}` : "",
    q.retryDelayMs !== undefined ? `retry after ${Math.ceil(q.retryDelayMs / 1000)} s` : "",
  ].filter(Boolean);
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function statusOf(e: unknown): number | undefined {
  if (e instanceof ApiError) return e.status;
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * The raw text of a failure: the API's own status and message for an ApiError; otherwise the
 * error message plus its cause's code or message (fetch reports "fetch failed" and puts the
 * reason, e.g. ECONNREFUSED, in `cause`).
 */
function errorText(e: unknown): string {
  if (e instanceof ApiError) return apiMessage(e);
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause as { code?: unknown; message?: unknown } | undefined;
  if (cause === undefined || cause === null) return e.message;
  const why =
    typeof cause === "object" && typeof cause.code === "string" && cause.code
      ? cause.code
      : typeof cause === "object" && typeof cause.message === "string" && cause.message
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "";
  return why && why !== e.message ? `${e.message} (${why})` : e.message;
}

/** A one-line, key-free message for a failed call. `retried`: whether it already had its one retry. */
export function describeGeminiError(e: unknown, model: string, timeoutMs: number, apiKey?: string, retried = true): string {
  const status = statusOf(e);
  const after = retried ? " after one retry" : "";
  // Scrub first, then cut to one line: cutting first can split the key so the scrub misses it.
  const detail = oneLine(scrubKey(errorText(e), apiKey));
  if (isTimeout(e)) {
    return `Gemini call to ${model} timed out after ${Math.round(timeoutMs / 1000)} s (raise PARSER_TIMEOUT_MS to wait longer)`;
  }
  switch (status) {
    case 400:
      if (/API_KEY_INVALID|API key not valid/i.test(detail)) {
        return "Gemini API rejected the key (400 API_KEY_INVALID): check GOOGLE_API_KEY in .env";
      }
      return `Gemini API rejected the request (400): ${detail}`;
    case 401:
      return `Gemini API rejected the key (401): check GOOGLE_API_KEY in .env (${detail})`;
    case 402:
      return "Gemini API returned 402: the prepaid credits are used up; add credits in Google AI Studio billing and retry";
    case 403:
      return `Gemini API returned 403 (permission denied): the key must be a Gemini Developer API key with the Generative Language API enabled (${detail})`;
    case 404:
      return `Gemini API returned 404 for model "${model}": set PARSER_MODEL to an available model (${detail})`;
    case 429: {
      if (quotaExhaustedWithoutDetails(e)) {
        // Not retried (see isRetryable), so never "after one retry".
        return `Gemini API quota exhausted (429): check the plan and billing in Google AI Studio (${detail})`;
      }
      const q = quotaInfo(e);
      const why = q.limit === "0" ? "; the limit is 0, so this key has no quota for it: check the plan and billing in Google AI Studio" : "";
      return scrubKey(`Gemini API quota or rate limit exceeded (429)${after}${quotaText(q)}${why}: ${detail}`, apiKey);
    }
    case 503:
      return (
        `Gemini model "${model}" is overloaded or unavailable (503)${after}: try again in a few minutes, ` +
        `or pick another model with PARSER_MODEL / PARSER_MARKET_MODEL (${detail})`
      );
    case 504:
      // The SDK sends the request timeout to the server (X-Server-Timeout), so the server gives up first.
      return (
        `Gemini API gave up on the ${model} request (504)${after}: it did not finish within the ` +
        `${Math.round(timeoutMs / 1000)} s request timeout. The model is probably overloaded: try again later, ` +
        `raise PARSER_TIMEOUT_MS, or pick another model with PARSER_MODEL / PARSER_MARKET_MODEL (${detail})`
      );
    default:
      if (status !== undefined) return `Gemini API error ${status}${after}: ${detail}`;
      return `Gemini request failed${after}: ${detail}`;
  }
}

/**
 * Transient failures worth one retry: 408/429/5xx and network errors. Not timeouts (each already
 * waited the full timeout), not other 4xx, not a 429 whose quota limit is 0 (never succeeds), and
 * not a 429 with neither QuotaFailure nor RetryInfo (an exhausted quota, not a per-minute limit).
 */
function isRetryable(e: unknown): boolean {
  if (isTimeout(e)) return false;
  const status = statusOf(e);
  if (status === 429 && (quotaInfo(e).limit === "0" || quotaExhaustedWithoutDetails(e))) return false;
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  return true; // no HTTP status: a connection-level failure
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Text of the first candidate, thought parts excluded (same rule as the SDK's `text` getter). */
export function responseText(res: GeminiResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text)
    .join("");
}

/**
 * One generateContent call: a progress line, one retry on a transient failure, then a usage
 * line. Throws GeminiError (one line, key-free) when the call fails for good.
 */
export async function callGemini(ctx: CallContext, label: string, params: GenerateContentParameters): Promise<GeminiResponse> {
  const clock = ctx.clock ?? Date.now;
  for (let attempt = 1; ; attempt++) {
    ctx.log(`parse: calling ${params.model} (${label}${attempt > 1 ? ", retry" : ""}) ...`);
    const started = clock();
    let res: GeminiResponse;
    try {
      res = await ctx.client.models.generateContent(params);
    } catch (e) {
      if (attempt === 1 && isRetryable(e)) {
        const status = statusOf(e);
        const suggested = status === 429 ? quotaInfo(e).retryDelayMs : undefined;
        const wait = Math.min(suggested ?? RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
        ctx.log(`parse: ${label} failed (${status ?? "network error"}); retrying once in ${Math.ceil(wait / 1000)} s`);
        await (ctx.sleep ?? defaultSleep)(wait);
        continue;
      }
      throw new GeminiError(describeGeminiError(e, params.model, ctx.timeoutMs, ctx.apiKey, attempt > 1), statusOf(e));
    }
    const latency = clock() - started;
    const block = res.promptFeedback?.blockReason;
    if (block) throw new GeminiError(`Gemini blocked the ${label} request (${block})`);
    recordUsage(ctx, label, params.model, res, latency);
    return res;
  }
}

function recordUsage(ctx: CallContext, label: string, model: string, res: GeminiResponse, latencyMs: number): void {
  const u = res.usageMetadata;
  const cand = res.candidates?.[0];
  const usage: GeminiUsage = {
    call: label,
    model,
    prompt_tokens: u?.promptTokenCount ?? 0,
    candidates_tokens: u?.candidatesTokenCount ?? 0,
    thoughts_tokens: u?.thoughtsTokenCount ?? 0,
    tool_use_prompt_tokens: u?.toolUsePromptTokenCount ?? 0,
    search_queries: cand?.groundingMetadata?.webSearchQueries?.length ?? 0,
    latency_ms: Math.round(latencyMs),
    finish_reason: cand?.finishReason ?? null,
  };
  ctx.usage.push(usage);
  ctx.log(
    `parse: gemini call (${label}): model=${model} finish=${usage.finish_reason ?? "none"} ` +
      `prompt=${usage.prompt_tokens} candidates=${usage.candidates_tokens} thoughts=${usage.thoughts_tokens} ` +
      `tool_use_prompt=${usage.tool_use_prompt_tokens} search_queries=${usage.search_queries} ` +
      `latency=${(latencyMs / 1000).toFixed(1)}s ${costText(model, usage)}`,
  );
}

function costText(model: string, u: GeminiUsage): string {
  const p = GEMINI_PRICING_PER_MTOK[model];
  if (!p) return "cost: n/a (pricing not configured)";
  // Thoughts and tool-use prompt tokens bill as output and input respectively.
  const usd = ((u.prompt_tokens + u.tool_use_prompt_tokens) * p.input + (u.candidates_tokens + u.thoughts_tokens) * p.output) / 1e6;
  return `cost: $${usd.toFixed(4)} (tokens only; search grounding not included)`;
}

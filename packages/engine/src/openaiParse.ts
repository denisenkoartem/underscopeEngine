// Thin wrapper around the OpenAI Responses API for the free-text parser: key lookup, client
// construction, one request with one retry on transient failures, a usage line per request on
// the log, and one-line error messages (never a stack trace, never the key).
//
// The model is fixed: gpt-4o-mini for both parser calls (user decision, 2026-11-07). There is no
// model override.
//
// Separate from src/openaiMarket.ts (the engine's own market-fit call): that module always sends
// reasoning settings, which gpt-4o-mini rejects, and lets the SDK retry silently. The parser
// retries itself so that each retry is logged, as it did with Gemini.

import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionWebSearch,
} from "openai/resources/responses/responses";

/** The one method of the OpenAI client the parser uses; tests inject a fake. */
export interface ParserClient {
  responses: { create(body: ResponseCreateParamsNonStreaming): Promise<Response> };
}

/**
 * The model for extraction and market fit, always. OpenAI's model lookup on 2026-11-07 listed
 * gpt-4o-mini with shutdown_date 2027-01-14: after that date every parse fails with a 404.
 */
export const PARSER_MODEL = "gpt-4o-mini";
/** Per-request timeout unless PARSER_TIMEOUT_MS is set. */
export const DEFAULT_PARSER_TIMEOUT_MS = 180_000;
/** HTTP statuses retried once (by this module, not the SDK). */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
/** Wait before the one retry: the 429 retry-after delay when given (capped), else this. */
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * USD per million tokens, standard tier. Source: https://developers.openai.com/api/docs/pricing
 * (and the gpt-4o-mini model page), checked 2026-11-07. Update here when prices change.
 */
export const PARSER_PRICES_PER_MTOK: Record<string, { input: number; cached_input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, cached_input: 0.075, output: 0.6 },
};
/**
 * Web search: $10.00 per 1,000 calls (same page). For gpt-4o-mini the search content is billed as
 * a fixed block of 8,000 input tokens per call; the API reports that block inside
 * usage.input_tokens (seen live: 8,174 input tokens for a one-line prompt with one search), so the
 * token cost already covers it.
 */
export const USD_PER_WEB_SEARCH = 10 / 1000;

/** Thrown for every OpenAI failure the user must act on. The message is one line, key-free. */
export class ParserApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ParserApiError";
  }
}

/** OPENAI_API_KEY. An empty value counts as missing. */
export function resolveOpenAIKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.OPENAI_API_KEY || undefined;
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

/** OpenAI client with the per-request timeout and no SDK retries (callOpenAI retries once itself). Makes no request. */
export function createParserClient(apiKey: string, env: NodeJS.ProcessEnv = process.env): ParserClient {
  return new OpenAI({ apiKey, timeout: parserTimeoutMs(env), maxRetries: 0 });
}

/** Per-request usage, as recorded in the parser metadata block. */
export interface ParserUsage {
  call: string;
  model: string;
  /** All input tokens, cached ones and the web-search content block included. */
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  /** Billable web searches. */
  web_searches: number;
  latency_ms: number;
  /** Response status: "completed", or "incomplete (<reason>)". */
  status: string | null;
  /** USD, or null when the model has no price row. */
  cost_usd: number | null;
}

export interface CallContext {
  client: ParserClient;
  log: (line: string) => void;
  /** Every successful request is appended here. */
  usage: ParserUsage[];
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
 * Remove the key, and anything shaped like an OpenAI key (OpenAI's 401 text echoes a masked one,
 * "sk-proj-****abcd"), from text that may reach the user. Scrub BEFORE truncating, or a cut can
 * leave part of the key behind.
 */
export function scrubKey(text: string, apiKey?: string): string {
  let out = apiKey ? text.split(apiKey).join("[redacted]") : text;
  out = out.replace(/sk-[A-Za-z0-9_*.-]{3,}/g, "[redacted]");
  return out;
}

function isTimeout(e: unknown): boolean {
  if (e instanceof OpenAI.APIConnectionTimeoutError) return true;
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/** OpenAI's error code, e.g. "insufficient_quota", "rate_limit_exceeded", "model_not_found". */
function codeOf(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && c !== "" ? c : undefined;
}

/**
 * The raw text of a failure: "<code>: <message>" from the API's error body; otherwise the error
 * message plus its cause's code or message (a connection error reads "Connection error." and puts
 * the reason, e.g. ECONNREFUSED, in `cause`).
 */
function errorText(e: unknown): string {
  if (e instanceof OpenAI.APIError && e.status !== undefined) {
    const body = e.error as { message?: unknown } | undefined;
    const msg = typeof body?.message === "string" && body.message ? body.message : e.message;
    const code = codeOf(e) ?? e.type;
    return code ? `${code}: ${msg}` : msg;
  }
  if (!(e instanceof Error)) return String(e);
  let cause = (e as { cause?: unknown }).cause as { code?: unknown; message?: unknown; cause?: unknown } | undefined;
  // fetch puts the reason one level deeper: Connection error -> TypeError("fetch failed") -> ECONNREFUSED.
  if (cause && typeof cause === "object" && typeof cause.code !== "string" && cause.cause && typeof cause.cause === "object") {
    cause = cause.cause as typeof cause;
  }
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

/** A 429 that waiting does not fix: the account is out of credits or over its spend limit. */
const quotaExhausted = (e: unknown): boolean => statusOf(e) === 429 && codeOf(e) === "insufficient_quota";

/** A one-line, key-free message for a failed request. `retried`: whether it already had its one retry. */
export function describeOpenAIError(e: unknown, model: string, timeoutMs: number, apiKey?: string, retried = true): string {
  const status = statusOf(e);
  const after = retried ? " after one retry" : "";
  // Scrub first, then cut to one line: cutting first can split the key so the scrub misses it.
  const detail = oneLine(scrubKey(errorText(e), apiKey));
  if (isTimeout(e)) {
    return `OpenAI call to ${model} timed out after ${Math.round(timeoutMs / 1000)} s (raise PARSER_TIMEOUT_MS to wait longer)`;
  }
  switch (status) {
    case 400:
      return `OpenAI API rejected the request (400): ${detail}`;
    case 401:
      return `OpenAI API rejected the key (401): check OPENAI_API_KEY in .env (${detail})`;
    case 403:
      return `OpenAI API returned 403 (permission denied): check that the key's project may use ${model} (${detail})`;
    case 404:
      return (
        `OpenAI API returned 404 for model "${model}": the key's project cannot use it, or OpenAI has shut it ` +
        `down (OpenAI listed its shutdown date as 2027-01-14) (${detail})`
      );
    case 429:
      if (quotaExhausted(e)) {
        // Not retried (see isRetryable), so never "after one retry".
        return `OpenAI API quota exhausted (429): add credits or raise the spend limit in the OpenAI billing settings (${detail})`;
      }
      return `OpenAI API rate limit exceeded (429)${after}: wait a minute and try again (${detail})`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `OpenAI API error ${status}${after}: the service is failing or overloaded; try again in a few minutes (${detail})`;
    default:
      if (status !== undefined) return `OpenAI API error ${status}${after}: ${detail}`;
      return `OpenAI request failed${after}: ${detail}`;
  }
}

/**
 * Transient failures worth one retry: 408/409/429/5xx and connection errors. Not timeouts (each
 * already waited the full timeout), not other 4xx, and not an insufficient_quota 429 (an empty
 * balance, which waiting does not fix).
 */
function isRetryable(e: unknown): boolean {
  if (isTimeout(e)) return false;
  if (quotaExhausted(e)) return false;
  const status = statusOf(e);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  return true; // no HTTP status: a connection-level failure
}

/** The retry-after-ms / retry-after delay of a 429, in milliseconds, when the API gives one. */
export function retryAfterMs(e: unknown): number | undefined {
  const headers = (e as { headers?: unknown } | null)?.headers;
  if (!(headers instanceof Headers)) return undefined;
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
  const s = Number(headers.get("retry-after"));
  if (Number.isFinite(s) && s > 0) return Math.round(s * 1000);
  return undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The answer text: every output_text part of the output messages, in order. */
export function responseText(res: Response): string {
  let text = "";
  for (const item of res.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content) if (part.type === "output_text") text += part.text;
  }
  return text;
}

/** The model's refusal text, when it refused. */
export function refusalText(res: Response): string | undefined {
  for (const item of res.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content) if (part.type === "refusal") return part.refusal;
  }
  return undefined;
}

/** The web_search_call items of a response. */
export function webSearchCalls(res: Response): ResponseFunctionWebSearch[] {
  return (res.output ?? []).filter((i): i is ResponseFunctionWebSearch => i.type === "web_search_call");
}

/** "completed", or "incomplete (max_output_tokens)" and the like. */
export function statusText(res: Response): string {
  const s = res.status ?? "unknown";
  return s === "incomplete" ? `incomplete (${res.incomplete_details?.reason ?? "no reason given"})` : s;
}

/**
 * One Responses API request: a progress line, one retry on a transient failure, then a usage
 * line. Throws ParserApiError (one line, key-free) when the request fails for good or the
 * response status is "failed". An incomplete response or a refusal is returned: the caller
 * treats it as unusable output.
 */
export async function callOpenAI(ctx: CallContext, label: string, body: ResponseCreateParamsNonStreaming): Promise<Response> {
  const clock = ctx.clock ?? Date.now;
  const model = String(body.model);
  for (let attempt = 1; ; attempt++) {
    ctx.log(`parse: calling ${model} (${label}${attempt > 1 ? ", retry" : ""}) ...`);
    const started = clock();
    let res: Response;
    try {
      res = await ctx.client.responses.create(body);
    } catch (e) {
      if (attempt === 1 && isRetryable(e)) {
        const status = statusOf(e);
        const suggested = status === 429 ? retryAfterMs(e) : undefined;
        const wait = Math.min(suggested ?? RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
        ctx.log(`parse: ${label} failed (${status ?? "network error"}); retrying once in ${Math.ceil(wait / 1000)} s`);
        await (ctx.sleep ?? defaultSleep)(wait);
        continue;
      }
      throw new ParserApiError(describeOpenAIError(e, model, ctx.timeoutMs, ctx.apiKey, attempt > 1), statusOf(e));
    }
    recordUsage(ctx, label, model, res, clock() - started);
    if (res.status === "failed") {
      const why = res.error ? `${res.error.code}: ${res.error.message}` : "no error details";
      throw new ParserApiError(`OpenAI ${label} response failed (${oneLine(scrubKey(why, ctx.apiKey))})`);
    }
    return res;
  }
}

/** Cost in USD from the price table, or null when the model has none. */
export function parserCostUsd(model: string, u: Pick<ParserUsage, "input_tokens" | "cached_input_tokens" | "output_tokens" | "web_searches">): number | null {
  const p = PARSER_PRICES_PER_MTOK[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!p) return null;
  const uncached = Math.max(0, u.input_tokens - u.cached_input_tokens);
  const tokens = uncached * p.input + u.cached_input_tokens * p.cached_input + u.output_tokens * p.output;
  return tokens / 1_000_000 + u.web_searches * USD_PER_WEB_SEARCH;
}

function recordUsage(ctx: CallContext, label: string, model: string, res: Response, latencyMs: number): void {
  const u = res.usage;
  // Billable searches: the API's own count when it reports one, else the search actions
  // (opening a page or finding in it is not a billed search).
  const searchActions = webSearchCalls(res).filter((c) => c.action?.type === "search").length;
  const counts = {
    input_tokens: u?.input_tokens ?? 0,
    cached_input_tokens: u?.input_tokens_details?.cached_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    web_searches: res.tool_usage?.web_search?.num_requests ?? searchActions,
  };
  const usage: ParserUsage = {
    call: label,
    model,
    ...counts,
    latency_ms: Math.round(latencyMs),
    status: res.status ? statusText(res) : null,
    cost_usd: parserCostUsd(model, counts),
  };
  ctx.usage.push(usage);
  const cost = usage.cost_usd === null ? "cost: n/a (pricing not configured)" : `cost: $${usage.cost_usd.toFixed(4)}`;
  ctx.log(
    `parse: openai call (${label}): model=${model} status=${usage.status ?? "unknown"} ` +
      `input=${usage.input_tokens} cached=${usage.cached_input_tokens} output=${usage.output_tokens} ` +
      `web_searches=${usage.web_searches} latency=${(latencyMs / 1000).toFixed(1)}s ${cost}`,
  );
}

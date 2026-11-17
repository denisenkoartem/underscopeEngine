// The client for the reader's model server: one request with one retry on a transient failure, a
// usage line per request on the log, and one-line error messages.
//
// The server is local and free (reader/model/serve.py, or vLLM): it speaks the OpenAI-compatible
// HTTP format, so the `openai` npm package is used only as an HTTP client pointed at PARSER_BASE_URL
// (src/chatAdapter.ts). Nothing here calls OpenAI or any paid service.

import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";

/** The one method of the client the reader uses; tests inject a fake. */
export interface ParserClient {
  responses: { create(body: ResponseCreateParamsNonStreaming): Promise<Response> };
}

export const DEFAULT_PARSER_TIMEOUT_MS = 180_000;
/** HTTP statuses retried once (by this module, not the SDK). */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
/** Wait before the one retry. */
const RETRY_DELAY_MS = 1_000;

/** Thrown for every failure of the model server the user must act on. The message is one line. */
export class ParserApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ParserApiError";
  }
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

/** Per-request usage. */
export interface ParserUsage {
  call: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  /** Response status: "completed", or "incomplete (<reason>)". */
  status: string | null;
}

export interface CallContext {
  client: ParserClient;
  log: (line: string) => void;
  /** Log-line prefix. */
  prefix?: string;
  /** Every successful request is appended here. */
  usage: ParserUsage[];
  timeoutMs: number;
  /** The server's URL: errors name it. */
  server?: string;
  /** Milliseconds clock for latency; defaults to Date.now. */
  clock?: () => number;
  /** Wait before a retry; defaults to setTimeout. Tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
}

const oneLine = (s: string, max = 240): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

function isTimeout(e: unknown): boolean {
  if (e instanceof OpenAI.APIConnectionTimeoutError) return true;
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/**
 * The raw text of a failure: the message from the server's error body; otherwise the error message
 * plus its cause's code or message (a connection error reads "Connection error." and puts the
 * reason, e.g. ECONNREFUSED, in `cause`).
 */
function errorText(e: unknown): string {
  if (e instanceof OpenAI.APIError && e.status !== undefined) {
    const body = e.error as { message?: unknown } | undefined;
    return typeof body?.message === "string" && body.message ? body.message : e.message;
  }
  if (!(e instanceof Error)) return String(e);
  let cause = (e as { cause?: unknown }).cause as { code?: unknown; message?: unknown; cause?: unknown } | undefined;
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

/** A one-line message for a failed request. `retried`: whether it already had its one retry. */
export function describeError(e: unknown, model: string, timeoutMs: number, retried = true): string {
  const status = statusOf(e);
  const after = retried ? " after one retry" : "";
  const detail = oneLine(errorText(e));
  if (isTimeout(e)) return `call to ${model} timed out after ${Math.round(timeoutMs / 1000)} s (raise PARSER_TIMEOUT_MS to wait longer)`;
  if (status === 404) return `returned 404 for model "${model}": the server does not have it (${detail})`;
  if (status === 401 || status === 403) return `rejected the request (${status}): check PARSER_API_KEY if the server needs a key (${detail})`;
  if (status !== undefined) return `error ${status}${after}: ${detail}`;
  return `request failed${after}: ${detail}`;
}

/** Transient failures worth one retry: 408/409/429/5xx and connection errors. Not timeouts, not other 4xx. */
function isRetryable(e: unknown): boolean {
  if (isTimeout(e)) return false;
  const status = statusOf(e);
  return status === undefined || RETRYABLE_STATUS.has(status);
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

/** "completed", or "incomplete (max_output_tokens)" and the like. */
export function statusText(res: Response): string {
  const s = res.status ?? "unknown";
  return s === "incomplete" ? `incomplete (${res.incomplete_details?.reason ?? "no reason given"})` : s;
}

/**
 * One request to the model server: a progress line, one retry on a transient failure, then a usage
 * line. Throws ParserApiError (one line) when the request fails for good or the response status is
 * "failed". An incomplete response or a refusal is returned: the caller treats it as unusable.
 */
export async function callModel(ctx: CallContext, label: string, body: ResponseCreateParamsNonStreaming): Promise<Response> {
  const clock = ctx.clock ?? Date.now;
  const model = String(body.model);
  const prefix = ctx.prefix ?? "read";
  const where = ctx.server ? `server ${ctx.server}: ` : "model server: ";
  for (let attempt = 1; ; attempt++) {
    ctx.log(`${prefix}: calling ${model} (${label}${attempt > 1 ? ", retry" : ""}) ...`);
    const started = clock();
    let res: Response;
    try {
      res = await ctx.client.responses.create(body);
    } catch (e) {
      if (attempt === 1 && isRetryable(e)) {
        ctx.log(`${prefix}: ${label} failed (${statusOf(e) ?? "network error"}); retrying once in ${Math.ceil(RETRY_DELAY_MS / 1000)} s`);
        await (ctx.sleep ?? defaultSleep)(RETRY_DELAY_MS);
        continue;
      }
      throw new ParserApiError(where + describeError(e, model, ctx.timeoutMs, attempt > 1), statusOf(e));
    }
    const latency = clock() - started;
    const usage: ParserUsage = {
      call: label,
      model,
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
      latency_ms: Math.round(latency),
      status: res.status ? statusText(res) : null,
    };
    ctx.usage.push(usage);
    ctx.log(`${prefix}: model call (${label}): model=${model} status=${usage.status ?? "unknown"} input=${usage.input_tokens} output=${usage.output_tokens} latency=${(latency / 1000).toFixed(1)}s`);
    if (res.status === "failed") {
      const why = res.error ? `${res.error.code}: ${res.error.message}` : "no error details";
      throw new ParserApiError(`${where}${label} response failed (${oneLine(why)})`);
    }
    return res;
  }
}

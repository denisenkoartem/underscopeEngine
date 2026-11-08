// The OpenAI half of market fit: one Responses API request with the web_search tool and a strict
// json_schema answer. marketFit.ts owns everything around it: provider selection, the report
// schema (zod), the retry, the cache and the fallback. This file builds the request, reads the
// response (status, refusal, web_search_call items and their sources, the JSON answer), logs one
// usage line per request and describes errors without the key.
//
// Data discipline: the request carries only the prompt that marketFit.ts built from the eight
// profile fields; nothing else from the record is passed in here.

import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionWebSearch,
} from "openai/resources/responses/responses";
import type { MarketUsage } from "./types.js";

/** The one method of the OpenAI client this module uses; tests inject a fake. */
export interface ResponsesClient {
  responses: { create(body: ResponseCreateParamsNonStreaming): Promise<Response> };
}

export const DEFAULT_OPENAI_MARKET_MODEL = "gpt-5.4-mini";
/** Includes reasoning tokens. A live answer on 2026-11-07 used 305 (110 of them reasoning). */
export const OPENAI_MAX_OUTPUT_TOKENS = 16_000;
/** max_output_tokens for the retry after a response stopped at max_output_tokens. */
export const OPENAI_RETRY_MAX_OUTPUT_TOKENS = 32_000;
/** Built-in tool calls allowed per request (web searches and page opens), like the Anthropic path's 5 searches. */
export const OPENAI_MAX_TOOL_CALLS = 5;
/** Reasoning effort, the counterpart of the Anthropic call's output_config effort "medium". */
export const OPENAI_REASONING_EFFORT = "medium" as const;
/** SDK retries of a failed request (connection errors, 408/409/429/5xx); SDK default: 2. */
const OPENAI_MAX_RETRIES = 1;
/** The include value that adds each search's source URLs to its web_search_call item. */
export const WEB_SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources" as const;
const SCHEMA_NAME = "market_fit";

/**
 * USD per million tokens, standard tier. Source: https://developers.openai.com/api/docs/pricing,
 * checked 2026-11-07. gpt-5.4 and gpt-5.5 are the rates for inputs under 272K tokens (a market
 * prompt plus search content is about 10K). Update here when prices change. A model missing from
 * this table logs "cost=n/a (pricing not configured)" and counts as unknown cost in `eval`.
 */
export const OPENAI_PRICES_PER_MTOK: Record<string, { input: number; cached_input: number; output: number }> = {
  "gpt-5.4-mini": { input: 0.75, cached_input: 0.075, output: 4.5 },
  "gpt-5.4": { input: 2.5, cached_input: 0.25, output: 15 },
  "gpt-5.5": { input: 5, cached_input: 0.5, output: 30 },
};
/**
 * Web search: $10.00 per 1,000 calls, all models (same page). The search content tokens are billed
 * at the model's token rates; they are part of input_tokens, so the token cost already covers them.
 */
export const USD_PER_OPENAI_WEB_SEARCH = 10 / 1000;

/** Price row for a model id (a trailing -YYYY-MM-DD snapshot date is ignored), or undefined. */
export function openaiModelPrice(model: string) {
  return OPENAI_PRICES_PER_MTOK[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
}

export interface OpenAITokenCounts {
  /** All input tokens, cached ones included (OpenAI's convention; Anthropic's input_tokens exclude cache reads). */
  input_tokens: number;
  cached_input_tokens: number;
  /** All output tokens, reasoning included. */
  output_tokens: number;
  reasoning_tokens: number;
  /** Billable web searches. */
  web_search_requests: number;
}

/** Cost in USD, or null when the model has no price row (pricing not configured). */
export function openaiCostUsd(model: string, t: OpenAITokenCounts): number | null {
  const p = openaiModelPrice(model);
  if (!p) return null;
  const uncached = Math.max(0, t.input_tokens - t.cached_input_tokens);
  const tokens = uncached * p.input + t.cached_input_tokens * p.cached_input + t.output_tokens * p.output;
  return tokens / 1_000_000 + t.web_search_requests * USD_PER_OPENAI_WEB_SEARCH;
}

/**
 * The OpenAI client for market fit: the given timeout (MARKET_TIMEOUT_MS, else 5 min) and one SDK
 * retry, like the Anthropic client. Constructing it makes no request.
 */
export function createOpenAIMarketClient(apiKey: string, timeoutMs: number): OpenAI {
  return new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: OPENAI_MAX_RETRIES });
}

/** The request body. No temperature: reasoning models reject sampling parameters. */
export function buildOpenAIRequest(
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
  maxOutputTokens: number,
): ResponseCreateParamsNonStreaming {
  return {
    model,
    input: prompt,
    tools: [{ type: "web_search" }],
    include: [WEB_SEARCH_SOURCES_INCLUDE],
    max_tool_calls: OPENAI_MAX_TOOL_CALLS,
    reasoning: { effort: OPENAI_REASONING_EFFORT },
    text: {
      format: {
        type: "json_schema",
        name: SCHEMA_NAME,
        description: "The market-fit judgment for the vehicle, after the web research. It is the only answer that is read.",
        strict: true,
        schema,
      },
    },
    max_output_tokens: maxOutputTokens,
    // Nothing needs the response later (no previous_response_id), so do not store it.
    store: false,
  };
}

export interface OpenAICallContext {
  client: ResponsesClient;
  model: string;
  prompt: string;
  /** JSON schema of the answer, sent as a strict json_schema format. */
  schema: Record<string, unknown>;
  /** Running total over every request; usage.requests counts them. */
  usage: MarketUsage;
  log: (line: string) => void;
  /** Only to scrub it from error text; never sent anywhere else by this module. */
  apiKey?: string;
  /** Milliseconds clock for latency; defaults to Date.now. */
  clock?: () => number;
}

export type OpenAIRequestOutcome =
  /** The answer text parsed as JSON (not yet checked), and the URLs the web searches saw. */
  | { kind: "answer"; json: unknown; sources: string[] }
  /** Retried once (with a larger max_output_tokens when truncated). */
  | { kind: "invalid"; problem: string; truncated?: boolean }
  /** Fall back without retrying. */
  | { kind: "stop"; reason: string };

const oneLine = (s: string, max = 300): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/**
 * Remove the key, and anything shaped like an OpenAI key (OpenAI's 401 text echoes a masked one,
 * "sk-proj-****abcd"), from text that may reach a log or the Decision.
 */
export function scrubOpenAIKey(text: string, apiKey?: string): string {
  let out = apiKey ? text.split(apiKey).join("[redacted]") : text;
  out = out.replace(/sk-[A-Za-z0-9_*.-]{3,}/g, "[redacted]");
  return out;
}

/** "401 invalid_api_key: Incorrect API key provided: [redacted]. ..."; a connection failure reads "Connection error.". */
export function describeOpenAIError(e: unknown, apiKey?: string): string {
  let text: string;
  if (e instanceof OpenAI.APIError && e.status !== undefined) {
    // e.message is "<status> <body message>" or the whole body as JSON; build it from the fields.
    const body = e.error as { message?: unknown } | undefined;
    const msg = typeof body?.message === "string" && body.message ? body.message : null;
    text = msg ? `${e.status} ${e.code ?? e.type ?? "error"}: ${msg}` : e.message;
  } else {
    text = e instanceof Error ? e.message : String(e);
  }
  // Scrub first, then cut: cutting first could leave part of the key behind.
  return oneLine(scrubOpenAIKey(text, apiKey));
}

/** URLs a web_search_call saw: a search's sources (with the include), or the page it opened or searched. */
function actionUrls(action: ResponseFunctionWebSearch["action"] | undefined): string[] {
  if (!action) return [];
  switch (action.type) {
    case "search":
      return (action.sources ?? []).map((s) => s.url).filter((u): u is string => typeof u === "string" && u !== "");
    case "open_page":
      return action.url ? [action.url] : [];
    case "find_in_page":
      return action.url ? [action.url] : [];
    default:
      return [];
  }
}

/** The answer text: every output_text part of the output messages, in order. */
function answerText(res: Response): string {
  let text = "";
  for (const item of res.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content) if (part.type === "output_text") text += part.text;
  }
  return text;
}

/**
 * One request. Order of checks: API error -> stop; status failed -> stop; refusal -> stop;
 * status incomplete -> invalid (truncated when cut at max_output_tokens); no completed
 * web_search_call -> invalid (no web evidence); no text or text that is not JSON -> invalid.
 */
export async function requestOpenAIMarketFit(
  ctx: OpenAICallContext,
  label: string,
  maxOutputTokens: number,
): Promise<OpenAIRequestOutcome> {
  const clock = ctx.clock ?? Date.now;
  const started = clock();
  let res: Response;
  try {
    res = await ctx.client.responses.create(buildOpenAIRequest(ctx.model, ctx.prompt, ctx.schema, maxOutputTokens));
  } catch (e) {
    // The SDK has already retried transient failures. The request id goes to the log only.
    if (e instanceof OpenAI.APIError && e.requestID) ctx.log(`market_fit: API error, request id ${e.requestID}`);
    return { kind: "stop", reason: `API error: ${describeOpenAIError(e, ctx.apiKey)}` };
  }
  const calls = (res.output ?? []).filter((i): i is ResponseFunctionWebSearch => i.type === "web_search_call");
  recordOpenAIUsage(ctx, res, calls, label, clock() - started);

  if (res.status === "failed") {
    const err = res.error ? `${res.error.code}: ${res.error.message}` : "no error details";
    return { kind: "stop", reason: `OpenAI response failed (${describeOpenAIError(err, ctx.apiKey)})` };
  }
  for (const item of res.output ?? []) {
    if (item.type !== "message") continue;
    const refusal = item.content.find((p) => p.type === "refusal");
    if (refusal) return { kind: "stop", reason: `model refused (${oneLine(refusal.refusal, 200)})` };
  }
  if (res.status === "incomplete") {
    const reason = res.incomplete_details?.reason ?? "no reason given";
    const truncated = reason === "max_output_tokens";
    return {
      kind: "invalid",
      problem: truncated ? `response cut off at max_output_tokens ${maxOutputTokens}` : `response incomplete (${reason})`,
      truncated,
    };
  }
  if (res.status !== undefined && res.status !== "completed") {
    return { kind: "invalid", problem: `response status ${res.status}` };
  }

  const completed = calls.filter((c) => c.status === "completed");
  const failed = calls.filter((c) => c.status !== "completed");
  if (failed.length) ctx.log(`market_fit: ${failed.length} web search call(s) not completed (${failed.map((c) => c.status).join(", ")})`);
  if (completed.length === 0) {
    // An answer with no completed search behind it is not a web analysis (and must not be cached as one).
    const what = calls.length ? `${calls.length} web_search_call(s), none completed` : "no web_search_call";
    return { kind: "invalid", problem: `no web search before the answer (${what})` };
  }
  const sources = [...new Set(completed.flatMap((c) => actionUrls(c.action)))];

  const text = answerText(res).trim();
  if (text === "") return { kind: "invalid", problem: "no answer text" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { kind: "invalid", problem: `answer is not valid JSON (${oneLine((e as Error).message, 120)})` };
  }
  return { kind: "answer", json, sources };
}

/** Add one response's usage to the running total and log one line for this request. */
function recordOpenAIUsage(
  ctx: OpenAICallContext,
  res: Response,
  calls: ResponseFunctionWebSearch[],
  label: string,
  latencyMs: number,
): void {
  const u = res.usage;
  // Billable searches: the API's own count when it reports one, else the search actions
  // (opening a page or finding in it is not a billed search).
  const billable = res.tool_usage?.web_search?.num_requests;
  const searchActions = calls.filter((c) => c.action?.type === "search").length;
  const t: OpenAITokenCounts = {
    input_tokens: u?.input_tokens ?? 0,
    cached_input_tokens: u?.input_tokens_details?.cached_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    reasoning_tokens: u?.output_tokens_details?.reasoning_tokens ?? 0,
    web_search_requests: billable ?? searchActions,
  };
  const cost = openaiCostUsd(ctx.model, t);
  ctx.usage.requests++;
  ctx.usage.input_tokens += t.input_tokens;
  ctx.usage.output_tokens += t.output_tokens;
  ctx.usage.cache_read_input_tokens += t.cached_input_tokens;
  ctx.usage.web_search_requests += t.web_search_requests;
  ctx.usage.cost_usd += cost ?? 0;
  ctx.log(
    `market_fit api call (${label}): provider=openai model=${ctx.model} status=${res.status ?? "unknown"} ` +
      `input=${t.input_tokens} cached=${t.cached_input_tokens} output=${t.output_tokens} reasoning=${t.reasoning_tokens} ` +
      `web_search_calls=${calls.length} searches=${t.web_search_requests} latency=${(latencyMs / 1000).toFixed(1)}s ` +
      `cost=${cost === null ? "n/a (pricing not configured)" : `$${cost.toFixed(4)}`}`,
  );
}

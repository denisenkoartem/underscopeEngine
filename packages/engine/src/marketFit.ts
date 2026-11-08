// Market fit: the input record's own market_fit block when it has one that is not
// "insufficient" (written by the free-text parser; source "provided", no API call, no cache, also
// with --offline); else one web-search API call per provider, model and vehicle profile (cached),
// to Anthropic or OpenAI (selectMarketProvider; the OpenAI request itself is in openaiMarket.ts),
// or the fallback table in scoring.json when offline / no key / call failed / insufficient.
//
// The fallback half of this file (evaluateRule, marketFitFallback) is final.
//
// Data discipline: the API sees only year, make, model, trim, odometer, location state, title
// brand and run status (never the VIN, flags or codes). The only numbers that come back into
// the Decision are the model's own acv/copart/confidence judgments; signals are cited text.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { readMarketCache, resolveCacheDir, writeMarketCache, type MarketAnalysis } from "./cache.js";
import { ConfigError, PACKAGE_ROOT, type EngineConfig } from "./config.js";
import { MAX_MARKET_SIGNALS, isHttpUrl, type NormalizedRecord } from "./input.js";
import {
  DEFAULT_OPENAI_MARKET_MODEL,
  OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_RETRY_MAX_OUTPUT_TOKENS,
  createOpenAIMarketClient,
  openaiModelPrice,
  requestOpenAIMarketFit,
  type OpenAICallContext,
  type ResponsesClient,
} from "./openaiMarket.js";
import {
  MARKET_PROVIDERS,
  type MarketFitResult,
  type MarketProvider,
  type MarketSignal,
  type MarketUsage,
  type ProvidedMarketFit,
  type RunStatus,
} from "./types.js";

/** The one method of the Anthropic client this module uses; tests inject a fake. */
export interface MessagesClient {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface MarketFitOptions {
  /** Anthropic client (or a fake). Only used when the anthropic provider is selected; built from the key when absent. */
  client?: MessagesClient;
  /** OpenAI client (or a fake). Only used when the openai provider is selected; built from the key when absent. */
  openaiClient?: ResponsesClient;
  /** Never call the API; always use the fallback table. */
  offline?: boolean;
  /** Year used to compute vehicle age for the fallback table. Defaults to the current year. */
  asOfYear?: number;
  /**
   * Environment to read MARKET_PROVIDER, ANTHROPIC_API_KEY / MARKET_MODEL, OPENAI_API_KEY /
   * MARKET_OPENAI_MODEL and MARKET_TIMEOUT_MS from. Defaults to process.env.
   */
  env?: NodeJS.ProcessEnv;
  /** Clock for cache expiry. Defaults to new Date(). */
  now?: Date;
  /** Cache directory override (else $MARKET_CACHE_DIR, else packages/engine/.cache/market). */
  cacheDir?: string;
  /** Where to log tokens and cost per call. Defaults to stderr. */
  log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Fallback table
// ---------------------------------------------------------------------------

export type RuleVars = Record<string, number | null>;

/**
 * Evaluate a fallback rule string from scoring.json against variables.
 * Grammar: "otherwise" | cmp (("and" | "or") cmp)*, where cmp = name op number and
 * op is one of <, <=, >, >=, ==, !=. "and" binds tighter than "or". A comparison
 * on an unknown (null) variable is false. Throws on anything else.
 */
export function evaluateRule(rule: string, vars: RuleVars): boolean {
  const text = rule.trim();
  if (text === "otherwise") return true;
  return text.split(/\s+or\s+/).some((conj) =>
    conj.split(/\s+and\s+/).every((cmp) => {
      const m = /^\s*([a-z_][a-z0-9_]*)\s*(<=|>=|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(cmp);
      if (!m) throw new Error(`Cannot parse market_fit_fallback rule "${rule}" near "${cmp}"`);
      const name = m[1]!;
      if (!(name in vars)) throw new Error(`Unknown variable "${name}" in market_fit_fallback rule "${rule}"`);
      const v = vars[name];
      if (v === null || v === undefined) return false;
      const n = Number(m[3]);
      switch (m[2]) {
        case "<":
          return v < n;
        case "<=":
          return v <= n;
        case ">":
          return v > n;
        case ">=":
          return v >= n;
        case "==":
          return v === n;
        default:
          return v !== n;
      }
    }),
  );
}

/**
 * Score market fit from the fallback table. Rules are tried in file order, skipping
 * "otherwise"; the first that holds wins, else the "otherwise" row.
 */
export function marketFitFallback(
  record: NormalizedRecord,
  config: EngineConfig,
  asOfYear: number,
  reason: string,
): MarketFitResult {
  const table = config.scoring.market_fit_fallback;
  const age_years = record.decoded.year === null ? null : asOfYear - record.decoded.year;
  const vars: RuleVars = { age_years, odometer: record.odometer };
  const rows = Object.entries(table).filter(
    (e): e is [string, { rule: string; acv: number; copart: number }] => typeof e[1] === "object",
  );
  const hit =
    rows.find(([, row]) => row.rule.trim() !== "otherwise" && evaluateRule(row.rule, vars)) ??
    rows.find(([, row]) => row.rule.trim() === "otherwise");
  if (!hit) throw new Error("scoring.json market_fit_fallback has no matching rule and no 'otherwise' row");
  const [name, row] = hit;
  const ageText = age_years === null ? "age unknown" : `age ${age_years} yr`;
  const odoText = record.odometer === null ? "odometer unknown" : `${record.odometer.toLocaleString("en-US")} mi`;
  return {
    acv: row.acv,
    copart: row.copart,
    confidence: table.confidence,
    factors: [`Fallback table row "${name}" (${ageText}, ${odoText}; rule: ${row.rule})`, `Fallback used: ${reason}`],
    excluded: [],
    source: "fallback",
    signals: [],
    fallback_reason: reason,
  };
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * USD per million tokens (cache_write = 5-minute cache write). Source: the live pricing page,
 * https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-07 (cache hits on
 * Sonnet 5.5 and Opus 5.5 are 0.05x base input; the bundled skill's $0.20 for Sonnet 5.5 is out
 * of date). Update here when prices change; a model missing from this table costs $0 in tokens,
 * with a warning.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
};
/** Web search: $10 per 1,000 searches (same page), billed whatever the model. */
const USD_PER_WEB_SEARCH = 10 / 1000;

export type TokenCounts = Omit<MarketUsage, "provider" | "model" | "cost_usd" | "requests">;

/** Token price row for a model id (a trailing -YYYYMMDD snapshot date is ignored), or undefined. */
export function modelPrice(model: string) {
  return PRICES_PER_MTOK[model.replace(/-\d{8}$/, "")];
}

/** Cost in USD of one usage object. Unknown model: tokens count as $0 (warned), searches still count. */
export function computeCostUsd(model: string, t: TokenCounts, warn?: (line: string) => void): number {
  const search = t.web_search_requests * USD_PER_WEB_SEARCH;
  const p = modelPrice(model);
  if (!p) {
    warn?.(`market_fit: WARNING no token price for model "${model}"; token cost counted as $0`);
    return search;
  }
  const tokens =
    t.input_tokens * p.input +
    t.output_tokens * p.output +
    t.cache_read_input_tokens * p.cache_read +
    t.cache_creation_input_tokens * p.cache_write;
  return tokens / 1_000_000 + search;
}

// ---------------------------------------------------------------------------
// Online scorer
// ---------------------------------------------------------------------------

export const DEFAULT_MARKET_MODEL = "claude-sonnet-5-5";
export const MARKET_PROMPT_PATH = join(PACKAGE_ROOT, "prompts", "market_fit.md");
const REPORT_TOOL = "report_market_fit";
/**
 * Billed web searches allowed per attempt (one request plus its pause_turn continuations). The
 * tool's max_uses only limits one request: searches that web_search_20260209's dynamic filtering
 * runs from code execution do not count against max_uses in later requests of the same turn. So
 * each continuation gets max_uses = the searches left, and a paused attempt that has used them all
 * falls back instead of continuing. Per vehicle that is at most MAX_ATTEMPTS x MAX_SEARCHES.
 */
const MAX_SEARCHES = 5;
const MAX_SIGNALS = MAX_MARKET_SIGNALS;
/** pause_turn resumes allowed per attempt (the server pauses long web-search turns). */
const MAX_CONTINUATIONS = 3;
/** One call plus one retry when the tool call is missing or invalid. */
const MAX_ATTEMPTS = 2;
const MAX_TOKENS = 16_000;
/**
 * max_tokens for the retry after output was cut off at max_tokens. Non-streaming requests stay
 * under the SDK's 10-minute estimate (3600 x max_tokens / 128,000 s), i.e. at most 21,333 tokens.
 */
const RETRY_MAX_TOKENS = 21_000;
/** Per-request timeout for the market-fit client unless MARKET_TIMEOUT_MS is set (SDK default: 10 min). */
export const DEFAULT_MARKET_TIMEOUT_MS = 300_000;
/** SDK retries of a failed request (connection errors, 408/409/429/5xx); SDK default: 2. */
const MARKET_MAX_RETRIES = 1;

/**
 * The Anthropic client for market fit, with an explicit timeout ($MARKET_TIMEOUT_MS, else 5 min)
 * and one SDK retry, so a stalled endpoint costs at most 2 x timeout per request before the
 * fallback, instead of the SDK's 3 x 10 min. Constructing it makes no request.
 */
export function createMarketClient(apiKey: string, env: NodeJS.ProcessEnv = process.env): Anthropic {
  return new Anthropic({ apiKey, timeout: marketTimeoutMs(env), maxRetries: MARKET_MAX_RETRIES });
}

/** Per-request timeout for either provider: $MARKET_TIMEOUT_MS when it is a positive number, else 5 min. */
export function marketTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.MARKET_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MARKET_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

/** The provider, its key and model for a web market-fit call. */
export interface MarketProviderChoice {
  provider: MarketProvider;
  apiKey: string;
  model: string;
}

/** Why no provider can be used; `loud` when the user set MARKET_PROVIDER (worth a log line). */
export interface NoMarketProvider {
  reason: string;
  loud: boolean;
}

const KEY_VAR: Record<MarketProvider, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

/**
 * MARKET_PROVIDER = "anthropic" | "openai" picks that provider (its key must be set); unset or
 * empty = auto: ANTHROPIC_API_KEY set -> anthropic, else OPENAI_API_KEY set -> openai, else none.
 * Empty (or blank) keys count as missing. Models: MARKET_MODEL (anthropic, default
 * claude-sonnet-5-5) and MARKET_OPENAI_MODEL (openai, default gpt-5.4-mini).
 */
export function selectMarketProvider(env: NodeJS.ProcessEnv = process.env): MarketProviderChoice | NoMarketProvider {
  const keyOf = (p: MarketProvider): string | undefined => {
    const k = env[KEY_VAR[p]];
    return k && k.trim() !== "" ? k : undefined;
  };
  const choose = (provider: MarketProvider, apiKey: string): MarketProviderChoice => ({
    provider,
    apiKey,
    model:
      provider === "anthropic"
        ? env.MARKET_MODEL || DEFAULT_MARKET_MODEL
        : env.MARKET_OPENAI_MODEL || DEFAULT_OPENAI_MARKET_MODEL,
  });
  const wanted = (env.MARKET_PROVIDER ?? "").trim().toLowerCase();
  if (wanted !== "") {
    if (!(MARKET_PROVIDERS as readonly string[]).includes(wanted)) {
      return { reason: `MARKET_PROVIDER "${env.MARKET_PROVIDER}" is not one of ${MARKET_PROVIDERS.join(", ")}`, loud: true };
    }
    const provider = wanted as MarketProvider;
    const key = keyOf(provider);
    return key ? choose(provider, key) : { reason: `no ${KEY_VAR[provider]} (MARKET_PROVIDER is ${provider})`, loud: true };
  }
  for (const provider of ["anthropic", "openai"] as const) {
    const key = keyOf(provider);
    if (key) return choose(provider, key);
  }
  return { reason: "no API key (set OPENAI_API_KEY or ANTHROPIC_API_KEY)", loud: false };
}

const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  run_and_drive: "runs and drives",
  engine_starts: "engine starts but does not drive",
  no: "does not run",
  unknown: "unknown",
};

/** A line `<!-- tail: <provider> -->` starts that provider's closing section of the prompt. */
const TAIL_MARKER = /^<!-- tail: ([a-z0-9_-]+) -->[ \t]*\r?\n?/gm;

/**
 * The shared text of prompts/market_fit.md (comment stripped) followed by the provider's tail.
 * Each tail runs from its marker to the next marker or the end of the file.
 */
function promptForProvider(template: string, provider: MarketProvider): string {
  const text = template.replace(/^\s*<!--[\s\S]*?-->\s*/, ""); // the leading comment is for editors, not the model
  const parts = text.split(TAIL_MARKER);
  // split with a capture group: [shared, name1, tail1, name2, tail2, ...]
  const tails = new Map<string, string>();
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const name = parts[i]!;
    if (tails.has(name)) throw new ConfigError(`${MARKET_PROMPT_PATH}: two "<!-- tail: ${name} -->" sections`);
    tails.set(name, parts[i + 1]!);
  }
  const tail = tails.get(provider);
  if (tail === undefined) throw new ConfigError(`${MARKET_PROMPT_PATH}: no "<!-- tail: ${provider} -->" section`);
  return `${parts[0]!}${tail.trimEnd()}\n`;
}

/**
 * Fill prompts/market_fit.md for this record and provider (shared text plus that provider's
 * tail). Only the eight profile fields are available to it.
 */
export function buildMarketPrompt(record: NormalizedRecord, template?: string, provider: MarketProvider = "anthropic"): string {
  if (template === undefined) {
    try {
      template = readFileSync(MARKET_PROMPT_PATH, "utf8");
    } catch (e) {
      throw new ConfigError(`Cannot read ${MARKET_PROMPT_PATH}: ${(e as Error).message}`);
    }
  }
  const d = record.decoded;
  const values: Record<string, string> = {
    year: d.year === null ? "unknown" : String(d.year),
    make: d.make ?? "unknown",
    model: d.model ?? "unknown",
    trim: d.trim ?? "unknown",
    odometer: record.odometer === null ? "unknown" : `${record.odometer.toLocaleString("en-US")} miles`,
    location_state: record.location_state ?? "unknown",
    title_brand: record.title.brand,
    run_status: RUN_STATUS_TEXT[record.runs_drives],
  };
  return promptForProvider(template, provider).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => {
      const v = values[name];
      if (v === undefined) throw new ConfigError(`${MARKET_PROMPT_PATH}: unknown placeholder ${m}`);
      return v;
    });
}

// The report's JSON schema: the strict report_market_fit tool's input (Anthropic) and the strict
// json_schema answer format (OpenAI). The API guarantees answers match it. Ranges are not
// expressible in a strict schema (no minimum/maximum), so they are stated in descriptions and
// checked with zod (ReportSchema).
const REPORT_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    acv: { type: "number", description: "ACV (dealer wholesale) market fit, a judgment from -1 to 1." },
    copart: { type: "number", description: "Copart (salvage) market fit, a judgment from -1 to 1." },
    confidence: { type: "number", description: "0 to 1: how much relevant, consistent evidence was found." },
    signals: {
      type: "array",
      description: "Up to 5 cited findings.",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "One short factual finding. Prices may appear only here." },
          url: { type: "string", description: "http(s) URL of the page the finding came from." },
        },
        required: ["claim", "url"],
        additionalProperties: false,
      },
    },
    insufficient: { type: "boolean", description: "True if too little relevant evidence was found." },
  },
  required: ["acv", "copart", "confidence", "signals", "insufficient"],
  additionalProperties: false,
};

const REPORT_TOOL_DEF: Anthropic.Tool = {
  name: REPORT_TOOL,
  description:
    "Report the market-fit judgment for the vehicle. Call this exactly once, after the web research; " +
    "it is the only answer that is read.",
  strict: true,
  input_schema: REPORT_JSON_SCHEMA,
};

/** Out-of-range scores are a validation failure (retry, then fallback), never clamped. */
const ReportSchema = z.object({
  acv: z.number().min(-1).max(1),
  copart: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.object({ claim: z.string(), url: z.string() })),
  insufficient: z.boolean(),
});
type Report = z.infer<typeof ReportSchema>;

const hostOf = (url: string): string => new URL(url).hostname.toLowerCase().replace(/^www\./, "");

/** Same site: equal hosts (ignoring www.), or one a subdomain of the other. */
const sameSite = (a: string, b: string): boolean => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/**
 * Keep signals with a claim and an http(s) URL; when the web search sources are known (OpenAI),
 * also only those whose domain is among them. At most MAX_SIGNALS.
 */
function cleanSignals(raw: Report["signals"], log: (line: string) => void, sources?: string[]): MarketSignal[] {
  let kept = raw
    .map((s) => ({ claim: s.claim.trim(), url: s.url.trim() }))
    .filter((s) => s.claim !== "" && isHttpUrl(s.url));
  if (kept.length < raw.length) {
    log(`market_fit: dropped ${raw.length - kept.length} signal(s) without a claim or an http(s) URL`);
  }
  if (sources) {
    const seen = sources.filter(isHttpUrl).map(hostOf);
    if (seen.length === 0) {
      log("market_fit: the web search returned no source URLs; signal domains not checked");
    } else {
      const unseen = kept.filter((s) => !seen.some((h) => sameSite(hostOf(s.url), h)));
      if (unseen.length) {
        log(
          `market_fit: dropped ${unseen.length} signal(s) whose domain is not among the web search sources: ` +
            [...new Set(unseen.map((s) => hostOf(s.url)))].join(", "),
        );
        kept = kept.filter((s) => !unseen.includes(s));
      }
    }
  }
  if (kept.length > MAX_SIGNALS) log(`market_fit: kept the first ${MAX_SIGNALS} of ${kept.length} signals`);
  return kept.slice(0, MAX_SIGNALS);
}

const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

const leanText = (acv: number, copart: number) => (acv > copart ? "favors ACV" : copart > acv ? "favors Copart" : "is neutral");

/** "2 cited signal(s): example.com, data.example.org". Domains only: claim text (and any price in it) stays out. */
function signalsFactor(signals: MarketSignal[]): string {
  if (signals.length === 0) return "No cited signals with a URL";
  const domains = [...new Set(signals.map((s) => new URL(s.url).hostname.replace(/^www\./, "")))];
  return `${signals.length} cited signal(s): ${domains.join(", ")}`;
}

/** Result for a valid, sufficient analysis. Factors are built here from the judgments only. */
function webResult(a: MarketAnalysis, source: "web" | "cache", usage?: MarketUsage, cachedAt?: Date): MarketFitResult {
  const factors = [
    `Web market analysis (${a.provider} ${a.model}) ${leanText(a.acv, a.copart)} ` +
      `(ACV ${signed(a.acv)}, Copart ${signed(a.copart)}, confidence ${a.confidence.toFixed(2)})`,
    signalsFactor(a.signals),
  ];
  if (cachedAt) factors.push(`Cached web analysis from ${cachedAt.toISOString().slice(0, 10)} (7-day TTL)`);
  return {
    acv: a.acv,
    copart: a.copart,
    confidence: a.confidence,
    factors,
    excluded: [],
    source,
    signals: a.signals,
    ...(usage ? { usage } : {}),
  };
}

/**
 * Result for the input record's own market_fit block (one that is not insufficient): its acv,
 * copart and confidence as given, source "provided". No API call and no cache. Factors are built
 * here from the scores, the provider, the date and the cited domains (never the claim text);
 * signals are copied, minus any without an http(s) URL, at most MAX_SIGNALS.
 */
export function providedMarketFit(p: ProvidedMarketFit, log: (line: string) => void = () => {}): MarketFitResult {
  const withUrl = p.signals
    .map((s) => ({ claim: s.claim.trim(), url: s.url.trim() }))
    .filter((s) => s.claim !== "" && isHttpUrl(s.url));
  if (withUrl.length < p.signals.length) {
    log(`market_fit: dropped ${p.signals.length - withUrl.length} provided signal(s) without a claim or an http(s) URL`);
  }
  const signals = withUrl.slice(0, MAX_SIGNALS);
  return {
    acv: p.acv,
    copart: p.copart,
    confidence: p.confidence,
    factors: [
      `Provided market analysis ${leanText(p.acv, p.copart)} (ACV ${signed(p.acv)}, Copart ${signed(p.copart)}, ` +
        `confidence ${p.confidence.toFixed(2)}; ${p.provider}, generated ${p.generated_at.slice(0, 10)})`,
      signalsFactor(signals),
    ],
    excluded: [],
    source: "provided",
    signals,
  };
}

type AttemptOutcome =
  | { kind: "ok"; report: Report; sources?: string[] } // sources: URLs the web searches saw (OpenAI)
  | { kind: "invalid"; problem: string; truncated?: boolean } // retried once (with more max_tokens if truncated)
  | { kind: "stop"; reason: string }; // fall back without retrying

interface CallContext {
  client: MessagesClient;
  model: string;
  prompt: string;
  /** Running total over every request; usage.requests counts them. */
  usage: MarketUsage;
  log: (line: string) => void;
}

/** "401 authentication_error: invalid x-api-key"; a connection failure reads "Connection error.". */
function describeError(e: unknown): string {
  // The SDK's own message already starts with the status and, for an error body, is that whole
  // body as JSON (request id included), so build the text from the parsed fields instead.
  if (e instanceof Anthropic.APIError && e.status !== undefined && e.apiMessage) {
    return `${e.status} ${e.type ?? "error"}: ${e.apiMessage}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** One logical call: the first request plus any pause_turn continuations. */
async function runAttempt(ctx: CallContext, attempt: number, maxTokens: number): Promise<AttemptOutcome> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: ctx.prompt }];
  let searchesOk = 0;
  /** Billed searches of this attempt (usage.server_tool_use.web_search_requests, summed). */
  let searchesBilled = 0;
  /** Code-execution container that dynamic filtering runs in; continuations must reuse it. */
  let container: string | undefined;
  const searchErrors: string[] = [];
  for (let continuation = 0; ; continuation++) {
    let res: Anthropic.Message;
    try {
      res = await ctx.client.messages.create({
        model: ctx.model,
        max_tokens: maxTokens,
        // No temperature/top_p/top_k: non-default values 400 on current models.
        output_config: { effort: "medium" },
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES - searchesBilled },
          REPORT_TOOL_DEF,
        ],
        // Forced tool_choice ("any"/"tool") 400s on claude-sonnet-5-5: auto + prompt instruction + strict tool.
        tool_choice: { type: "auto" },
        messages: [...messages],
        ...(container ? { container } : {}),
      });
    } catch (e) {
      // The SDK has already retried transient failures (MARKET_MAX_RETRIES). The request id goes
      // to the log only, never into the Decision.
      if (e instanceof Anthropic.APIError && e.requestID) ctx.log(`market_fit: API error, request id ${e.requestID}`);
      return { kind: "stop", reason: `API error: ${describeError(e)}` };
    }
    searchesBilled += recordUsage(ctx, res, `attempt ${attempt}${continuation ? ` continuation ${continuation}` : ""}`);
    container = res.container?.id ?? container;

    if (res.stop_reason === "refusal") {
      return { kind: "stop", reason: `model refused (${res.stop_details?.category ?? "no category"})` };
    }
    for (const b of res.content) {
      if (b.type !== "web_search_tool_result") continue;
      // Server-tool errors do not throw: an error result's content is an object, a success is a list.
      if (Array.isArray(b.content)) searchesOk++;
      else searchErrors.push(b.content.error_code);
    }
    const call = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === REPORT_TOOL,
    );
    if (res.stop_reason === "pause_turn" && !call) {
      if (searchesBilled >= MAX_SEARCHES) {
        // Continuing would run more searches than MAX_SEARCHES; retrying would repeat the research.
        return { kind: "stop", reason: `paused after ${searchesBilled} web searches (limit ${MAX_SEARCHES}) without a report` };
      }
      if (continuation >= MAX_CONTINUATIONS) {
        return { kind: "invalid", problem: `still paused after ${MAX_CONTINUATIONS} continuations` };
      }
      // Re-send with the paused assistant turn appended; the server resumes it (no extra user turn).
      messages.push({ role: "assistant", content: res.content });
      continue;
    }

    if (searchErrors.length) ctx.log(`market_fit: web search error(s): ${searchErrors.join(", ")}`);
    if (searchErrors.length && searchesOk === 0) {
      // Every search failed: whatever the model reports is not web evidence. Not cached.
      return { kind: "stop", reason: `web search failed (${[...new Set(searchErrors)].join(", ")})` };
    }
    if (res.stop_reason === "max_tokens") {
      const where = call ? "tool input cut off" : `output cut off before the ${REPORT_TOOL} call`;
      return { kind: "invalid", problem: `${where} at max_tokens ${maxTokens}`, truncated: true };
    }
    if (!call) return { kind: "invalid", problem: `no ${REPORT_TOOL} call (stop_reason ${res.stop_reason})` };
    // A report with no search result behind it is not a web analysis (and must not be cached as one).
    if (searchesOk === 0) return { kind: "invalid", problem: `no web search result before the ${REPORT_TOOL} call` };
    const parsed = ReportSchema.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { kind: "invalid", problem: `invalid ${REPORT_TOOL} input: ${issues}` };
    }
    return { kind: "ok", report: parsed.data };
  }
}

/** Add one response's usage to the running total and log one line for this API call. Returns its billed searches. */
function recordUsage(ctx: CallContext, res: Anthropic.Message, label: string): number {
  const u = res.usage;
  const t: TokenCounts = {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    web_search_requests: u.server_tool_use?.web_search_requests ?? 0,
  };
  const cost = computeCostUsd(ctx.model, t);
  ctx.usage.requests++;
  ctx.usage.input_tokens += t.input_tokens;
  ctx.usage.output_tokens += t.output_tokens;
  ctx.usage.cache_read_input_tokens += t.cache_read_input_tokens;
  ctx.usage.cache_creation_input_tokens += t.cache_creation_input_tokens;
  ctx.usage.web_search_requests += t.web_search_requests;
  ctx.usage.cost_usd += cost;
  ctx.log(
    `market_fit api call (${label}): provider=anthropic model=${ctx.model} stop=${res.stop_reason} input=${t.input_tokens} ` +
      `output=${t.output_tokens} cache_read=${t.cache_read_input_tokens} cache_write=${t.cache_creation_input_tokens} ` +
      `searches=${t.web_search_requests} cost=$${cost.toFixed(4)}`,
  );
  return t.web_search_requests;
}

/** One OpenAI request, its JSON answer checked with the same ReportSchema as the Anthropic report. */
async function runOpenAIAttempt(ctx: OpenAICallContext, attempt: number, maxTokens: number): Promise<AttemptOutcome> {
  const out = await requestOpenAIMarketFit(ctx, `attempt ${attempt}`, maxTokens);
  if (out.kind !== "answer") return out;
  const parsed = ReportSchema.safeParse(out.json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { kind: "invalid", problem: `invalid market_fit JSON: ${issues}` };
  }
  return { kind: "ok", report: parsed.data, sources: out.sources };
}

/**
 * Whether usage.cost_usd is a real total. False for an OpenAI model without a price row, whose
 * requests log "cost=n/a (pricing not configured)" and add $0. (An Anthropic model without a price
 * row still counts its web searches and warns that tokens were counted as $0.)
 */
export function usageCostKnown(u: MarketUsage): boolean {
  return (u.provider ?? "anthropic") === "anthropic" || openaiModelPrice(u.model) !== undefined;
}

/**
 * Market-fit score for a record. Order: the record's own market_fit block when it is not
 * insufficient -> "provided" (no API call, no cache, also when offline); offline -> fallback; no
 * usable provider (selectMarketProvider: no key, empty counts as missing) -> fallback without
 * touching a client; fresh disk cache for this provider and model -> "cache"; else one API call
 * (retried once on a missing/invalid answer) -> "web", cached for 7 days. API errors, refusals, failed searches, invalid output twice and
 * "insufficient" all fall back (with one "market_fit: falling back" line on the log). A fallback
 * that followed real API calls carries their `usage` so run costs stay complete. A provided block
 * marked insufficient is not used: the normal path runs and a last factor says so.
 */
export async function scoreMarketFit(
  record: NormalizedRecord,
  config: EngineConfig,
  opts: MarketFitOptions = {},
): Promise<MarketFitResult> {
  const provided = record.provided_market_fit;
  if (provided && !provided.insufficient) {
    return providedMarketFit(provided, opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`)));
  }
  const result = await scoreWebOrFallback(record, config, opts);
  if (!provided) return result;
  const note = `Provided market fit (${provided.provider}, generated ${provided.generated_at.slice(0, 10)}) is marked insufficient: not used`;
  return { ...result, factors: [...result.factors, note] };
}

/** scoreMarketFit without the provided block: offline / no key -> fallback, else cache, else the API. */
async function scoreWebOrFallback(
  record: NormalizedRecord,
  config: EngineConfig,
  opts: MarketFitOptions,
): Promise<MarketFitResult> {
  const asOfYear = opts.asOfYear ?? new Date().getFullYear();
  const fallback = (reason: string, usage?: MarketUsage): MarketFitResult => ({
    ...marketFitFallback(record, config, asOfYear, reason),
    ...(usage ? { usage } : {}),
  });
  if (opts.offline) return fallback("offline mode");
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const choice = selectMarketProvider(env);
  if ("reason" in choice) {
    if (choice.loud) log(`market_fit: falling back (${choice.reason})`);
    return fallback(choice.reason);
  }
  const { provider, apiKey, model } = choice;

  const now = opts.now ?? new Date();
  const cacheDir = resolveCacheDir(opts.cacheDir, env);
  // With a key, a fallback is worth one stderr line (the reason is otherwise only in the JSON).
  const loggedFallback = (reason: string, usage?: MarketUsage): MarketFitResult => {
    log(`market_fit: falling back (${reason})`);
    return fallback(reason, usage);
  };

  // An insufficient analysis is a fallback, but its signals are logged (explanation only, unused).
  const fromAnalysis = (a: MarketAnalysis, usage?: MarketUsage, cachedAt?: Date): MarketFitResult => {
    if (!a.insufficient) return webResult(a, cachedAt ? "cache" : "web", usage, cachedAt);
    log(`market_fit: insufficient web evidence; signals (not used): ${JSON.stringify(a.signals)}`);
    const when = cachedAt ? ` (cached ${cachedAt.toISOString().slice(0, 10)})` : "";
    return loggedFallback(`insufficient web evidence${when}`, usage);
  };

  const hit = readMarketCache(cacheDir, record, now, { provider, model });
  if (hit) {
    log(`market_fit: cache hit from ${hit.created_at.toISOString()} (${cacheDir})`);
    // Re-clean signals: a hand-edited cache file must not smuggle in URL-less signals.
    const analysis = { ...hit.analysis, signals: cleanSignals(hit.analysis.signals, log) };
    return fromAnalysis(analysis, undefined, hit.created_at);
  }

  const usage: MarketUsage = { provider, model, requests: 0, ...emptyCounts(), cost_usd: 0 };
  const prompt = buildMarketPrompt(record, undefined, provider);
  let attemptOnce: (attempt: number, maxTokens: number) => Promise<AttemptOutcome>;
  let maxTokens: number;
  let retryMaxTokens: number;
  let tokensParam: string;
  if (provider === "anthropic") {
    if (!modelPrice(model)) computeCostUsd(model, emptyCounts(), log); // logs the unknown-price warning once
    const ctx: CallContext = { client: opts.client ?? createMarketClient(apiKey, env), model, prompt, usage, log };
    attemptOnce = (attempt, max) => runAttempt(ctx, attempt, max);
    [maxTokens, retryMaxTokens, tokensParam] = [MAX_TOKENS, RETRY_MAX_TOKENS, "max_tokens"];
  } else {
    if (!openaiModelPrice(model)) log(`market_fit: no OpenAI price for model "${model}"; cost n/a (pricing not configured)`);
    const ctx: OpenAICallContext = {
      client: opts.openaiClient ?? createOpenAIMarketClient(apiKey, marketTimeoutMs(env)),
      model,
      prompt,
      schema: REPORT_JSON_SCHEMA,
      usage,
      log,
      apiKey,
    };
    attemptOnce = (attempt, max) => runOpenAIAttempt(ctx, attempt, max);
    [maxTokens, retryMaxTokens, tokensParam] = [OPENAI_MAX_OUTPUT_TOKENS, OPENAI_RETRY_MAX_OUTPUT_TOKENS, "max_output_tokens"];
  }
  const spent = () => (usage.requests > 0 ? usage : undefined);

  let problem = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = await attemptOnce(attempt, maxTokens);
    if (outcome.kind === "stop") return loggedFallback(outcome.reason, spent());
    if (outcome.kind === "invalid") {
      problem = outcome.problem;
      // Retrying a cut-off answer with the same budget would only repeat the cut.
      if (outcome.truncated) maxTokens = Math.max(maxTokens, retryMaxTokens);
      const retry = attempt < MAX_ATTEMPTS ? `; retrying once${outcome.truncated ? ` with ${tokensParam} ${maxTokens}` : ""}` : "";
      log(`market_fit: attempt ${attempt}: ${problem}${retry}`);
      continue;
    }
    const analysis: MarketAnalysis = {
      ...outcome.report,
      signals: cleanSignals(outcome.report.signals, log, outcome.sources),
      provider,
      model,
    };
    try {
      writeMarketCache(cacheDir, record, analysis, now);
    } catch (e) {
      log(`market_fit: WARNING could not write cache in ${cacheDir}: ${(e as Error).message}`);
    }
    return fromAnalysis(analysis, spent());
  }
  return loggedFallback(`invalid model output twice (${problem})`, spent());
}

function emptyCounts(): TokenCounts {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    web_search_requests: 0,
  };
}

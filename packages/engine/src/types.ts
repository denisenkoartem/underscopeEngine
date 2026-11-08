// Shared types for the Underscope v1 decision engine (ACV vs Copart).
// Every module imports from here; change these only with care.

export const OPTIONS = ["acv", "copart"] as const;
export type Option = (typeof OPTIONS)[number];

export const CATEGORIES = ["title", "drivable", "hidden_risk", "market_fit"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Hidden-risk flags, in verify_first tie-break order (frame wins ties). */
export const FLAG_NAMES = ["frame", "airbag", "flood", "module_no_comm", "monitors_incomplete"] as const;
export type FlagName = (typeof FLAG_NAMES)[number];

export const FLAG_VALUES = ["no", "yes", "suspected", "unknown"] as const;
export type FlagValue = (typeof FLAG_VALUES)[number];

export const TITLE_BRANDS = ["clean", "rebuilt", "salvage", "nonrepairable", "unknown"] as const;
export type TitleBrand = (typeof TITLE_BRANDS)[number];

export const RUN_STATUSES = ["run_and_drive", "engine_starts", "no", "unknown"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const CODE_STATUSES = ["confirmed", "pending", "history"] as const;
export type CodeStatus = (typeof CODE_STATUSES)[number];

/** Vehicle systems a reported symptom (a complaint in the user's own words) can belong to. */
export const SYMPTOM_SYSTEMS = [
  "transmission",
  "engine",
  "brakes",
  "steering_suspension",
  "electrical",
  "body",
  "interior",
  "other",
] as const;
export type SymptomSystem = (typeof SYMPTOM_SYSTEMS)[number];

/** A disclosed mechanical/electrical complaint, e.g. {system: "transmission", text: "transmission is generating noise"}. */
export interface ReportedSymptom {
  system: SymptomSystem;
  /** The user's own words. */
  text: string;
}

/**
 * A market-fit judgment supplied with the input record (written by the free-text parser).
 * Used as is when `insufficient` is false: no API call, no cache.
 */
export interface ProvidedMarketFit {
  acv: number;
  copart: number;
  confidence: number;
  /** As given; a signal whose url is "" had no URL and is dropped by the market-fit scorer. */
  signals: MarketSignal[];
  insufficient: boolean;
  /** Who produced it, e.g. "gemini-3.8-flash + Google Search". */
  provider: string;
  /** ISO 8601 date or date-time. */
  generated_at: string;
}

/** Where a category score came from ("provided" = the input record's own market_fit block). */
export type ScoreSource = "input" | "web" | "cache" | "fallback" | "provided";

/** What every scorer returns. */
export interface ScoreResult {
  /** Score for ACV in [-1, 1]. Meaningless (0) when ACV is in `excluded`. */
  acv: number;
  /** Score for Copart in [-1, 1]. Meaningless (0) when Copart is in `excluded`. */
  copart: number;
  /** 0..1; multiplies the weighted score. */
  confidence: number;
  /** Human-readable facts that drove the score, most important first. */
  factors: string[];
  /** Options this scorer rules out entirely (e.g. salvage title excludes ACV). */
  excluded: Option[];
  /** Why the options in `excluded` are ruled out (one sentence). */
  exclusion_reason?: string;
  source: ScoreSource;
}

export interface MarketSignal {
  claim: string;
  url: string;
}

/** Which API produced a web market-fit result. */
export const MARKET_PROVIDERS = ["anthropic", "openai"] as const;
export type MarketProvider = (typeof MARKET_PROVIDERS)[number];

export interface MarketUsage {
  /** Absent on results written before the OpenAI provider existed (treat as "anthropic"). */
  provider?: MarketProvider;
  model: string;
  /** API requests behind this result (retries and pause_turn continuations each count). */
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  web_search_requests: number;
  cost_usd: number;
}

export interface MarketFitResult extends ScoreResult {
  /** Cited signals from the web analysis. Explanation only: never used as numbers. */
  signals: MarketSignal[];
  /** Set when an API call was made in this run (absent for cache hits and fallback). */
  usage?: MarketUsage;
  /** Why the fallback table was used, when source === "fallback". */
  fallback_reason?: string;
}

export interface CategoryScore {
  acv: number;
  copart: number;
  confidence: number;
  factors: string[];
  source: ScoreSource;
}

export type Confidence = "clear" | "close_call" | "insufficient";

export interface Decision {
  /** null only when no option is eligible (confidence "insufficient"). */
  recommendation: Option | null;
  probabilities: { acv: number; copart: number };
  confidence: Confidence;
  /** A hidden-risk flag name (e.g. "frame"), "confirm title brand", or null when nothing would move the answer. */
  verify_first: string | null;
  category_scores: Record<Category, CategoryScore>;
  /** Exactly 3. */
  reasons: string[];
  /** Exactly 2. */
  risks: string[];
  market_signals: MarketSignal[];
  weights_version: number;
  excluded: { option: Option; reason: string }[];
  /** Prices the input carried, echoed for display. NOT used in any score or probability (v1). */
  valuation: Valuation | null;
}

/**
 * Optional prices from the input record (e.g. from the codes team's notes). Carried through
 * to the Decision and the explain table only; the decision math never reads them (user decision,
 * round 4). Repair costs and price bands are a later version.
 */
export interface Valuation {
  /** Clean-condition wholesale value, USD. */
  clean_wholesale: number | null;
  /** Comparable salvage sale prices, USD, as given. */
  salvage_comps: number[];
  /** What the seller paid, USD. */
  purchase_price: number | null;
}

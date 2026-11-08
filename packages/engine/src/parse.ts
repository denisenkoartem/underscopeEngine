// Free-text parser: turns a seller's notes ("transmission is generating noise, 2019 Ford F-150
// XLT, 84k miles, Texas") into a full engine input record, plus an optional market_fit block
// from a Gemini call with Google Search, plus a `parser` metadata block (evidence, unmapped notes,
// search queries, usage).
//
// Two Gemini calls at most (each retried once on invalid output), one HTTP request each per attempt:
//  1. Extraction: structured JSON output (responseJsonSchema), no tools, low thinking.
//     Everything the model returns is re-checked here: an evidence quote that is not in the text
//     resets its field to unknown, codes not literally in the text are dropped, symptom texts not
//     in the text are dropped, and a VIN/year/make/model/trim/odometer/state the quote does not
//     show is reset. A title brand or lane limit needs its keyword in the quote; other enum
//     quotes need a real word; a "confirmed" code the text calls pending/history/cleared is
//     downgraded; make/model/trim must be short plain names (they reach the market prompt).
//     Fields the text says nothing about stay "unknown"/null/absent.
//  2. Market fit (only when year, make and model are known): the Google Search tool, a JSON
//     object in the reply text, validated with zod. Sends ONLY year, make, model, trim, odometer,
//     location_state, title brand and run status: never the free text, VIN, flags, codes or
//     symptoms.
//
// The output (toEngineInput) is valid engine input: `pnpm -s engine decide <saved.json> --offline`.
// Every record field is present: "unknown" (enums) or null where the text says nothing, and the
// dotted paths of those fields are listed in parser.unknown_fields.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ThinkingLevel, type GenerateContentParameters, type GroundingChunkWeb } from "@google/genai";
import { z } from "zod";
import { ConfigError, PACKAGE_ROOT } from "./config.js";
import {
  DEFAULT_PARSER_MODEL,
  GeminiError,
  callGemini,
  createGeminiClient,
  parserTimeoutMs,
  resolveGeminiKey,
  responseText,
  type CallContext,
  type GeminiClient,
  type GeminiResponse,
  type GeminiUsage,
} from "./gemini.js";
import {
  ConditionRecordSchema,
  MAX_MARKET_SIGNALS,
  MarketFitBlockSchema,
  OBD_CODE_PATTERN,
  isHttpUrl,
  type ConditionRecordInput,
} from "./input.js";
import {
  CODE_STATUSES,
  FLAG_NAMES,
  FLAG_VALUES,
  OPTIONS,
  RUN_STATUSES,
  SYMPTOM_SYSTEMS,
  TITLE_BRANDS,
  type CodeStatus,
  type FlagName,
  type FlagValue,
  type Option,
  type ProvidedMarketFit,
  type ReportedSymptom,
  type RunStatus,
  type SymptomSystem,
  type TitleBrand,
} from "./types.js";

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** The record part of the output: engine input fields, reported_symptoms always present. */
export type ParsedRecord = ConditionRecordInput & { reported_symptoms: ReportedSymptom[] };

export interface ParserMeta {
  /** Extraction model. */
  model: string;
  /** Market-fit model, or null when no market call was made. */
  market_model: string | null;
  input_text: string;
  /** Dotted field path -> exact quote from the input text that supports it. */
  field_evidence: Record<string, string>;
  /** Dotted paths the text did not support (left "unknown", null or out of the record). */
  unknown_fields: string[];
  /** Things the user said that fit no field (from the model). */
  unmapped: string[];
  /** What the parser itself did: resets, dropped codes, why market fit was skipped. */
  notes: string[];
  /** Google Search queries behind market_fit. */
  search_queries: string[];
  /** One entry per successful Gemini call. */
  usage: GeminiUsage[];
}

export interface ParseResult {
  record: ParsedRecord;
  market_fit?: ProvidedMarketFit;
  parser: ParserMeta;
}

export interface ParseOptions {
  /** Gemini client (or a fake). Built from the key when absent. */
  client?: GeminiClient;
  /** Client factory used when `client` is absent (tests check it is never called without a key). */
  createClient?: (apiKey: string, env: NodeJS.ProcessEnv) => GeminiClient;
  /** Environment for GOOGLE_API_KEY / GEMINI_API_KEY / PARSER_*; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Extraction model; else $PARSER_MODEL, else gemini-3.8-flash. */
  model?: string;
  /** Market model; else $PARSER_MARKET_MODEL, else the extraction model. */
  marketModel?: string;
  /** Timestamp for market_fit.generated_at; defaults to new Date(). */
  now?: Date;
  /** false skips the market call. Default true. */
  market?: boolean;
  /** Progress, usage and warning lines; defaults to stderr. */
  log?: (line: string) => void;
  /** Milliseconds clock for latency; defaults to Date.now. */
  clock?: () => number;
  /** Wait before a retry of a transient API failure; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Every parser failure the user must act on. The CLI prints its one-line message and exits 1. */
export class ParseError extends Error {
  constructor(
    message: string,
    /**
     * Set when the extraction succeeded but the market call failed for good (401/402/403/404):
     * the record without market_fit, so the paid extraction is not lost (the CLI still prints it).
     */
    readonly partial?: ParseResult,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

export const RECORD_PROMPT_PATH = join(PACKAGE_ROOT, "prompts", "parse_record.md");
export const MARKET_PROMPT_PATH = join(PACKAGE_ROOT, "prompts", "parse_market.md");
/** Longer notes are refused rather than sent (a cost guard). */
export const MAX_TEXT_CHARS = 20_000;
/** One call plus one retry on invalid output, for each of the two calls. */
const MAX_ATTEMPTS = 2;
const MAX_SIGNALS = MAX_MARKET_SIGNALS;
const MAX_UNMAPPED = 20;

// ---------------------------------------------------------------------------
// Extraction call
// ---------------------------------------------------------------------------

const evidenceProp = { type: "string", description: "Exact quote copied from the notes that supports the value." };
const field = (value: Record<string, unknown>, description: string) => ({
  type: "object",
  description,
  properties: { value, evidence: evidenceProp },
  required: ["value", "evidence"],
});
const flagField = (description: string) => field({ type: "string", enum: [...FLAG_VALUES] }, description);

/** responseJsonSchema for the extraction call. Leave a field out when the notes do not support it. */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    vin: field({ type: "string" }, "17-character VIN, only if written out in the notes."),
    year: field({ type: "integer" }, "Model year as written."),
    make: field({ type: "string" }, "Make as written (a nickname such as Chevy may be expanded)."),
    model: field({ type: "string" }, "Model as written."),
    trim: field({ type: "string" }, "Trim as written."),
    odometer: field({ type: "integer" }, "Odometer in whole miles."),
    location_state: field({ type: "string" }, "2-letter US state code where the vehicle is."),
    title_brand: field({ type: "string", enum: [...TITLE_BRANDS] }, "Title brand, only when stated."),
    title_state: field({ type: "string" }, "2-letter US state that issued the title, only when stated."),
    runs_drives: field({ type: "string", enum: [...RUN_STATUSES] }, "Run status."),
    flags: {
      type: "object",
      properties: {
        frame: flagField("Frame or unibody damage."),
        airbag: flagField("Airbags / SRS."),
        flood: flagField("Water or flood damage."),
        module_no_comm: flagField("Control modules not communicating."),
        monitors_incomplete: flagField("Emission readiness monitors incomplete."),
      },
    },
    scan_done: field({ type: "boolean" }, "true when the notes say a code scan was done (including 'no codes')."),
    codes: {
      type: "array",
      description: "Diagnostic trouble codes written in the notes. Never add one that is not there.",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          status: { type: "string", enum: [...CODE_STATUSES] },
          evidence: evidenceProp,
        },
        required: ["code", "status", "evidence"],
      },
    },
    lanes_allowed: field(
      { type: "array", items: { type: "string", enum: [...OPTIONS] } },
      "Only when the seller limits where the vehicle may be sold.",
    ),
    reported_symptoms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          system: { type: "string", enum: [...SYMPTOM_SYSTEMS] },
          text: { type: "string", description: "The user's own words, copied exactly." },
        },
        required: ["system", "text"],
      },
    },
    unmapped: { type: "array", items: { type: "string" } },
  },
  required: ["codes", "reported_symptoms", "unmapped"],
} as const;

const fieldOf = <T extends z.ZodType>(value: T) =>
  z.object({ value: value.nullish(), evidence: z.string().nullish() }).nullish();

const FlagAnswer = fieldOf(z.enum(FLAG_VALUES));

/** What the extraction call must return (lenient where the code re-checks anyway). */
const ExtractionSchema = z.object({
  vin: fieldOf(z.string()),
  year: fieldOf(z.number()),
  make: fieldOf(z.string()),
  model: fieldOf(z.string()),
  trim: fieldOf(z.string()),
  odometer: fieldOf(z.number()),
  location_state: fieldOf(z.string()),
  title_brand: fieldOf(z.enum(TITLE_BRANDS)),
  title_state: fieldOf(z.string()),
  runs_drives: fieldOf(z.enum(RUN_STATUSES)),
  flags: z
    .object({
      frame: FlagAnswer,
      airbag: FlagAnswer,
      flood: FlagAnswer,
      module_no_comm: FlagAnswer,
      monitors_incomplete: FlagAnswer,
    } satisfies Record<FlagName, typeof FlagAnswer>)
    .nullish(),
  scan_done: fieldOf(z.boolean()),
  codes: z
    .array(z.object({ code: z.string(), status: z.enum(CODE_STATUSES), evidence: z.string().nullish() }))
    .nullish(),
  lanes_allowed: fieldOf(z.array(z.enum(OPTIONS))),
  reported_symptoms: z.array(z.object({ system: z.string(), text: z.string() })).nullish(),
  unmapped: z.array(z.string()).nullish(),
});
type Extraction = z.infer<typeof ExtractionSchema>;

/** Load a prompt file without its leading <!-- editor comment -->. */
function loadPrompt(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`Cannot read ${path}: ${(e as Error).message}`);
  }
  return text.replace(/^﻿/, "").replace(/^\s*<!--[\s\S]*?-->\s*/, "");
}

const issuesText = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** Structured-output extraction, retried once on unusable output. */
async function runExtraction(ctx: CallContext, model: string, text: string): Promise<Extraction> {
  const params: GenerateContentParameters = {
    model,
    contents: [{ role: "user", parts: [{ text: `<notes>\n${text}\n</notes>` }] }],
    config: {
      systemInstruction: loadPrompt(RECORD_PROMPT_PATH),
      responseMimeType: "application/json",
      responseJsonSchema: EXTRACTION_JSON_SCHEMA,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      // One HTTP request per call: the SDK would otherwise resend on finish CONTINUATION without
      // a cap or a log line. A cut-off reply fails the JSON check and gets the one retry instead.
      automaticContinuation: false,
    },
  };
  let problem = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await callOrThrow(ctx, attempt === 1 ? "extraction" : "extraction retry", params);
    problem = "";
    const raw = responseText(res).trim();
    let json: unknown;
    try {
      json = JSON.parse(stripFence(raw));
    } catch {
      problem = raw ? "reply is not valid JSON" : `empty reply (finish ${res.candidates?.[0]?.finishReason ?? "none"})`;
    }
    if (!problem) {
      const parsed = ExtractionSchema.safeParse(json);
      if (parsed.success) return parsed.data;
      problem = `reply does not match the extraction schema: ${issuesText(parsed.error)}`;
    }
    ctx.log(`parse: extraction attempt ${attempt}: ${problem}${attempt < MAX_ATTEMPTS ? "; retrying once" : ""}`);
  }
  throw new ParseError(`Gemini returned invalid extraction output twice (${problem.slice(0, 200)})`);
}

async function callOrThrow(ctx: CallContext, label: string, params: GenerateContentParameters): Promise<GeminiResponse> {
  try {
    return await callGemini(ctx, label, params);
  } catch (e) {
    if (e instanceof GeminiError) throw new ParseError(e.message);
    throw e;
  }
}

function stripFence(s: string): string {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s.trim());
  return m ? m[1]! : s;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Case-, whitespace- and quote-style-insensitive form used for substring checks. */
function norm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Letters and digits only, lower case: "F-150" and "f150" compare equal. */
const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Strip whitespace and a pair of wrapping quote marks a model sometimes adds around a quote. */
const cleanQuote = (q: string): string => {
  const t = q.trim();
  const m = /^(["'\u201C\u2018])([\s\S]*)(["'\u201D\u2019])$/.exec(t);
  return (m ? m[2]! : t).trim();
};

export function quoteInText(quote: string, text: string): boolean {
  const q = norm(cleanQuote(quote));
  return q.length > 0 && norm(text).includes(q);
}

const MAKE_ALIASES: Record<string, string[]> = {
  chevrolet: ["chevy"],
  volkswagen: ["vw"],
  mercedesbenz: ["mercedes", "benz"],
  cadillac: ["caddy"],
};

/** The evidence shows this name (punctuation- and case-insensitive, with a few make nicknames). */
function nameShown(value: string, evidence: string): boolean {
  const v = alnum(value);
  const e = alnum(evidence);
  if (v.length === 0) return false;
  if (e.includes(v)) return true;
  return (MAKE_ALIASES[v] ?? []).some((a) => e.includes(a));
}

/** Start offsets of every occurrence of the (normalized) quote in the (normalized) text. */
function quoteOffsets(q: string, t: string): number[] {
  const out: number[] = [];
  if (q === "") return out;
  for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + 1)) out.push(at);
  return out;
}

/**
 * The quote shows the year: "2019" in the quote, or a 2-digit "19" in it that is written "'19"
 * or comes right before the make or model ("19 f150"). A bare "19" ("19 mph") does not count.
 * `names`: the make/model names the model returned (and make nicknames).
 */
function yearShown(year: number, quote: string, text: string, names: string[]): boolean {
  if (new RegExp(`(^|\\D)${year}(\\D|$)`).test(quote)) return true;
  const yy = String(year).slice(-2);
  const t = norm(text);
  const q = norm(cleanQuote(quote));
  const keys = names.map(alnum).filter((n) => n.length >= 2);
  for (const at of quoteOffsets(q, t)) {
    for (const m of q.matchAll(new RegExp(yy, "g"))) {
      const pos = at + m.index;
      // A standalone "19" in the text: not part of 2019, 190 or x19.
      if (/[0-9a-z]/.test(t[pos - 1] ?? "") || /[0-9]/.test(t[pos + 2] ?? "")) continue;
      if (t[pos - 1] === "'") return true;
      const rest = t.slice(pos + 2);
      if (/^[ -]/.test(rest) && keys.some((k) => alnum(rest.slice(0, 40)).startsWith(k))) return true;
    }
  }
  return false;
}

/** Number spellings tried at each number start: 84,500 / 85.000 / 85 000 (thousands) / 84.5. */
const MILEAGE_NUMBERS: { re: RegExp; sep: string }[] = [
  { re: /\d{1,3}(?:,\d{3})+(?!\d)(?![.,]\d)/y, sep: "," },
  { re: /\d{1,3}(?:\.\d{3})+(?!\d)(?![.,]\d)/y, sep: "." },
  { re: /\d{1,3}(?: \d{3})+(?!\d)(?![.,]\d)/y, sep: " " },
  { re: /\d+(?:\.\d+)?(?!\d)(?![.,]\d)/y, sep: "" },
];
const THOUSANDS_WORD = /^ ?(k|thousand|mil)\b/; // "mil": Spanish/Portuguese "85 mil millas"
const KM_UNIT = /^ ?(km|kms|kilometers?|kilometres?|kil[oó]metros?)(?![a-z])/;
const MILE_UNIT = /^ ?(mi|miles?|millas?|milhas?)\b/;
const ODO_BEFORE = /\b(odometer|odo|mileage|millaje)\b[^\d]{0,20}$/;
const ODO_AFTER = /^ ?(on (the )?)?(odometer|odo)\b/;

/**
 * The quote shows this mileage: a number in the quote, at its place in the text, with mileage
 * context (a unit or thousands word after it: mi, miles, k, thousand, mil, millas; or odometer,
 * odo, mileage next to it), looked for in the quote or the text right around it. A number in
 * kilometres, or inside a token such as F-150, does not count; neither does a bare "2019".
 * Thousands may be written 84,500, 85.000 or 85 000 (a dot or space only before exactly three
 * digits and no k, so 84.5k is still 84,500).
 */
function mileageShown(miles: number, quote: string, text: string): boolean {
  const t = norm(text);
  const q = norm(cleanQuote(quote));
  for (const at of quoteOffsets(q, t)) {
    const end = at + q.length;
    for (let i = at; i < end; i++) {
      if (!/\d/.test(t[i]!)) continue;
      const p1 = t[i - 1] ?? "";
      const p2 = t[i - 2] ?? "";
      if (/[\p{L}\p{N}_]/u.test(p1)) continue; // inside a token: F150, 4x4, or not a number start
      if (p1 === "-" && /\p{L}/u.test(p2)) continue; // F-150
      if (/[.,]/.test(p1) && /\d/.test(p2)) continue; // the 5 of 84.5
      for (const { re, sep } of MILEAGE_NUMBERS) {
        re.lastIndex = i;
        const m = re.exec(t);
        if (!m || i + m[0].length > end) continue;
        let rest = t.slice(i + m[0].length);
        const thousands = THOUSANDS_WORD.exec(rest);
        if (thousands && sep !== "" && sep !== ",") continue; // 84.500k is 84.5k, not 84,500k
        if (thousands) rest = rest.slice(thousands[0].length);
        if (KM_UNIT.test(rest)) continue;
        const unit = MILE_UNIT.exec(rest);
        const afterUnit = unit ? rest.slice(unit[0].length) : rest;
        const context =
          thousands !== null || unit !== null || ODO_BEFORE.test(t.slice(Math.max(0, i - 30), i)) || ODO_AFTER.test(afterUnit);
        if (!context) continue;
        const digits = sep === "" ? m[0] : m[0].split(sep).join("");
        if (Math.round(Number(digits) * (thousands ? 1000 : 1)) === miles) return true;
      }
    }
  }
  return false;
}

/** At least one word of 3 or more letters: a quote such as "e" or "d" supports nothing. */
const hasWord = (s: string): boolean => /\p{L}{3,}/u.test(s);
const noWordProblem = (_v: unknown, q: string): string | null =>
  hasWord(q) ? null : `quote ${JSON.stringify(q)} has no word of 3 or more letters`;

/** A title-brand quote must say that brand (English, and the Spanish seen live). */
const TITLE_BRAND_WORDS: Record<Exclude<TitleBrand, "unknown">, { re: RegExp; says: string }> = {
  clean: { re: /\b(clean|limpio)\b/i, says: '"clean"' },
  rebuilt: { re: /\b(rebuilt|reconstruido)\b/i, says: '"rebuilt"' },
  salvage: { re: /\b(salvage|salvamento)\b/i, says: '"salvage"' },
  nonrepairable: {
    re: /\b(non[- ]?repairable|parts[- ]only|junk|no reparable)\b/i,
    says: '"nonrepairable", "non-repairable", "parts only" or "junk"',
  },
};

/** A lane limit's quote must name each allowed lane. */
const LANE_WORDS: Record<Option, { re: RegExp; says: string }> = {
  acv: { re: /dealer|\bacv\b/i, says: '"dealer" or "ACV"' },
  copart: { re: /salvage|copart|auction/i, says: '"salvage", "Copart" or "auction"' },
};

/** Longest make, model or trim kept; real trims such as "King Ranch SuperCrew 4x4 5.5 ft" fit. */
const MAX_NAME_CHARS = 40;
const VIN_TOKEN = /(^|[^A-Za-z0-9])[A-HJ-NPR-Z0-9]{17}([^A-Za-z0-9]|$)/i;

/**
 * Why a make/model/trim value is not a plain vehicle name, or null. These values go to the market
 * prompt, which must never see the notes, the VIN or the symptoms.
 */
export function vehicleNameProblem(value: string, symptomTexts: readonly string[]): string | null {
  const v = value.trim();
  const shown = JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v);
  if (v.length > MAX_NAME_CHARS) return `${shown} is longer than ${MAX_NAME_CHARS} characters, not a vehicle name`;
  if (!/^[\p{L}\p{N} .&/+()'-]+$/u.test(v)) return `${shown} has characters a vehicle name does not use`;
  if (VIN_TOKEN.test(v)) return `${shown} contains a VIN-shaped token`;
  const n = norm(v);
  const symptom = symptomTexts.find((s) => norm(s) !== "" && n.includes(norm(s)));
  if (symptom !== undefined) return `${shown} contains the reported symptom ${JSON.stringify(symptom)}`;
  return null;
}

/** OBD-II code shape inside free text (not part of a longer word). */
const OBD_IN_TEXT = /(?<![A-Za-z0-9])[PBCU][0-9A-F]{4}(?![A-Za-z0-9])/gi;

/**
 * A status the text states right after a code: in the clause from the code up to the next code or
 * the next , ; . or line break. "P0301 pending, P0420 pending" -> pending for each, while in
 * "P0301 and P0420 current, U0100 pending" only U0100 is pending.
 */
function statusAfterCode(code: string, text: string): { status: "pending" | "history"; word: string } | undefined {
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${code}(?![A-Za-z0-9])`, "gi"))) {
    let clause = text.slice(m.index + m[0].length);
    const stop = clause.search(/[,;.\n\r]|(?<![A-Za-z0-9])[PBCU][0-9A-F]{4}(?![A-Za-z0-9])/i);
    if (stop >= 0) clause = clause.slice(0, stop);
    const w = /\b(pending|history|past|cleared)\b/i.exec(clause);
    if (w) return { status: w[1]!.toLowerCase() === "pending" ? "pending" : "history", word: w[1]! };
  }
  return undefined;
}

const STATE_NAMES: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado",
  CT: "connecticut", DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas",
  KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts",
  MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana",
  NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico",
  NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma",
  OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota",
  TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington",
  WV: "west virginia", WI: "wisconsin", WY: "wyoming",
};
/** State codes that are also common words: only an upper-case mention counts. */
const WORDLIKE_STATES = new Set(["AL", "CO", "DE", "HI", "ID", "IN", "LA", "MA", "ME", "MO", "OH", "OK", "OR", "PA"]);

/** "TX", "tx" or "Texas" -> "TX"; anything else -> undefined. */
function stateCode(value: string): string | undefined {
  const v = value.trim();
  if (/^[A-Za-z]{2}$/.test(v) && STATE_NAMES[v.toUpperCase()]) return v.toUpperCase();
  const byName = Object.entries(STATE_NAMES).find(([, name]) => name === v.toLowerCase());
  return byName?.[0];
}

function stateShown(code: string, evidence: string): boolean {
  const name = STATE_NAMES[code]!;
  if (new RegExp(`(^|[^a-z])${name.replace(/ /g, "\\s+")}([^a-z]|$)`, "i").test(evidence)) return true;
  const flags = WORDLIKE_STATES.has(code) ? "" : "i";
  return new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`, flags).test(evidence);
}

function codeInText(code: string, text: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${code}([^A-Za-z0-9]|$)`, "i").test(text);
}

interface Verified {
  record: ParsedRecord;
  field_evidence: Record<string, string>;
  unknown_fields: string[];
  unmapped: string[];
  notes: string[];
}

/** Apply the evidence rules to the model's answer and build the engine record. */
export function verifyExtraction(x: Extraction, text: string, log: (line: string) => void): Verified {
  const evidence: Record<string, string> = {};
  const notes: string[] = [];
  const unknown: string[] = [];
  const warn = (msg: string) => {
    notes.push(msg);
    log(`parse: WARNING ${msg}`);
  };

  type Field<T> = { value?: T | null; evidence?: string | null } | null | undefined;
  /** The field's value when it is filled, its quote is in the text and `check` passes; else undefined. */
  function accept<T>(path: string, f: Field<T>, check?: (value: T, quote: string) => string | null): T | undefined {
    const v = f?.value;
    if (v === undefined || v === null || v === "unknown" || (typeof v === "string" && v.trim() === "")) {
      unknown.push(path);
      return undefined;
    }
    const quote = cleanQuote(f?.evidence ?? "");
    if (!quote || !quoteInText(quote, text)) {
      warn(`${path}: evidence ${JSON.stringify(quote)} is not in the text; ${path} reset to unknown`);
      unknown.push(path);
      return undefined;
    }
    const problem = check?.(v, quote);
    if (problem) {
      warn(`${path}: ${problem}; ${path} reset to unknown`);
      unknown.push(path);
      return undefined;
    }
    evidence[path] = quote;
    return v;
  }

  const vin = accept("vin", x.vin, (v) =>
    !/^[A-HJ-NPR-Z0-9]{17}$/i.test(v.trim())
      ? `"${v}" is not a 17-character VIN`
      : !norm(text).includes(v.trim().toLowerCase())
        ? `VIN ${v} is not written in the text`
        : null,
  )
    ?.trim()
    .toUpperCase();
  // The make/model names the model gave (and make nicknames): a 2-digit year counts right before one.
  const givenNames = [x.make?.value, x.model?.value].filter((n): n is string => typeof n === "string");
  const yearNames = [...givenNames, ...givenNames.flatMap((n) => MAKE_ALIASES[alnum(n)] ?? [])];
  const year = accept("decoded.year", x.year, (v, q) =>
    !Number.isInteger(v) || v < 1900 || v > 2100
      ? `${v} is not a model year`
      : !yearShown(v, q, text, yearNames)
        ? `year ${v} is not shown by the quote`
        : null,
  );
  // Symptom texts that will be kept (in the text, with a real word): a name must not carry one.
  const symptomTexts = (x.reported_symptoms ?? []).map((s) => cleanQuote(s.text)).filter((w) => quoteInText(w, text) && hasWord(w));
  const named = (path: string, f: Field<string>) =>
    accept(path, f, (v, q) => (nameShown(v, q) ? vehicleNameProblem(v, symptomTexts) : `"${v}" is not shown by the quote`))?.trim();
  const make = named("decoded.make", x.make);
  const model = named("decoded.model", x.model);
  const trim = named("decoded.trim", x.trim);
  const odometer = accept("odometer", x.odometer, (v, q) =>
    !Number.isInteger(v) || v < 0
      ? `${v} is not a whole number of miles`
      : !mileageShown(v, q, text)
        ? `${v} miles is not shown by the quote`
        : null,
  );
  const stateOf = (path: string, f: Field<string>) => {
    const raw = accept(path, f, (v, q) => {
      const code = stateCode(v);
      if (!code) return `"${v}" is not a US state`;
      return stateShown(code, q) ? null : `state ${code} is not shown by the quote`;
    });
    return raw === undefined ? undefined : stateCode(raw);
  };
  const location_state = stateOf("location_state", x.location_state);
  // The title brand decides a hard exclusion: the quote must say the brand, not imply it ("totaled").
  const brand = accept("title.brand", x.title_brand, (v, q) => {
    const want = TITLE_BRAND_WORDS[v as Exclude<TitleBrand, "unknown">];
    return !want || want.re.test(q) ? null : `quote ${JSON.stringify(q)} does not say ${want.says}`;
  }) as TitleBrand | undefined;
  const title_state = stateOf("title.state", x.title_state);
  const runs = accept("runs_drives", x.runs_drives, noWordProblem) as RunStatus | undefined;

  const flags = {} as Record<FlagName, FlagValue>;
  for (const f of FLAG_NAMES) flags[f] = (accept(`flags.${f}`, x.flags?.[f], noWordProblem) as FlagValue | undefined) ?? "unknown";

  // Codes: only DTCs literally in the text, each once.
  const codes: { code: string; status: CodeStatus }[] = [];
  for (const c of x.codes ?? []) {
    const code = c.code.trim().toUpperCase();
    if (!OBD_CODE_PATTERN.test(code)) {
      warn(`code "${c.code}" is not an OBD-II code; dropped`);
      continue;
    }
    if (!codeInText(code, text)) {
      warn(`code ${code} is not in the text; dropped`);
      continue;
    }
    if (codes.some((k) => k.code === code)) continue;
    const path = `codes[${codes.length}]`;
    const quote = cleanQuote(c.evidence ?? "");
    const quoteOk = quote !== "" && quoteInText(quote, text);
    if (!quoteOk) warn(`${path} ${code}: evidence ${JSON.stringify(quote)} is not in the text; the code is, so it is kept with the code as its evidence`);
    // Only confirmed codes count as severe, so a "confirmed" the text contradicts is downgraded.
    let status: CodeStatus = c.status;
    const stated = status === "confirmed" ? statusAfterCode(code, text) : undefined;
    if (stated) {
      warn(`${path} ${code}: the text says "${stated.word}" right after the code; status set to ${stated.status}, not confirmed`);
      status = stated.status;
    }
    evidence[path] = quoteOk ? quote : code;
    codes.push({ code, status });
  }
  const missed: string[] = [];
  for (const m of text.matchAll(OBD_IN_TEXT)) {
    const code = m[0].toUpperCase();
    if (!codes.some((k) => k.code === code) && !missed.includes(code)) {
      missed.push(code);
      warn(`code ${code} is in the text but was not extracted; left out`);
    }
  }
  // An empty scan ("scanned, no codes") is codes: [] with its evidence under "codes". Not when
  // the text has a code that was not kept: then the codes are unknown, not "none found".
  let scanDone = false;
  if (codes.length === 0) {
    if (x.scan_done?.value === true && missed.length > 0) {
      warn(`codes: the text mentions a scan and ${missed.join(", ")}, but no code was kept; codes left unknown, not "scan found no codes"`);
      unknown.push("codes");
    } else if (x.scan_done?.value === true) scanDone = accept("codes", x.scan_done, noWordProblem) === true;
    else unknown.push("codes");
  }

  // A lane limit decides a hard exclusion: the quote must name each allowed lane.
  const lanes = accept("seller.lanes_allowed", x.lanes_allowed, (v, q) => {
    if (v.length === 0) return "an empty lane list would exclude both options";
    const unnamed = OPTIONS.filter((o) => v.includes(o) && !LANE_WORDS[o].re.test(q));
    return unnamed.length === 0
      ? null
      : `quote ${JSON.stringify(q)} does not name the ${unnamed.join(", ")} lane (${unnamed.map((o) => LANE_WORDS[o].says).join("; ")})`;
  });
  const lanesAllowed = lanes ? OPTIONS.filter((o): o is Option => lanes.includes(o)) : undefined;

  // Symptoms: the user's words, which must be in the text.
  const symptoms: ReportedSymptom[] = [];
  for (const s of x.reported_symptoms ?? []) {
    const words = cleanQuote(s.text);
    if (!quoteInText(words, text)) {
      warn(`reported symptom ${JSON.stringify(words)} is not in the text; dropped`);
      continue;
    }
    if (!hasWord(words)) {
      warn(`reported symptom ${JSON.stringify(words)} has no word of 3 or more letters; dropped`);
      continue;
    }
    // "does not start" as both the run status and an engine symptom would count the same words
    // twice in drivable (row "no" plus the severe modifier). Exact match only: "engine seized" stays.
    if ((runs === "no" || runs === "engine_starts") && evidence.runs_drives !== undefined && norm(words) === norm(evidence.runs_drives)) {
      warn(`reported symptom ${JSON.stringify(words)} only restates the run status (${runs}); dropped`);
      continue;
    }
    if (symptoms.some((k) => norm(k.text) === norm(words))) continue;
    const system = (SYMPTOM_SYSTEMS as readonly string[]).includes(s.system) ? (s.system as SymptomSystem) : "other";
    evidence[`reported_symptoms[${symptoms.length}]`] = words;
    symptoms.push({ system, text: words });
  }

  const unmapped = [...new Set((x.unmapped ?? []).map((u) => u.trim().slice(0, 200)).filter(Boolean))].slice(0, MAX_UNMAPPED);

  const record: ParsedRecord = {
    vin: vin ?? null,
    decoded: { year: year ?? null, make: make ?? null, model: model ?? null, trim: trim ?? null },
    odometer: odometer ?? null,
    location_state: location_state ?? null,
    title: { brand: brand ?? "unknown", state: title_state ?? null },
    runs_drives: runs ?? "unknown",
    flags,
    // null = no word about a scan (the engine reads it as "no scan"); [] = scanned, no codes.
    codes: codes.length > 0 || scanDone ? codes : null,
    seller: { lanes_allowed: lanesAllowed ?? null },
    reported_symptoms: symptoms,
  };
  // No lane limit is the default (both lanes), not an unknown.
  const unknown_fields = unknown.filter((p) => p !== "seller.lanes_allowed");
  return { record, field_evidence: evidence, unknown_fields, unmapped, notes };
}

// ---------------------------------------------------------------------------
// Market-fit call
// ---------------------------------------------------------------------------

/** Exactly what the market call may see. Nothing else from the record or the text is sent. */
export interface MarketProfile {
  year: number;
  make: string;
  model: string;
  trim: string | null;
  odometer: number | null;
  location_state: string | null;
  title_brand: TitleBrand;
  run_status: RunStatus;
}

const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  run_and_drive: "runs and drives",
  engine_starts: "engine starts but does not drive",
  no: "does not run",
  unknown: "unknown",
};

/**
 * The market profile, or null when year, make or model is unknown. A make/model/trim that is not
 * a plain vehicle name (vehicleNameProblem) is not sent; verifyExtraction already resets those,
 * so this is a second guard on what the market prompt can see.
 */
export function marketProfile(record: ParsedRecord): MarketProfile | null {
  const d = record.decoded ?? {};
  const symptomTexts = record.reported_symptoms.map((s) => s.text);
  const plain = (s: string | null | undefined): s is string => !!s && vehicleNameProblem(s, symptomTexts) === null;
  if (d.year == null || !plain(d.make) || !plain(d.model)) return null;
  return {
    year: d.year,
    make: d.make,
    model: d.model,
    trim: plain(d.trim) ? d.trim : null,
    odometer: record.odometer ?? null,
    location_state: record.location_state ?? null,
    title_brand: record.title?.brand ?? "unknown",
    run_status: record.runs_drives ?? "unknown",
  };
}

/** Fill prompts/parse_market.md from a market profile (the only data it can reach). */
export function buildParseMarketPrompt(p: MarketProfile, template: string = loadPrompt(MARKET_PROMPT_PATH)): string {
  const values: Record<string, string> = {
    year: String(p.year),
    make: p.make,
    model: p.model,
    trim: p.trim ?? "unknown",
    odometer: p.odometer === null ? "unknown" : `${p.odometer.toLocaleString("en-US")} miles`,
    location_state: p.location_state ?? "unknown",
    title_brand: p.title_brand,
    run_status: RUN_STATUS_TEXT[p.run_status],
  };
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new ConfigError(`${MARKET_PROMPT_PATH}: unknown placeholder ${m}`);
    return v;
  });
}

/**
 * The model's reply: the engine's own acv/copart/confidence/insufficient rules (MarketFitBlockSchema),
 * so out-of-range scores fail validation (retry, then omit). Not strict, and signals are lenient
 * here: a signal without a claim or an http(s) URL is dropped by cleanSignals, not an error.
 */
const MarketReportSchema = z.object({
  ...MarketFitBlockSchema.pick({ acv: true, copart: true, confidence: true, insufficient: true }).shape,
  signals: z.array(z.object({ claim: z.string(), url: z.string().nullish() })).default([]),
});
type MarketReport = z.infer<typeof MarketReportSchema>;

/** The JSON object in a reply: a fenced ```json block, else the outermost {...}. */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    if (!c || !c.trim().startsWith("{")) continue;
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  throw new Error("no JSON object in the reply");
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** A signal URL matches a grounding chunk by URL, or by domain == the chunk's title/domain. */
function matchesChunk(url: string, chunks: GroundingChunkWeb[]): boolean {
  const host = hostOf(url);
  return chunks.some((c) => {
    if (c.uri && c.uri === url) return true;
    const names = [c.title, c.domain].filter((n): n is string => !!n).map((n) => n.toLowerCase().replace(/^www\./, ""));
    return host !== "" && names.some((n) => host === n || host.endsWith(`.${n}`));
  });
}

/** Keep signals with a claim and an http(s) URL; grounded ones first; at most 5. */
function cleanSignals(raw: MarketReport["signals"], chunks: GroundingChunkWeb[], warn: (m: string) => void) {
  const kept = raw
    .map((s) => ({ claim: s.claim.trim(), url: (s.url ?? "").trim() }))
    .filter((s) => s.claim !== "" && isHttpUrl(s.url));
  if (kept.length < raw.length) warn(`market fit: dropped ${raw.length - kept.length} signal(s) without a claim or an http(s) URL`);
  const grounded = kept.filter((s) => matchesChunk(s.url, chunks));
  const other = kept.filter((s) => !matchesChunk(s.url, chunks));
  return [...grounded, ...other].slice(0, MAX_SIGNALS);
}

type MarketOutcome = { kind: "ok"; block: ProvidedMarketFit } | { kind: "invalid"; problem: string };

/** API errors on the market call that fail the parse (exit 1) instead of omitting market_fit. */
const FATAL_MARKET_STATUS = new Set([401, 402, 403, 404]);

/**
 * The market call. `block` on success; `problem` when market_fit is left out with a note
 * (invalid output twice, no grounding, 429, 5xx, network); `fatal` for a 401/402/403/404.
 */
async function runMarket(
  ctx: CallContext,
  model: string,
  profile: MarketProfile,
  now: Date,
  queries: string[],
  warn: (m: string) => void,
): Promise<{ block?: ProvidedMarketFit; problem?: string; fatal?: string }> {
  const prompt = buildParseMarketPrompt(profile);
  let problem = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = attempt === 1 ? prompt : `${prompt}\n\nYour previous reply could not be used (${problem}). Reply with only the JSON object described above.`;
    const params: GenerateContentParameters = {
      model,
      contents: [{ role: "user", parts: [{ text }] }],
      config: {
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        automaticContinuation: false, // one HTTP request per call (see runExtraction)
      },
    };
    let res: GeminiResponse;
    try {
      res = await callGemini(ctx, attempt === 1 ? "market" : "market retry", params);
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e;
      // Key, credits, permission or model problems: the user must act (PARSER.md: exit 1).
      if (e.status !== undefined && FATAL_MARKET_STATUS.has(e.status)) return { fatal: e.message };
      if (e.status === 429) {
        return {
          problem:
            `${e.message}; the market call uses Google Search grounding, which may have its own quota ` +
            "on the key (--no-market skips this call)",
        };
      }
      return { problem: e.message };
    }
    const outcome = readMarketReply(res, model, now, queries, warn);
    if (outcome.kind === "ok") return { block: outcome.block };
    problem = outcome.problem;
    ctx.log(`parse: market attempt ${attempt}: ${problem}${attempt < MAX_ATTEMPTS ? "; retrying once" : ""}`);
  }
  return { problem: `invalid model output twice (${problem})` };
}

function readMarketReply(
  res: GeminiResponse,
  model: string,
  now: Date,
  queries: string[],
  warn: (m: string) => void,
): MarketOutcome {
  const grounding = res.candidates?.[0]?.groundingMetadata;
  for (const q of grounding?.webSearchQueries ?? []) if (!queries.includes(q)) queries.push(q);
  const chunks = (grounding?.groundingChunks ?? []).map((c) => c.web).filter((w): w is GroundingChunkWeb => !!w);
  if ((grounding?.webSearchQueries?.length ?? 0) === 0 && chunks.length === 0) {
    return { kind: "invalid", problem: "no Google Search grounding in the reply" };
  }
  let json: unknown;
  try {
    json = extractJsonObject(responseText(res));
  } catch (e) {
    return { kind: "invalid", problem: (e as Error).message };
  }
  const parsed = MarketReportSchema.safeParse(json);
  if (!parsed.success) return { kind: "invalid", problem: `invalid market JSON: ${issuesText(parsed.error)}` };
  const r = parsed.data;
  const block: ProvidedMarketFit = {
    acv: r.acv,
    copart: r.copart,
    confidence: r.confidence,
    signals: cleanSignals(r.signals, chunks, warn),
    insufficient: r.insufficient,
    provider: `${model} + Google Search`,
    generated_at: now.toISOString(),
  };
  // The engine's own input check, so the printed JSON is always accepted by `decide`.
  const engineCheck = MarketFitBlockSchema.safeParse(block);
  if (!engineCheck.success) return { kind: "invalid", problem: `market block rejected: ${issuesText(engineCheck.error)}` };
  return { kind: "ok", block };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Parse free text into engine input. Throws ParseError (one-line message) on: empty or too long
 * text, a missing GOOGLE_API_KEY (before any client is built), Gemini API errors on the
 * extraction call (after one retry for transient ones), invalid extraction output twice, and a
 * 401/402/403/404 on the market call (that error carries the record as `partial`). Other
 * market-call problems (invalid output twice, no grounding, 429, 5xx, network) do not throw:
 * market_fit is left out and parser.notes says why.
 */
export async function parseFreeText(text: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const input = text.replace(/^﻿/, "").trim();
  if (input === "") throw new ParseError('parse needs some text: pnpm -s engine parse "<text>" or --file notes.txt');
  if (input.length > MAX_TEXT_CHARS) {
    throw new ParseError(`the text is ${input.length} characters; the parser takes at most ${MAX_TEXT_CHARS}`);
  }
  const env = opts.env ?? process.env;
  const apiKey = resolveGeminiKey(env);
  if (!apiKey) {
    throw new ParseError(
      "GOOGLE_API_KEY is not set: add GOOGLE_API_KEY=... to .env at the repo root or in packages/engine (GEMINI_API_KEY also works)",
    );
  }
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const model = opts.model ?? (env.PARSER_MODEL || DEFAULT_PARSER_MODEL);
  const marketModel = opts.marketModel ?? (env.PARSER_MARKET_MODEL || model);
  const ctx: CallContext = {
    client: opts.client ?? (opts.createClient ?? createGeminiClient)(apiKey, env),
    log,
    usage: [],
    timeoutMs: parserTimeoutMs(env, log),
    apiKey,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  };

  const extraction = await runExtraction(ctx, model, input);
  const v = verifyExtraction(extraction, input, log);
  // The engine's own input check (before the paid market call), so the printed JSON is always
  // accepted by `decide`. It can only fail on a bug in verifyExtraction.
  const recordCheck = ConditionRecordSchema.safeParse(v.record);
  if (!recordCheck.success) {
    throw new ParseError(`parser built a record the engine rejects (a parser bug): ${issuesText(recordCheck.error)}`);
  }
  const parser: ParserMeta = {
    model,
    market_model: null,
    input_text: input,
    field_evidence: v.field_evidence,
    unknown_fields: v.unknown_fields,
    unmapped: v.unmapped,
    notes: v.notes,
    search_queries: [],
    usage: ctx.usage,
  };
  const result: ParseResult = { record: v.record, parser };

  const profile = marketProfile(v.record);
  if (opts.market === false) {
    parser.notes.push("market fit skipped (--no-market)");
  } else if (!profile) {
    const missing = (["year", "make", "model"] as const).filter((k) => v.record.decoded?.[k] == null);
    parser.notes.push(`market fit skipped: it needs year, make and model, and the text does not give ${missing.join(", ")}`);
  } else {
    parser.market_model = marketModel;
    const warn = (msg: string) => {
      parser.notes.push(msg);
      log(`parse: WARNING ${msg}`);
    };
    const { block, problem, fatal } = await runMarket(ctx, marketModel, profile, opts.now ?? new Date(), parser.search_queries, warn);
    if (block) result.market_fit = block;
    else if (fatal) {
      parser.notes.push(`market fit omitted: ${fatal}`);
      throw new ParseError(`market call failed: ${fatal}`, result);
    } else warn(`market fit omitted: ${problem}`);
  }
  return result;
}

/** The one JSON object the CLI prints: the record, then market_fit (if any), then parser. */
export function toEngineInput(result: ParseResult): Record<string, unknown> {
  return {
    ...result.record,
    ...(result.market_fit ? { market_fit: result.market_fit } : {}),
    parser: result.parser,
  };
}

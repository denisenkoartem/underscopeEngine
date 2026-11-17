// The model reader: a seller's description -> the assessment JSON (contract.ts), read by the fine-tuned
// model behind PARSER_BASE_URL (reader/model/serve.py locally, vLLM in production). One model call, then
// checks in code: a value is kept only when the quote the model gives for it is in the text and shows
// the value. What fails a check goes back to unknown and is listed in `issues`.
//
// The model answers in its own compact shape (ANSWER below): every field is { value, evidence }. The
// checks turn that into the same Assessment the rules reader returns.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { z } from "zod";
import { createCompatClient } from "./chatAdapter.js";
import {
  CODE_STATUSES, ENUMS, FLAGS, GRADES, LANES, PARTS, SYMPTOM_SYSTEMS, TRI_FIELDS, WARNING_LIGHTS,
  emptyAssessment, listMissing,
  type Assessment, type CodeStatus, type EnumField, type FlagName, type GradeName, type Lane, type Part, type SymptomSystem, type WarningLight,
} from "./contract.js";
import { ParserApiError, callModel, parserTimeoutMs, refusalText, responseText, statusText, type CallContext, type ParserClient, type ParserUsage } from "./modelClient.js";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROMPT_PATH = join(PACKAGE_ROOT, "prompts", "read.md");
export const DEFAULT_MODEL = "underscope-reader";
export const MAX_TEXT_CHARS = 20_000;
const MAX_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 4_000;
const MAX_ADDITIONAL = 20;

/** Every failure the caller must act on (no server, bad answers twice, empty text). */
export class ReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadError";
  }
}

// ---------------------------------------------------------------------------
// The answer shape
// ---------------------------------------------------------------------------

type Kind =
  | { t: "vin" } | { t: "year" } | { t: "miles" } | { t: "days" } | { t: "name" } | { t: "state" } | { t: "zip" }
  | { t: "enum"; values: readonly string[] } | { t: "tri" } | { t: "usd" } | { t: "usd_list" } | { t: "lanes" };

interface FieldSpec {
  /** Key in the model's answer. */
  key: string;
  /** Path in the Assessment (and its evidence map). */
  path: string;
  kind: Kind;
  says: string;
  /** Words the quote must contain, as a light guard against a quote from the wrong sentence. */
  topic?: RegExp;
}

const en = (f: EnumField): Kind => ({ t: "enum", values: ENUMS[f] });

/** The single-value fields, in the order the model writes them. */
export const FIELDS: readonly FieldSpec[] = [
  { key: "vin", path: "vin", kind: { t: "vin" }, says: "17-character VIN, only if written out in full." },
  { key: "year", path: "vehicle.year", kind: { t: "year" }, says: "Model year as written." },
  { key: "make", path: "vehicle.make", kind: { t: "name" }, says: "Make as written (Chevy may be expanded to Chevrolet)." },
  { key: "model", path: "vehicle.model", kind: { t: "name" }, says: "Model as written." },
  { key: "trim", path: "vehicle.trim", kind: { t: "name" }, says: "Trim as written." },
  { key: "drivetrain", path: "drivetrain", kind: en("drivetrain"), says: "fwd, rwd, awd or 4wd (4x4), only when stated." },
  { key: "fuel_type", path: "fuel_type", kind: en("fuel_type"), says: "gas, diesel, hybrid or electric, only when stated." },
  { key: "title_status", path: "title_status", kind: en("title_status"), says: "Title brand, only when stated.", topic: /title|ttl|brand|certificate|salvage|rebuilt|junk|parts only|lemon|buy ?back|flood|t[ií]tulo/i },
  { key: "title_state", path: "title_state", kind: { t: "state" }, says: "2-letter US state that issued the title." },
  { key: "title_in_hand", path: "title_in_hand", kind: { t: "tri" }, says: "yes when the seller holds the title, no when it is absent, at the bank or pending.", topic: /title|ttl|t[ií]tulo/i },
  { key: "lien", path: "lien", kind: en("lien"), says: "none when the notes say there is no lien or it is paid off, open when money is still owed.", topic: /lien|owe|loan|paid off|free and clear|payoff|financ|bank/i },
  { key: "mileage", path: "mileage", kind: { t: "miles" }, says: "Odometer in whole miles." },
  { key: "odometer_status", path: "odometer_status", kind: en("odometer_status"), says: "actual, not_actual (TMU, replaced cluster, rollback) or exempt.", topic: /mile|odo|tmu|exempt|actual|cluster|millas/i },
  { key: "region", path: "region", kind: { t: "state" }, says: "2-letter US state where the vehicle is." },
  { key: "zip", path: "zip", kind: { t: "zip" }, says: "5-digit ZIP code where the vehicle is." },
  { key: "seller_type", path: "seller_type", kind: en("seller_type"), says: "Who is selling, only when the notes say so: dealer, insurer, fleet, lender (repo) or individual." },
  { key: "lanes_allowed", path: "lanes_allowed", kind: { t: "lanes" }, says: "Only when the seller limits where it may be sold." },
  { key: "run_status", path: "run_status", kind: en("run_status"), says: "runs_and_drives, starts (but does not drive) or does_not_start.", topic: /run|driv|drove|start|crank|tow|mov|dead|idle|r&d|corre|maneja|prende|camina|arranca|anda/i },
  { key: "keys", path: "keys", kind: { t: "tri" }, says: "yes when keys come with it, no when there are none.", topic: /key|fob|llave/i },
  { key: "engine_condition", path: "engine_condition", kind: en("engine_condition"), says: "ok, minor (a fault it still runs with) or failed (seized, blown, needs an engine)." },
  { key: "transmission_condition", path: "transmission_condition", kind: en("transmission_condition"), says: "ok, minor (slips, whines, shifts hard) or failed (no gears, needs a transmission)." },
  { key: "primary_damage", path: "primary_damage", kind: en("primary_damage"), says: "The first damage area or cause the notes name." },
  { key: "secondary_damage", path: "secondary_damage", kind: en("secondary_damage"), says: "The second damage area or cause, if one is named." },
  { key: "catalytic_converter", path: "catalytic_converter", kind: en("catalytic_converter"), says: "present or missing (stolen, cut off).", topic: /cat|converter/i },
  { key: "parts_missing", path: "parts_missing", kind: { t: "tri" }, says: "yes when parts were removed or it is stripped, no when the notes say it is complete." },
  { key: "already_repaired", path: "already_repaired", kind: en("already_repaired"), says: "yes, partly or no: whether the damage has been repaired." },
  { key: "clean_wholesale", path: "values.clean_wholesale", kind: { t: "usd" }, says: "Clean wholesale value in US dollars." },
  { key: "salvage_comps", path: "values.salvage_comps", kind: { t: "usd_list" }, says: "Sold prices of similar damaged vehicles, every one listed." },
  { key: "purchase_price", path: "values.purchase_price", kind: { t: "usd" }, says: "What the seller paid." },
  { key: "repair_estimate", path: "values.repair_estimate", kind: { t: "usd" }, says: "A repair quote or estimate." },
  { key: "reserve_price", path: "values.reserve_price", kind: { t: "usd" }, says: "The asking price or the lowest price the seller accepts." },
  { key: "storage_cost_per_day", path: "storage_cost_per_day", kind: { t: "usd" }, says: "Storage fee per day." },
  { key: "sell_by_days", path: "sell_by_days", kind: { t: "days" }, says: "Days the seller has to sell it." },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);
/** Top-level keys of an answer, in order. */
export const ANSWER_KEYS = [...FIELD_KEYS.slice(0, FIELD_KEYS.indexOf("catalytic_converter")), "grades", "rest_fine", "flags", ...FIELD_KEYS.slice(FIELD_KEYS.indexOf("catalytic_converter"), FIELD_KEYS.indexOf("clean_wholesale")), "warning_lights", "codes", "symptoms", ...FIELD_KEYS.slice(FIELD_KEYS.indexOf("clean_wholesale")), "unmapped"] as const;

const fieldOf = <T extends z.ZodType>(value: T) => z.object({ value: value.nullish(), evidence: z.string().nullish() }).nullish();
const zodOf = (k: Kind) =>
  k.t === "year" || k.t === "miles" || k.t === "days" || k.t === "usd" ? z.number()
  : k.t === "usd_list" ? z.array(z.number())
  : k.t === "lanes" ? z.array(z.string())
  : z.string();

/** Lenient: any key may be absent or null (a sparse answer lists only what the text mentions). */
export const AnswerSchema = z.object({
  ...(Object.fromEntries(FIELDS.map((f) => [f.key, fieldOf(zodOf(f.kind))])) as Record<string, ReturnType<typeof fieldOf>>),
  flags: z.record(z.string(), fieldOf(z.string())).nullish(),
  grades: z.array(z.object({ part: z.string(), grade: z.string(), evidence: z.string().nullish() })).nullish(),
  rest_fine: fieldOf(z.string()),
  warning_lights: z.array(z.object({ light: z.string(), evidence: z.string().nullish() })).nullish(),
  codes: z.array(z.object({ code: z.string(), status: z.string().nullish(), evidence: z.string().nullish() })).nullish(),
  symptoms: z.array(z.object({ system: z.string(), text: z.string() })).nullish(),
  unmapped: z.array(z.string()).nullish(),
});
type AnswerField = { value?: unknown; evidence?: string | null } | null | undefined;
export type Answer = Record<string, unknown> & {
  flags?: Record<string, AnswerField> | null;
  grades?: { part: string; grade: string; evidence?: string | null }[] | null;
  rest_fine?: AnswerField;
  warning_lights?: { light: string; evidence?: string | null }[] | null;
  codes?: { code: string; status?: string | null; evidence?: string | null }[] | null;
  symptoms?: { system: string; text: string }[] | null;
  unmapped?: string[] | null;
};

const NONE = { value: null, evidence: null };
const isEmpty = (v: unknown): boolean =>
  v == null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && "value" in (v as object) && (v as AnswerField)!.value == null);

/** Every key present, nulls and empty lists included, in ANSWER_KEYS order (the strict-schema shape). */
export function fullAnswer(a: Answer): Answer {
  const out: Answer = {};
  for (const k of ANSWER_KEYS) {
    if (k === "flags") out.flags = Object.fromEntries(FLAGS.map((n) => [n, isEmpty(a.flags?.[n]) ? NONE : a.flags![n]]));
    else if (k === "grades" || k === "warning_lights" || k === "codes" || k === "symptoms" || k === "unmapped") (out as Record<string, unknown>)[k] = (a[k] as unknown[] | null | undefined) ?? [];
    else out[k] = isEmpty(a[k]) ? NONE : a[k];
  }
  return out;
}

/** Only what the answer fills: null fields and empty lists dropped (the sparse training target). */
export function sparseAnswer(a: Answer): Answer {
  const out: Answer = {};
  for (const k of ANSWER_KEYS) {
    if (k === "flags") {
      const flags = Object.fromEntries(FLAGS.filter((n) => !isEmpty(a.flags?.[n])).map((n) => [n, a.flags![n]]));
      if (Object.keys(flags).length > 0) out.flags = flags;
    } else if (!isEmpty(a[k])) out[k] = a[k];
  }
  return out;
}

// ---- JSON schema for servers that constrain or check the output ----
const strictObject = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const evidenceProp = { type: ["string", "null"], description: "Exact quote from the notes that supports the value; null when the value is null." };
const valueSchema = (k: Kind): Record<string, unknown> =>
  k.t === "enum" ? { type: ["string", "null"], enum: [...k.values, null] }
  : k.t === "tri" ? { type: ["string", "null"], enum: ["yes", "no", null] }
  : k.t === "year" || k.t === "miles" || k.t === "days" ? { type: ["integer", "null"] }
  : k.t === "usd" ? { type: ["number", "null"] }
  : k.t === "usd_list" ? { type: ["array", "null"], items: { type: "number" } }
  : k.t === "lanes" ? { type: ["array", "null"], items: { type: "string", enum: [...LANES] } }
  : { type: ["string", "null"] };
const fieldSchema = (value: Record<string, unknown>, description: string) => ({ ...strictObject({ value, evidence: evidenceProp }), description });

/** `sparse`: nothing is required, so an answer may list only the fields the notes mention. */
export function answerJsonSchema(sparse = false): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const k of ANSWER_KEYS) {
    const f = FIELDS.find((x) => x.key === k);
    if (f) props[k] = fieldSchema(valueSchema(f.kind), f.says);
    else if (k === "flags") props[k] = strictObject(Object.fromEntries(FLAGS.map((n) => [n, fieldSchema({ type: ["string", "null"], enum: ["yes", "no", null] }, n)])), sparse ? [] : [...FLAGS]);
    else if (k === "grades") props[k] = { type: "array", description: "Each part the notes mention.", items: strictObject({ part: { type: "string", enum: [...PARTS] }, grade: { type: "string", enum: [...GRADES] }, evidence: { type: "string" } }) };
    else if (k === "rest_fine") props[k] = fieldSchema({ type: ["string", "null"], enum: ["yes", null] }, "yes when the notes say everything else is undamaged.");
    else if (k === "warning_lights") props[k] = { type: "array", items: strictObject({ light: { type: "string", enum: [...WARNING_LIGHTS] }, evidence: { type: "string" } }) };
    else if (k === "codes") props[k] = { type: "array", items: strictObject({ code: { type: "string" }, status: { type: "string", enum: [...CODE_STATUSES] }, evidence: { type: "string" } }) };
    else if (k === "symptoms") props[k] = { type: "array", items: strictObject({ system: { type: "string", enum: [...SYMPTOM_SYSTEMS] }, text: { type: "string" } }) };
    else props[k] = { type: "array", items: { type: "string" } };
  }
  return strictObject(props, sparse ? [] : [...ANSWER_KEYS]);
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export function loadPrompt(path = PROMPT_PATH): string {
  return readFileSync(path, "utf8").replace(/^﻿/, "").replace(/^\s*<!--[\s\S]*?-->\s*/, "");
}

/** The request for these notes: the prompt as instructions, the notes between <notes> tags, the answer schema. */
export function buildRequest(model: string, text: string, opts: { sparse?: boolean; prompt?: string } = {}): ResponseCreateParamsNonStreaming {
  return {
    model,
    instructions: opts.prompt ?? loadPrompt(),
    input: `<notes>\n${text}\n</notes>`,
    text: { format: { type: "json_schema", name: "assessment", strict: !opts.sparse, schema: answerJsonSchema(opts.sparse) } },
    temperature: 0,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  };
}

const stripFence = (s: string): string => /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s.trim())?.[1] ?? s;

const MEMBER_RE = new RegExp(`"(${ANSWER_KEYS.join("|")})"\\s*:`, "g");

/**
 * The members of a reply that is not valid JSON as a whole, each parsed on its own. A small model
 * sometimes writes one member in a broken shape (`"primary_damage":{"rear","side"}`, a list left
 * open); the others are still good. Returns what parsed and the keys that did not.
 */
export function salvageMembers(text: string): { json: Record<string, unknown>; dropped: string[] } {
  const json: Record<string, unknown> = {};
  const dropped: string[] = [];
  const marks = [...text.matchAll(MEMBER_RE)];
  marks.forEach((m, i) => {
    const key = m[1]!;
    const seg = text.slice(m.index! + m[0].length, marks[i + 1]?.index ?? text.length).trim().replace(/,+$/, "").trim();
    if (key in json) return; // the first good one wins
    for (const candidate of [seg, seg.replace(/\}$/, "").replace(/,+\s*$/, ""), `${seg}]`, `${seg}}`]) {
      try {
        json[key] = JSON.parse(candidate);
        return;
      } catch { /* try the next form */ }
    }
    if (!dropped.includes(key)) dropped.push(key);
  });
  return { json, dropped: dropped.filter((k) => !(k in json)) };
}

/**
 * The answer in a reply, or why there is none (refused, cut off, empty, nothing usable). A member
 * that is broken or has the wrong shape is left out and named in `dropped`; the rest is kept.
 */
export function readReply(res: Response): { answer: Answer; dropped: string[]; problem?: undefined } | { answer?: undefined; dropped?: undefined; problem: string } {
  const refusal = refusalText(res);
  if (refusal !== undefined) return { problem: `model refused (${refusal.replace(/\s+/g, " ").trim().slice(0, 200)})` };
  if (res.status !== undefined && res.status !== "completed") return { problem: `response ${statusText(res)}` };
  const text = responseText(res).trim();
  if (text === "") return { problem: "empty reply" };
  let json: unknown;
  let dropped: string[] = [];
  try {
    json = JSON.parse(stripFence(text));
  } catch {
    ({ json, dropped } = salvageMembers(stripFence(text)));
    if (Object.keys(json as object).length === 0) return { problem: "reply is not valid JSON" };
  }
  const parsed = AnswerSchema.safeParse(json);
  if (parsed.success) return { answer: parsed.data as Answer, dropped };
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { problem: "reply is not an answer: not an object" };
  // Wrong shape somewhere: keep the members that fit, one by one.
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json)) {
    if (AnswerSchema.safeParse({ [k]: v }).success) kept[k] = v;
    else dropped.push(k);
  }
  const again = AnswerSchema.safeParse(kept);
  if (!again.success || Object.keys(kept).length === 0) return { problem: `reply is not an answer: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
  return { answer: again.data as Answer, dropped };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Case-, whitespace- and quote-style-insensitive form used for substring checks. */
const norm = (s: string): string =>
  s.normalize("NFKC").replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const alnum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const cleanQuote = (q: string): string => {
  const t = q.trim();
  const m = /^(["'“‘])([\s\S]*)(["'”’])$/.exec(t);
  return (m ? m[2]! : t).trim();
};
export function quoteInText(quote: string, text: string): boolean {
  const q = norm(cleanQuote(quote));
  return q.length > 0 && norm(text).includes(q);
}
const hasWord = (s: string): boolean => /\p{L}{2,}/u.test(s);

const MAKE_ALIASES: Record<string, string[]> = { chevrolet: ["chevy"], volkswagen: ["vw"], mercedesbenz: ["mercedes", "benz"], cadillac: ["caddy"] };
function nameShown(value: string, quote: string): boolean {
  const v = alnum(value), q = alnum(quote);
  return v.length > 0 && (q.includes(v) || (MAKE_ALIASES[v] ?? []).some((a) => q.includes(a)));
}

/** Numbers as written: 4,600 / 4600 / $1,150.50 / 7k / 85 thousand / 85 mil (Spanish). */
function numbersIn(q: string): number[] {
  const out: number[] = [];
  for (const m of norm(q).matchAll(/(?<![\p{L}\p{N}.,])\$? ?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?( ?(?:k|thousand|mil)\b)?(?![\p{N}]|[.,]\d)/gu)) {
    const raw = Number(m[1]!.replace(/,/g, "") + (m[2] ?? ""));
    out.push(Math.round(raw * (m[3] ? 1000 : 1) * 100) / 100);
  }
  return out;
}

const STATE_NAMES: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts",
  MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico",
  NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota",
  TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming",
};
/** State codes that are also common words: only an upper-case mention counts. */
const WORDLIKE_STATES = new Set(["AL", "CO", "DE", "HI", "ID", "IN", "LA", "MA", "ME", "MO", "OH", "OK", "OR", "PA"]);
function stateCode(value: string): string | undefined {
  const v = value.trim();
  if (/^[A-Za-z]{2}$/.test(v) && STATE_NAMES[v.toUpperCase()]) return v.toUpperCase();
  return Object.entries(STATE_NAMES).find(([, name]) => name === v.toLowerCase())?.[0];
}
function stateShown(code: string, quote: string): boolean {
  if (new RegExp(`(^|[^a-z])${STATE_NAMES[code]!.replace(/ /g, "\\s+")}([^a-z]|$)`, "i").test(quote)) return true;
  return new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`, WORDLIKE_STATES.has(code) ? "" : "i").test(quote);
}

/** A "Role: ..." line means nothing for the record (user decision, 2026-11-07): the model never sees it. */
const ROLE_START = /(?:^|\|)[^\S\n]*(?:(?:[-*•]|\d+[.)])[^\S\n]*)?role[^\S\n]*:/i;
export function stripRoleLines(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ROLE_START.exec(line);
    if (!m) {
      kept.push(line);
      continue;
    }
    removed.push(line.slice(m.index).replace(/^\|/, "").trim());
    const before = line.slice(0, m.index).trimEnd();
    if (before.trim() !== "") kept.push(before);
  }
  return removed.length === 0 ? { text, removed } : { text: kept.join("\n").trim(), removed };
}

const OBD_IN_TEXT = /(?<![A-Za-z0-9])[PBCU][0-9A-F]{4}(?![A-Za-z0-9])/gi;
/** A status the text states right after a code, up to the next code or , ; . or line break. */
function statusAfterCode(code: string, text: string): "pending" | "history" | undefined {
  for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${code}(?![A-Za-z0-9])`, "gi"))) {
    let clause = text.slice(m.index + m[0].length);
    const stop = clause.search(/[,;.\n\r]|(?<![A-Za-z0-9])[PBCU][0-9A-F]{4}(?![A-Za-z0-9])/i);
    if (stop >= 0) clause = clause.slice(0, stop);
    const w = /\b(pending|history|past|cleared)\b/i.exec(clause);
    if (w) return w[1]!.toLowerCase() === "pending" ? "pending" : "history";
  }
  return undefined;
}

/**
 * What the checks did to one answer:
 * - quote_not_in_text: the evidence quote is not in the notes (the field is reset)
 * - value_not_shown: the quote is there but does not show the value (reset, or one comp dropped)
 * - invented_dropped: a code, part, light or symptom that is not in the notes or not a valid value (dropped)
 * - downgraded: a "confirmed" code the notes call pending or history
 * - missed: a code in the notes that the answer left out
 * The first three are unsupported answers: the invented-value rate counts them.
 */
export type IssueKind = "quote_not_in_text" | "value_not_shown" | "invented_dropped" | "downgraded" | "missed" | "malformed_dropped";
export const UNSUPPORTED_KINDS: readonly IssueKind[] = ["quote_not_in_text", "value_not_shown", "invented_dropped"];
export interface Issue {
  path: string;
  kind: IssueKind;
  detail: string;
}

/** Why this value is not shown by its quote, or null when it is. Returns the cleaned value through `out`. */
function valueProblem(f: FieldSpec, raw: unknown, quote: string, text: string, names: string[], out: { value: unknown }): string | null {
  const k = f.kind;
  if (f.topic && !f.topic.test(quote)) return "the quote does not mention it";
  switch (k.t) {
    case "vin": {
      const vin = String(raw).toUpperCase();
      out.value = vin;
      return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) && norm(text).includes(vin.toLowerCase()) ? null : "not a 17-character VIN written in the notes";
    }
    case "year": {
      const y = Number(raw), yy = String(y).slice(-2), q = norm(quote);
      if (!Number.isInteger(y) || y < 1950 || y > 2100) return "not a model year";
      const short = q.includes(`'${yy}`) || (new RegExp(`(^|[^0-9])${yy}([^0-9]|$)`).test(q) && names.some((n) => nameShown(n, quote)));
      return q.includes(String(y)) || short ? null : "the quote does not show the year";
    }
    case "miles": {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) return "not a whole number of miles";
      if (/\bkms?\b|kil[oó]met/i.test(quote)) return "the quote gives kilometres";
      return numbersIn(quote).includes(n) ? null : "the quote does not show the number";
    }
    case "days": {
      const n = Number(raw), nums = numbersIn(quote);
      if (!Number.isInteger(n) || n < 0) return "not a whole number of days";
      return nums.includes(n) || (/week|semana/i.test(quote) && nums.some((x) => x * 7 === n)) ? null : "the quote does not show the number";
    }
    case "name":
      out.value = String(raw).trim();
      return String(raw).trim().length <= 40 && nameShown(String(raw), quote) ? null : "the quote does not show the name";
    case "state": {
      const code = stateCode(String(raw));
      out.value = code;
      return code && stateShown(code, quote) ? null : "the quote does not show the state";
    }
    case "zip":
      return /^\d{5}$/.test(String(raw)) && quote.includes(String(raw)) ? null : "the quote does not show the ZIP code";
    case "enum":
      return k.values.includes(String(raw)) ? null : "not one of the allowed values";
    case "tri":
      out.value = raw === "yes" ? true : raw === "no" ? false : undefined;
      return out.value !== undefined && hasWord(quote) ? null : "not yes or no";
    case "usd": {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && numbersIn(quote).includes(n) ? null : "the quote does not show the amount";
    }
    case "usd_list": {
      const nums = numbersIn(quote), xs = Array.isArray(raw) ? raw.map(Number) : [];
      out.value = xs.filter((x) => nums.includes(x));
      return xs.length > 0 && (out.value as number[]).length === xs.length ? null : "the quote does not show every amount";
    }
    case "lanes": {
      const xs = Array.isArray(raw) ? [...new Set(raw.map(String))] : [];
      out.value = xs;
      return xs.length > 0 && xs.every((x) => (LANES as readonly string[]).includes(x)) && hasWord(quote) ? null : "not a lane limit";
    }
  }
}

function setPath(a: Assessment, path: string, value: unknown): void {
  const [head, leaf] = path.split(".") as [keyof Assessment, string | undefined];
  if (leaf) (a[head] as Record<string, unknown>)[leaf] = value;
  else (a as Record<string, unknown>)[head] = value;
}

/**
 * Turn a model answer into the Assessment. Every value needs a quote that is in the notes and shows it;
 * what fails is left unknown and reported. `roleLines`: text removed before the model saw the notes.
 */
export function verifyAnswer(answer: Answer, text: string, roleLines: string[] = []): { assessment: Assessment; issues: Issue[] } {
  const a = emptyAssessment("model");
  const issues: Issue[] = [];
  const ev = a.evidence;
  const bad = (path: string, kind: IssueKind, detail: string) => void issues.push({ path, kind, detail });
  /** The quote, when it is in the notes. */
  const quoteOf = (path: string, evidence: string | null | undefined): string | null => {
    const q = evidence == null ? "" : cleanQuote(evidence);
    if (q !== "" && quoteInText(q, text)) return q;
    bad(path, "quote_not_in_text", q === "" ? "no quote given" : `quote "${q.slice(0, 80)}" is not in the notes`);
    return null;
  };
  const names = ["make", "model"].map((k) => (answer[k] as AnswerField)?.value).filter((v): v is string => typeof v === "string");

  for (const f of FIELDS) {
    const field = answer[f.key] as AnswerField;
    if (field == null || field.value == null) continue;
    const quote = quoteOf(f.path, field.evidence);
    if (quote === null) continue;
    const out = { value: field.value as unknown };
    const problem = valueProblem(f, field.value, quote, text, names, out);
    if (problem && !(f.kind.t === "usd_list" && (out.value as number[]).length > 0)) {
      bad(f.path, "value_not_shown", `${JSON.stringify(field.value)}: ${problem}`);
      continue;
    }
    if (problem) bad(f.path, "value_not_shown", `${JSON.stringify(field.value)}: ${problem}; kept ${JSON.stringify(out.value)}`);
    setPath(a, f.path, out.value);
    ev[f.path] = quote;
  }
  // A second damage area without a first is the first.
  if (a.primary_damage === "unknown" && a.secondary_damage !== "unknown") {
    a.primary_damage = a.secondary_damage;
    a.secondary_damage = "unknown";
    ev.primary_damage = ev.secondary_damage!;
    delete ev.secondary_damage;
  }

  for (const [name, field] of Object.entries(answer.flags ?? {})) {
    if (field == null || field.value == null) continue;
    const path = `flags.${name}`;
    if (!(FLAGS as readonly string[]).includes(name) || (field.value !== "yes" && field.value !== "no")) {
      bad(path, "invented_dropped", `${JSON.stringify(field.value)} is not a flag answer`);
      continue;
    }
    const quote = quoteOf(path, field.evidence);
    if (quote === null) continue;
    if (!hasWord(quote)) {
      bad(path, "value_not_shown", "the quote has no word");
      continue;
    }
    a.flags[name as FlagName] = field.value === "yes";
    ev[path] = quote;
  }

  const graded = new Map<Part, GradeName>();
  for (const g of answer.grades ?? []) {
    const path = `grades.${g.part}`;
    if (!(PARTS as readonly string[]).includes(g.part) || !(GRADES as readonly string[]).includes(g.grade)) {
      bad(path, "invented_dropped", `${g.part}: ${g.grade} is not a part grade`);
      continue;
    }
    if (graded.has(g.part as Part)) continue;
    const quote = quoteOf(path, g.evidence);
    if (quote === null) continue;
    graded.set(g.part as Part, g.grade as GradeName);
    ev[path] = quote;
  }
  let restFine = false;
  if (answer.rest_fine?.value != null) {
    const quote = answer.rest_fine.value === "yes" ? quoteOf("grades.rest", answer.rest_fine.evidence) : null;
    if (quote !== null) {
      restFine = true;
      ev["grades.rest"] = quote;
    }
  }
  a.grades = PARTS.map((part) => ({ part, grade: graded.get(part) ?? (restFine ? "fine" : "unknown") }));

  for (const l of answer.warning_lights ?? []) {
    const path = `warning_lights.${l.light}`;
    if (!(WARNING_LIGHTS as readonly string[]).includes(l.light)) {
      bad(path, "invented_dropped", `${l.light} is not a warning light`);
      continue;
    }
    if (a.warning_lights.includes(l.light as WarningLight)) continue;
    const quote = quoteOf(path, l.evidence);
    if (quote === null) continue;
    a.warning_lights.push(l.light as WarningLight);
    ev[path] = quote;
  }

  for (const c of answer.codes ?? []) {
    const code = c.code.trim().toUpperCase();
    const path = `codes.${code}`;
    if (!/^[PBCU][0-9A-F]{4}$/.test(code) || !new RegExp(`(^|[^A-Za-z0-9])${code}([^A-Za-z0-9]|$)`, "i").test(text)) {
      bad(path, "invented_dropped", `${c.code} is not a code written in the notes`);
      continue;
    }
    if (a.codes.some((x) => x.code === code)) continue;
    let status: CodeStatus = (CODE_STATUSES as readonly string[]).includes(c.status ?? "") ? (c.status as CodeStatus) : "confirmed";
    const stated = statusAfterCode(code, text);
    if (status === "confirmed" && stated) {
      bad(path, "downgraded", `the notes call ${code} ${stated}`);
      status = stated;
    }
    a.codes.push({ code, status });
    ev[path] = c.evidence != null && quoteInText(c.evidence, text) ? cleanQuote(c.evidence) : code;
  }
  for (const m of text.matchAll(OBD_IN_TEXT)) {
    const code = m[0].toUpperCase();
    if (!a.codes.some((c) => c.code === code) && !issues.some((i) => i.path === `codes.${code}` && i.kind === "missed")) {
      bad(`codes.${code}`, "missed", `${code} is in the notes but not in the answer`);
    }
  }

  for (const [i, s] of (answer.symptoms ?? []).entries()) {
    const t = cleanQuote(s.text);
    if (!hasWord(t) || !quoteInText(t, text)) {
      bad(`symptoms[${i}]`, "invented_dropped", `"${t.slice(0, 80)}" is not in the notes`);
      continue;
    }
    if (a.symptoms.some((x) => norm(x.text) === norm(t))) continue;
    a.symptoms.push({ system: (SYMPTOM_SYSTEMS as readonly string[]).includes(s.system) ? (s.system as SymptomSystem) : "other", text: t });
  }

  const role = roleLines.map(norm);
  a.additional = [...new Set((answer.unmapped ?? []).map((u) => u.trim().slice(0, 200)).filter((u) => u !== "" && !role.some((r) => r.includes(norm(u)))))].slice(0, MAX_ADDITIONAL);
  listMissing(a);
  return { assessment: a, issues };
}

/** The answer that reproduces a checked assessment: each value with the quote that supported it. */
export function answerFromAssessment(a: Assessment): Answer {
  const ev = a.evidence;
  const out: Answer = {};
  const get = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], a);
  for (const f of FIELDS) {
    let v = get(f.path);
    if (v === null || v === undefined || v === "unknown" || ev[f.path] === undefined || (Array.isArray(v) && v.length === 0)) continue;
    if (f.kind.t === "tri") v = v ? "yes" : "no";
    out[f.key] = { value: v, evidence: ev[f.path] };
  }
  out.flags = Object.fromEntries(FLAGS.filter((n) => a.flags[n] !== "unknown" && ev[`flags.${n}`] !== undefined).map((n) => [n, { value: a.flags[n] ? "yes" : "no", evidence: ev[`flags.${n}`] }]));
  out.grades = a.grades.filter((g) => ev[`grades.${g.part}`] !== undefined && g.grade !== "unknown").map((g) => ({ part: g.part, grade: g.grade, evidence: ev[`grades.${g.part}`]! }));
  if (ev["grades.rest"] !== undefined) out.rest_fine = { value: "yes", evidence: ev["grades.rest"] };
  out.warning_lights = a.warning_lights.map((light) => ({ light, evidence: ev[`warning_lights.${light}`] ?? null }));
  out.codes = a.codes.map((c) => ({ ...c, evidence: ev[`codes.${c.code}`] ?? c.code }));
  out.symptoms = a.symptoms.map((s) => ({ ...s }));
  out.unmapped = [...a.additional];
  return fullAnswer(out);
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface ReadOptions {
  /** A client for the model server (a fake in tests). Default: built for PARSER_BASE_URL. */
  client?: ParserClient;
  /** PARSER_BASE_URL, PARSER_MODEL (default underscope-reader), PARSER_API_KEY, PARSER_TIMEOUT_MS, PARSER_SPARSE=1, PARSER_PROMPT (a prompt file). */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ModelResult {
  assessment: Assessment;
  issues: Issue[];
  model: string;
  usage: ParserUsage[];
}

/** Read a description with the model server. Throws ReadError when there is no usable answer. */
export async function readModel(text: string, opts: ReadOptions = {}): Promise<ModelResult> {
  const input = text.replace(/^﻿/, "").trim();
  if (input === "") throw new ReadError("the description is empty");
  if (input.length > MAX_TEXT_CHARS) throw new ReadError(`the description is ${input.length} characters; the reader takes at most ${MAX_TEXT_CHARS}`);
  const env = opts.env ?? process.env;
  const baseUrl = env.PARSER_BASE_URL?.trim() || undefined;
  if (!opts.client && !baseUrl) {
    throw new ReadError("the model reader needs a model server: set PARSER_BASE_URL (for example http://127.0.0.1:8000/v1 for reader/model/serve.py)");
  }
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const model = env.PARSER_MODEL?.trim() || DEFAULT_MODEL;
  const usage: ParserUsage[] = [];
  const ctx: CallContext = {
    client: opts.client ?? createCompatClient(baseUrl!, env),
    log,
    prefix: "read",
    usage,
    timeoutMs: parserTimeoutMs(env, log),
    ...(baseUrl ? { server: baseUrl } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  };
  const { text: notes, removed } = stripRoleLines(input);
  if (notes === "") throw new ReadError('the description has only "Role:" lines, which the reader ignores');
  const promptPath = env.PARSER_PROMPT?.trim();
  const body = buildRequest(model, notes, { sparse: env.PARSER_SPARSE === "1", ...(promptPath ? { prompt: loadPrompt(resolve(promptPath)) } : {}) });
  let problem = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await callModel(ctx, attempt === 1 ? "read" : "read retry", body);
    } catch (e) {
      if (e instanceof ParserApiError) throw new ReadError(e.message);
      throw e;
    }
    const reply = readReply(res);
    if (reply.answer) {
      const v = verifyAnswer(reply.answer, notes, removed);
      for (const k of reply.dropped) v.issues.push({ path: k, kind: "malformed_dropped", detail: "the model wrote this member in a broken shape; it was left out" });
      for (const i of v.issues) log(`read: ${i.path}: ${i.kind} (${i.detail})`);
      return { ...v, model, usage };
    }
    problem = reply.problem;
    log(`read: attempt ${attempt}: ${problem}${attempt < MAX_ATTEMPTS ? "; retrying once" : ""}`);
  }
  throw new ReadError(`${baseUrl ?? "the model server"} (model ${model}) returned no usable answer twice (${problem.slice(0, 200)})`);
}

// Input record: zod schema for the raw JSON, and normalization so that every
// missing field becomes "unknown" (or null / empty), never a guess.
//
// packages/contracts does not exist yet, so the schema is defined here. When it
// lands, replace ConditionRecordSchema with a mapper from its ConditionRecord.
//
// Every object is strict: an unknown or misspelled key (e.g. "runs_drive", "flag") is an
// InputError instead of being dropped silently and then scored as "unknown". Absent keys
// are still fine and become "unknown" / null, and so is an explicit null (the free-text
// parser writes every field, with null where the text says nothing).
//
// Three optional keys come from the free-text parser: reported_symptoms (disclosed complaints in
// the user's words), market_fit (a market-fit judgment used instead of the Anthropic call when it
// is not "insufficient") and parser (its metadata: any object, ignored by the engine).

import { z } from "zod";
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
  type TitleBrand,
} from "./types.js";

/** An optional key whose value may also be null: both mean "not stated" and normalize to unknown / null. */
const opt = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const StateCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "expected a 2-letter state code")
  .transform((s) => s.toUpperCase());

const Flag = z.enum(FLAG_VALUES);

/** The shape of a diagnostic trouble code, e.g. P0301 (case-insensitive; normalized to upper case). */
export const OBD_CODE_PATTERN = /^[PBCU][0-9A-F]{4}$/i;

/** True for an absolute http: or https: URL. */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** One reported symptom: the system it belongs to and the user's own words. */
export const ReportedSymptomSchema = z.strictObject({
  system: z.enum(SYMPTOM_SYSTEMS),
  text: z.string().trim().min(1, "expected the user's words (a non-empty string)"),
});

/** Most cited signals a market-fit result carries (also the cap on the API path). */
export const MAX_MARKET_SIGNALS = 5;

/**
 * A cited market signal in an input market_fit block. A url of "", null or no url key means the
 * signal has no URL: it is accepted and normalized to "", and the market-fit scorer drops it.
 * Any other url must be an absolute http(s) URL.
 */
export const MarketSignalInputSchema = z.strictObject({
  claim: z.string().trim().min(1, "expected a non-empty claim"),
  url: z
    .string()
    .trim()
    .refine((u) => u === "" || isHttpUrl(u), "expected an http(s) URL")
    .nullable()
    .optional()
    .transform((u) => u ?? ""),
});

const IsoDate = z.iso.date();
const IsoDateTime = z.iso.datetime({ offset: true });

/**
 * The market_fit block of an input record (written by the free-text parser). Every key is
 * required and out-of-range numbers are an InputError, never clamped. Scores are judgments in
 * [-1, 1]; prices may appear only inside a signal's claim text and never enter the Decision.
 */
export const MarketFitBlockSchema = z.strictObject({
  acv: z.number().min(-1).max(1),
  copart: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  signals: z.array(MarketSignalInputSchema).max(MAX_MARKET_SIGNALS),
  insufficient: z.boolean(),
  provider: z.string().trim().min(1).max(200),
  generated_at: z
    .string()
    .trim()
    .refine(
      (s) => IsoDateTime.safeParse(s).success || IsoDate.safeParse(s).success,
      "expected an ISO 8601 date or date-time such as 2026-11-07T19:10:51Z",
    ),
});
/** A validated market_fit block (signal urls normalized to "" when absent). */
export type MarketFitBlock = z.output<typeof MarketFitBlockSchema>;
/** What may be written as a market_fit block. */
export type MarketFitBlockInput = z.input<typeof MarketFitBlockSchema>;

export const ConditionRecordSchema = z.strictObject({
  vin: opt(z.string().min(1)),
  decoded: opt(
    z.strictObject({
      year: opt(z.number().int().min(1900).max(2100)),
      make: opt(z.string().min(1)),
      model: opt(z.string().min(1)),
      trim: opt(z.string().min(1)),
    }),
  ),
  odometer: opt(z.number().int().min(0)),
  location_state: opt(StateCode),
  title: opt(
    z.strictObject({
      brand: opt(z.enum(TITLE_BRANDS)),
      state: opt(StateCode),
    }),
  ),
  runs_drives: opt(z.enum(RUN_STATUSES)),
  flags: opt(
    z.strictObject({
      frame: opt(Flag),
      airbag: opt(Flag),
      flood: opt(Flag),
      module_no_comm: opt(Flag),
      monitors_incomplete: opt(Flag),
    }),
  ),
  codes: opt(
    z.array(
      z.strictObject({
        code: z
          .string()
          .trim()
          .regex(OBD_CODE_PATTERN, "expected an OBD-II code such as P0301")
          .transform((c) => c.toUpperCase()),
        status: z.enum(CODE_STATUSES),
      }),
    ),
  ),
  seller: opt(
    z.strictObject({
      lanes_allowed: opt(z.array(z.enum(OPTIONS))),
    }),
  ),
  /** Disclosed complaints, e.g. [{system: "transmission", text: "transmission is generating noise"}]. */
  reported_symptoms: opt(z.array(ReportedSymptomSchema)),
  market_fit: opt(MarketFitBlockSchema),
  /** Parser metadata (model, input text, evidence, usage...): any object, ignored by the engine. */
  parser: opt(z.record(z.string(), z.unknown())),
});

export type ConditionRecordInput = z.input<typeof ConditionRecordSchema>;

/** The record every scorer reads: no optional fields left. */
export interface NormalizedRecord {
  vin: string | null;
  decoded: { year: number | null; make: string | null; model: string | null; trim: string | null };
  odometer: number | null;
  location_state: string | null;
  title: { brand: TitleBrand; state: string | null };
  runs_drives: RunStatus;
  flags: Record<FlagName, FlagValue>;
  codes: { code: string; status: CodeStatus }[];
  /** False when the input had no `codes` array at all (no scan), as opposed to an empty scan. */
  codes_provided: boolean;
  /** Defaults to both options when the seller gave no constraint. */
  lanes_allowed: Option[];
  /** Disclosed complaints in the user's words; [] when absent (then "reported_symptoms" is in `missing`). */
  reported_symptoms: ReportedSymptom[];
  /** The input's market_fit block, or null when it had none. Not a vehicle field: never in `missing`. */
  provided_market_fit: ProvidedMarketFit | null;
  /** Dotted paths of fields that were absent and defaulted to unknown/null. */
  missing: string[];
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Validate raw JSON and fill every missing field with "unknown" / null. Throws InputError. */
export function normalizeRecord(raw: unknown): NormalizedRecord {
  const parsed = ConditionRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("; ");
    throw new InputError(`Invalid condition record: ${issues}`);
  }
  const r = parsed.data;
  const missing: string[] = [];
  const orNull = <T>(v: T | undefined | null, path: string): T | null => {
    if (v === undefined || v === null) {
      missing.push(path);
      return null;
    }
    return v;
  };
  const orUnknown = <T extends string>(v: T | undefined | null, path: string): T | "unknown" => {
    if (v === undefined || v === null) {
      missing.push(path);
      return "unknown";
    }
    return v;
  };

  const flags = {} as Record<FlagName, FlagValue>;
  for (const f of FLAG_NAMES) flags[f] = orUnknown(r.flags?.[f], `flags.${f}`);

  const codes = r.codes ?? null;
  if (codes === null) missing.push("codes");
  const symptoms = r.reported_symptoms ?? null;
  if (symptoms === null) missing.push("reported_symptoms");
  const lanes = r.seller?.lanes_allowed;
  const market = r.market_fit ?? null;

  return {
    vin: orNull(r.vin, "vin"),
    decoded: {
      year: orNull(r.decoded?.year, "decoded.year"),
      make: orNull(r.decoded?.make, "decoded.make"),
      model: orNull(r.decoded?.model, "decoded.model"),
      trim: orNull(r.decoded?.trim, "decoded.trim"),
    },
    odometer: orNull(r.odometer, "odometer"),
    location_state: orNull(r.location_state, "location_state"),
    title: {
      brand: orUnknown(r.title?.brand, "title.brand"),
      state: orNull(r.title?.state, "title.state"),
    },
    runs_drives: orUnknown(r.runs_drives, "runs_drives"),
    flags,
    codes: codes ?? [],
    codes_provided: codes !== null,
    lanes_allowed: lanes ? OPTIONS.filter((o) => lanes.includes(o)) : [...OPTIONS],
    reported_symptoms: (symptoms ?? []).map((s) => ({ system: s.system, text: s.text })),
    provided_market_fit:
      market === null ? null : { ...market, signals: market.signals.map((sig) => ({ claim: sig.claim, url: sig.url })) },
    missing,
  };
}

/** Copy of a record with one hidden-risk flag forced to a value (used by verify_first). */
export function withFlag(record: NormalizedRecord, flag: FlagName, value: FlagValue): NormalizedRecord {
  return { ...record, flags: { ...record.flags, [flag]: value } };
}

/** Copy of a record with the title brand forced (used for unknown-title branching). */
export function withTitleBrand(record: NormalizedRecord, brand: TitleBrand): NormalizedRecord {
  return { ...record, title: { ...record.title, brand } };
}

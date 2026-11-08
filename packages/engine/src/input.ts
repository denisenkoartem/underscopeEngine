// Input record: zod schema for the raw JSON, and normalization so that every
// missing field becomes "unknown" (or null / empty), never a guess.
//
// packages/contracts does not exist yet, so the schema is defined here. When it
// lands, replace ConditionRecordSchema with a mapper from its ConditionRecord.
//
// Every object is strict: an unknown or misspelled key (e.g. "runs_drive", "flag") is an
// InputError instead of being dropped silently and then scored as "unknown". Absent keys
// are still fine and become "unknown" / null.

import { z } from "zod";
import {
  CODE_STATUSES,
  FLAG_NAMES,
  FLAG_VALUES,
  OPTIONS,
  RUN_STATUSES,
  TITLE_BRANDS,
  type CodeStatus,
  type FlagName,
  type FlagValue,
  type Option,
  type RunStatus,
  type TitleBrand,
} from "./types.js";

const StateCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/, "expected a 2-letter state code")
  .transform((s) => s.toUpperCase());

const Flag = z.enum(FLAG_VALUES);

export const ConditionRecordSchema = z.strictObject({
  vin: z.string().min(1).optional(),
  decoded: z
    .strictObject({
      year: z.number().int().min(1900).max(2100).optional(),
      make: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      trim: z.string().min(1).optional(),
    })
    .optional(),
  odometer: z.number().int().min(0).nullable().optional(),
  location_state: StateCode.optional(),
  title: z
    .strictObject({
      brand: z.enum(TITLE_BRANDS).optional(),
      state: StateCode.optional(),
    })
    .optional(),
  runs_drives: z.enum(RUN_STATUSES).optional(),
  flags: z
    .strictObject({
      frame: Flag.optional(),
      airbag: Flag.optional(),
      flood: Flag.optional(),
      module_no_comm: Flag.optional(),
      monitors_incomplete: Flag.optional(),
    })
    .optional(),
  codes: z
    .array(
      z.strictObject({
        code: z
          .string()
          .trim()
          .regex(/^[PBCUpbcu][0-9A-Fa-f]{4}$/, "expected an OBD-II code such as P0301")
          .transform((c) => c.toUpperCase()),
        status: z.enum(CODE_STATUSES),
      }),
    )
    .optional(),
  seller: z
    .strictObject({
      lanes_allowed: z.array(z.enum(OPTIONS)).optional(),
    })
    .optional(),
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
  const orUnknown = <T extends string>(v: T | undefined, path: string): T | "unknown" => {
    if (v === undefined) {
      missing.push(path);
      return "unknown";
    }
    return v;
  };

  const flags = {} as Record<FlagName, FlagValue>;
  for (const f of FLAG_NAMES) flags[f] = orUnknown(r.flags?.[f], `flags.${f}`);

  if (r.codes === undefined) missing.push("codes");
  const lanes = r.seller?.lanes_allowed;

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
    codes: r.codes ?? [],
    codes_provided: r.codes !== undefined,
    lanes_allowed: lanes ? OPTIONS.filter((o) => lanes.includes(o)) : [...OPTIONS],
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

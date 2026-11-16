// The answer shape the run1 adapter was trained on (prompts/read_v1.md), and its translation to today's
// answer (src/model.ts). Two uses: upgrade.ts converts the kept v1 training notes to the new contract,
// and eval.ts --v1 scores run1 on the fields the two shapes share.
//
// The v1 notes came from a fixed phrase list (templates.ts), so the translation is exact: every phrase
// that now fills a new field is listed here.

import { fullAnswer, type Answer } from "../../src/model.js";

type F<T> = { value?: T | null; evidence?: string | null } | null | undefined;
export interface V1Extraction {
  vin?: F<string>; year?: F<number>; make?: F<string>; model?: F<string>; trim?: F<string>;
  odometer?: F<number>; location_state?: F<string>; title_brand?: F<string>; title_state?: F<string>; runs_drives?: F<string>;
  flags?: Partial<Record<"frame" | "airbag" | "flood" | "module_no_comm" | "monitors_incomplete", F<string>>> | null;
  scan_done?: F<boolean>;
  codes?: { code: string; status: string; evidence?: string | null }[] | null;
  lanes_allowed?: F<string[]>;
  reported_symptoms?: { system: string; text: string }[] | null;
  clean_wholesale?: F<number>; salvage_comps?: F<number[]>; purchase_price?: F<number>;
  unmapped?: string[] | null;
}

const RUN: Record<string, string> = { run_and_drive: "runs_and_drives", engine_starts: "starts", no: "does_not_start" };
/** What a v1 complaint phrase also says in today's fields (the complaint itself stays in `symptoms`). */
export const SYMPTOM_FIELDS: Record<string, { field?: [key: string, value: string]; flag?: string; light?: string; grade?: [part: string, grade: string] }> = {
  "transmission slips between 2nd and 3rd": { field: ["transmission_condition", "minor"] },
  "hard shift into reverse": { field: ["transmission_condition", "minor"] },
  "transmission whines at highway speed": { field: ["transmission_condition", "minor"] },
  "trans fluid smells burnt": { field: ["transmission_condition", "minor"] },
  "engine knocks when cold": { field: ["engine_condition", "minor"] },
  "white smoke from the exhaust": { field: ["engine_condition", "minor"] },
  "oil leak at the rear main seal": { field: ["engine_condition", "minor"], flag: "fluid_leak" },
  "overheats in traffic": { field: ["engine_condition", "minor"] },
  "ticking noise from the top end": { field: ["engine_condition", "minor"] },
  "misfire under load": { field: ["engine_condition", "minor"] },
  "coolant leak at the water pump": { field: ["engine_condition", "minor"], flag: "fluid_leak" },
  "loses power going uphill": { field: ["engine_condition", "minor"] },
  "check engine light is on": { light: "check_engine" },
  "front bumper is cracked": { grade: ["front_bumper", "repairable"] },
  "driver door will not open": { grade: ["left_front_door", "repairable"] },
  "headliner is sagging": { grade: ["interior", "repairable"] },
  "torn driver seat": { grade: ["interior", "repairable"] },
};

/** The v1 answer in today's shape. Fields v1 never had stay empty unless a listed phrase fills them. */
export function fromV1(t: V1Extraction): Answer {
  const a: Answer = {};
  const has = (f: F<unknown>): f is { value: unknown; evidence: string } => f != null && f.value != null && f.evidence != null;
  const src = t as unknown as Record<string, F<unknown>>;
  for (const k of ["vin", "year", "make", "model", "trim", "title_state", "lanes_allowed", "clean_wholesale", "salvage_comps", "purchase_price"] as const) if (has(src[k])) a[k] = src[k];
  if (has(t.odometer)) a.mileage = t.odometer;
  if (has(t.location_state)) a.region = t.location_state;
  if (has(t.title_brand)) a.title_status = { value: t.title_brand.value === "nonrepairable" ? "non_repairable" : t.title_brand.value, evidence: t.title_brand.evidence };
  if (has(t.runs_drives)) a.run_status = { value: RUN[String(t.runs_drives.value)] ?? null, evidence: t.runs_drives.evidence };

  const flags: Record<string, { value: string; evidence: string }> = {};
  const lights: { light: string; evidence: string }[] = [];
  const grades: { part: string; grade: string; evidence: string }[] = [];
  const unmapped: string[] = [];
  const f = t.flags ?? {};
  if (has(f.frame)) {
    flags.frame_suspected = { value: f.frame.value === "no" ? "no" : "yes", evidence: f.frame.evidence };
    // A frame rail is part of the underbody (CLAUDE.md part list).
    if (/frame rail/i.test(f.frame.evidence) && f.frame.value !== "no") grades.push({ part: "underbody", grade: "repairable", evidence: f.frame.evidence });
  }
  if (has(f.airbag)) {
    // "airbag light on" was v1's "suspected": today that is a warning light, not a deployment.
    if (f.airbag.value === "suspected") lights.push({ light: "airbag", evidence: f.airbag.evidence });
    else flags.airbags_deployed = { value: String(f.airbag.value), evidence: f.airbag.evidence };
  }
  if (has(f.flood)) {
    flags.flood_suspected = { value: f.flood.value === "no" ? "no" : "yes", evidence: f.flood.evidence };
    if (f.flood.value === "yes") a.primary_damage = { value: "water", evidence: f.flood.evidence };
  }
  // Scan-tool details have no field any more: they are things the seller said that fit none.
  for (const k of ["module_no_comm", "monitors_incomplete"] as const) if (has(f[k])) unmapped.push(f[k]!.evidence!);
  if (has(t.scan_done) && (t.codes ?? []).length === 0) unmapped.push(t.scan_done.evidence);

  for (const s of t.reported_symptoms ?? []) {
    const more = SYMPTOM_FIELDS[s.text.toLowerCase()];
    if (!more) continue;
    if (more.field && a[more.field[0]] === undefined) a[more.field[0]] = { value: more.field[1], evidence: s.text };
    if (more.flag && !flags[more.flag]) flags[more.flag] = { value: "yes", evidence: s.text };
    if (more.light && !lights.some((l) => l.light === more.light)) lights.push({ light: more.light, evidence: s.text });
    if (more.grade && !grades.some((g) => g.part === more.grade![0])) grades.push({ part: more.grade[0], grade: more.grade[1], evidence: s.text });
  }
  for (const u of t.unmapped ?? []) {
    const ask = /^asking \$([\d,]+)$/i.exec(u);
    if (ask) a.reserve_price = { value: Number(ask[1]!.replace(/,/g, "")), evidence: u };
    else if (u.toLowerCase() === "two keys") a.keys = { value: "yes", evidence: u };
    else unmapped.push(u);
  }
  a.flags = flags;
  a.grades = grades;
  a.warning_lights = lights;
  a.codes = (t.codes ?? []).map((c) => ({ code: c.code, status: c.status, evidence: c.evidence ?? c.code }));
  a.symptoms = (t.reported_symptoms ?? []).map((s) => ({ system: s.system, text: s.text }));
  a.unmapped = unmapped;
  return fullAnswer(a);
}

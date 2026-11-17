// Shared pieces of the reader scripts (synth, upgrade, export, eval): the dataset item, the fact sampler,
// assessment comparison, metrics and the promotion gates. Pure functions only (no model calls), so
// test/reader.test.ts covers them offline.
//
// Every training target passes verifyAnswer with zero issues, so the model learns exactly what the
// production checks accept.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ENUMS, FLAGS, PARTS, emptyAssessment, type Assessment, type CodeStatus, type DamageArea, type FlagName, type GradeName, type Part, type SymptomSystem, type WarningLight } from "../../src/contract.js";
import { FIELDS, UNSUPPORTED_KINDS, answerFromAssessment, stripRoleLines, verifyAnswer, type Answer, type Issue } from "../../src/model.js";
import { SYMPTOM_FIELDS, type V1Extraction } from "./v1.js";

// ---------------------------------------------------------------------------
// Dataset items
// ---------------------------------------------------------------------------

/** A training note: the description and the answer the model must give for it. */
export interface ReaderItem {
  id: string;
  source: "synthetic" | "gold";
  /** Where the text came from. */
  origin: string;
  /** The description as a seller would type it ("Role:" lines included; they are stripped like in production). */
  notes: string;
  /** The model answer for these notes, every key present (src/model.ts fullAnswer). */
  target: Answer;
}

/** A test note: the description and what a perfect reader returns for it. Never trained on. */
export interface GoldItem {
  id: string;
  source: "gold";
  origin: string;
  notes: string;
  expect: Expect;
}

/** The expected assessment, written sparsely: only what the notes state. */
export interface Expect {
  vin?: string;
  vehicle?: Partial<Assessment["vehicle"]>;
  title_status?: Assessment["title_status"]; title_state?: string; title_in_hand?: boolean; lien?: Assessment["lien"];
  mileage?: number; odometer_status?: Assessment["odometer_status"]; region?: string; zip?: string;
  seller_type?: Assessment["seller_type"]; lanes_allowed?: Assessment["lanes_allowed"];
  run_status?: Assessment["run_status"]; keys?: boolean;
  engine_condition?: Assessment["engine_condition"]; transmission_condition?: Assessment["transmission_condition"];
  drivetrain?: Assessment["drivetrain"]; fuel_type?: Assessment["fuel_type"];
  primary_damage?: DamageArea; secondary_damage?: DamageArea;
  /** Parts the notes grade; with rest_fine every other part is fine, else unknown. */
  grades?: Partial<Record<Part, GradeName>>;
  rest_fine?: boolean;
  flags?: Partial<Record<FlagName, boolean>>;
  catalytic_converter?: Assessment["catalytic_converter"]; parts_missing?: boolean; already_repaired?: Assessment["already_repaired"];
  warning_lights?: WarningLight[];
  codes?: [code: string, status: CodeStatus][];
  /** The systems complained about (the wording is not scored). */
  symptoms?: SymptomSystem[];
  values?: Partial<Assessment["values"]>;
  storage_cost_per_day?: number; sell_by_days?: number;
}

/** The full assessment an Expect stands for. */
export function expectAssessment(e: Expect): Assessment {
  const a = emptyAssessment("rules");
  const { vehicle, grades, rest_fine, flags, codes, symptoms, values, ...plain } = e;
  Object.assign(a, plain);
  Object.assign(a.vehicle, vehicle ?? {});
  Object.assign(a.flags, flags ?? {});
  Object.assign(a.values, values ?? {});
  a.grades = PARTS.map((part) => ({ part, grade: grades?.[part] ?? (rest_fine ? "fine" : "unknown") }));
  a.codes = (codes ?? []).map(([code, status]) => ({ code, status }));
  a.symptoms = (symptoms ?? []).map((system) => ({ system, text: "" }));
  return a;
}

export const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      try {
        return JSON.parse(l) as T;
      } catch {
        throw new Error(`${path}:${i + 1}: not valid JSON`);
      }
    });

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The script's arguments without a leading "--" (pnpm run can pass it through; parseArgs would reject it). */
export const cliArgs = (argv: string[] = process.argv.slice(2)): string[] => (argv[0] === "--" ? argv.slice(1) : argv);

/** Case-, space- and punctuation-insensitive text, for de-duplication. */
export const normText = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Run the production checks on an answer for these notes ("Role:" lines stripped first, as readModel does). */
export function verifyNotes(notes: string, answer: Answer) {
  const { text, removed } = stripRoleLines(notes.replace(/^\uFEFF/, "").trim());
  return verifyAnswer(answer, text, removed);
}

/** Why a target is not a usable label for these notes: any check issue, or an assessment that changes when rebuilt. */
export function targetProblems(notes: string, target: Answer): string[] {
  const v = verifyNotes(notes, target);
  const problems = v.issues.map((i) => `${i.path}: ${i.kind} (${i.detail})`);
  const again = verifyNotes(notes, answerFromAssessment(v.assessment));
  // The evidence map is compared by content, not by the order its keys were written in.
  const stable = (a: Assessment) => JSON.stringify({ ...a, evidence: Object.fromEntries(Object.entries(a.evidence).sort(([x], [y]) => x.localeCompare(y))) });
  if (stable(again.assessment) !== stable(v.assessment)) problems.push("the assessment changes when rebuilt from its own answer");
  return problems;
}

/** Fault codes the sampler writes into notes (common generic OBD-II codes). */
export const CODE_POOL = ["P0101", "P0113", "P0128", "P0133", "P0171", "P0174", "P0300", "P0301", "P0302", "P0303", "P0304", "P0325", "P0340", "P0401", "P0420", "P0430", "P0440", "P0442", "P0455", "P0500", "P0507", "P0562", "P0606", "P0700", "P0715", "P0730", "P0741", "P0750", "B0001", "B0012", "B1318", "C0035", "C0040", "C1232", "U0100", "U0101", "U0121", "U0140"] as const;
export const V1_FLAGS = ["frame", "airbag", "flood", "module_no_comm", "monitors_incomplete"] as const;
export type V1Flag = (typeof V1_FLAGS)[number];
const NONE = { value: null, evidence: null };
const AREAS = ["front", "rear", "side", "rollover", "all_over", "undercarriage", "mechanical", "hail", "vandalism", "theft", "minor"] as const;

// ---------------------------------------------------------------------------
// Synthetic facts (the record a writer model turns into seller notes)
// ---------------------------------------------------------------------------

/** Seeded PRNG (mulberry32): the same seed gives the same facts. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
/** Pick by weight: [[value, weight], ...]. */
function weighted<T>(r: () => number, xs: readonly (readonly [T, number])[]): T {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of xs) if ((x -= w) < 0) return v;
  return xs[xs.length - 1]![0];
}

export const VEHICLES: readonly (readonly [string, string, readonly string[]])[] = [
  ["Ford", "F-150", ["XL", "XLT", "Lariat"]],
  ["Chevrolet", "Silverado 1500", ["LT", "LTZ", "Custom"]],
  ["Ram", "1500", ["Tradesman", "Big Horn", "Laramie"]],
  ["Toyota", "Camry", ["LE", "SE", "XLE"]],
  ["Toyota", "Corolla", ["L", "LE", "SE"]],
  ["Toyota", "RAV4", ["LE", "XLE", "Limited"]],
  ["Toyota", "Tacoma", ["SR", "SR5", "TRD Off-Road"]],
  ["Honda", "Civic", ["LX", "EX", "Sport"]],
  ["Honda", "Accord", ["LX", "EX-L", "Sport"]],
  ["Honda", "CR-V", ["LX", "EX", "Touring"]],
  ["Honda", "Odyssey", ["EX", "EX-L", "Touring"]],
  ["Nissan", "Altima", ["S", "SV", "SR"]],
  ["Nissan", "Rogue", ["S", "SV", "SL"]],
  ["Jeep", "Grand Cherokee", ["Laredo", "Limited", "Overland"]],
  ["Jeep", "Wrangler", ["Sport", "Sahara", "Rubicon"]],
  ["Hyundai", "Elantra", ["SE", "SEL", "Limited"]],
  ["Hyundai", "Tucson", ["SE", "SEL", "Limited"]],
  ["Kia", "Sorento", ["LX", "EX", "SX"]],
  ["Subaru", "Outback", ["Premium", "Limited", "Touring"]],
  ["Chevrolet", "Equinox", ["LS", "LT", "Premier"]],
  ["Chevrolet", "Malibu", ["LS", "LT", "Premier"]],
  ["Ford", "Escape", ["S", "SE", "Titanium"]],
  ["Ford", "Explorer", ["Base", "XLT", "Limited"]],
  ["GMC", "Sierra 1500", ["SLE", "SLT", "Denali"]],
  ["Dodge", "Charger", ["SXT", "GT", "R/T"]],
  ["Volkswagen", "Jetta", ["S", "SE", "SEL"]],
  ["Mazda", "CX-5", ["Sport", "Touring", "Grand Touring"]],
  ["Tesla", "Model 3", ["Standard Range", "Long Range", "Performance"]],
  ["BMW", "3 Series", ["330i", "330e", "M340i"]],
  ["Chrysler", "Pacifica", ["Touring", "Touring L", "Limited"]],
];

export const STATES: readonly (readonly [string, string])[] = [
  ["TX", "Texas"], ["CA", "California"], ["FL", "Florida"], ["NY", "New York"], ["OH", "Ohio"], ["PA", "Pennsylvania"],
  ["GA", "Georgia"], ["NC", "North Carolina"], ["MI", "Michigan"], ["IL", "Illinois"], ["AZ", "Arizona"], ["NJ", "New Jersey"],
  ["WA", "Washington"], ["TN", "Tennessee"], ["NV", "Nevada"], ["CO", "Colorado"],
];

/** Complaints in a seller's words. None uses a run-status word (runs, drives, starts...), so a symptom never implies a run status. */
export const SYMPTOMS: readonly (readonly [SymptomSystem, string])[] = [
  ["transmission", "transmission slips between 2nd and 3rd"],
  ["transmission", "hard shift into reverse"],
  ["transmission", "transmission whines at highway speed"],
  ["transmission", "shudders on acceleration"],
  ["transmission", "trans fluid smells burnt"],
  ["engine", "engine knocks when cold"],
  ["engine", "white smoke from the exhaust"],
  ["engine", "oil leak at the rear main seal"],
  ["engine", "overheats in traffic"],
  ["engine", "ticking noise from the top end"],
  ["engine", "misfire under load"],
  ["engine", "coolant leak at the water pump"],
  ["engine", "loses power going uphill"],
  ["brakes", "brakes grind when stopping"],
  ["brakes", "soft brake pedal"],
  ["brakes", "brakes squeal"],
  ["steering_suspension", "pulls hard to the left"],
  ["steering_suspension", "clunk over bumps"],
  ["steering_suspension", "steering wheel shakes at 60"],
  ["steering_suspension", "power steering whines"],
  ["electrical", "check engine light is on"],
  ["electrical", "battery drains overnight"],
  ["electrical", "power windows don't work"],
  ["electrical", "dash lights flicker"],
  ["body", "front bumper is cracked"],
  ["body", "driver door will not open"],
  ["body", "rust on the rocker panels"],
  ["body", "rear quarter is dented"],
  ["interior", "headliner is sagging"],
  ["interior", "torn driver seat"],
  ["other", "AC blows warm"],
  ["other", "exhaust is loud"],
];

export const VOICES = [
  "terse dealer shorthand with abbreviations",
  "chatty private seller, a few typos, lowercase",
  "insurance adjuster note, formal",
  "auction listing bullet points",
  "text message, run-on sentences, typos",
  "mostly English with some Spanish words (millas, corre y maneja, título)",
] as const;

/** The facts one synthetic note is written from. null = the note must not mention it. */
export interface SynthFacts {
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  odometer: number | null;
  location_state: string | null;
  title_brand: "clean" | "salvage" | "rebuilt" | "nonrepairable" | null;
  title_state: string | null;
  runs_drives: "run_and_drive" | "engine_starts" | "no" | null;
  flags: Record<V1Flag, "yes" | "suspected" | "no" | null>;
  /** null = no scan mentioned; [] = "scanned, no codes". */
  codes: { code: string; status: CodeStatus }[] | null;
  lanes_allowed: ("acv" | "copart")[] | null;
  reported_symptoms: { system: SymptomSystem; text: string }[];
  clean_wholesale: number | null;
  salvage_comps: number[] | null;
  purchase_price: number | null;
  /** Writing style; injection and role lines are noise the reader must ignore. */
  voice: string;
  injection: boolean;
  role_line: boolean;
  /** The 2026-11-16 fields; null for a note in the old style (none of them mentioned). */
  v2: V2Facts | null;
}

/** Facts for the fields added on 2026-11-16. null / empty = the note must not mention it. */
export interface V2Facts {
  seller_type: (typeof ENUMS.seller_type)[number] | null;
  title_in_hand: "yes" | "no" | null;
  lien: "none" | "open" | null;
  odometer_status: (typeof ENUMS.odometer_status)[number] | null;
  keys: "yes" | "no" | null;
  engine_condition: "ok" | "failed" | null;
  transmission_condition: "ok" | "failed" | null;
  drivetrain: (typeof ENUMS.drivetrain)[number] | null;
  fuel_type: (typeof ENUMS.fuel_type)[number] | null;
  zip: string | null;
  /** Damage areas named in the note (water and fire come from the flood and fire flags). */
  areas: Exclude<DamageArea, "unknown" | "water" | "fire" | "none">[];
  /** Part grades, in groups that share one phrase ("hood and grille smashed"). */
  parts: { parts: Part[]; grade: "fine" | "repairable" | "replace" }[];
  /** "everything else is fine"; with no parts it is "no damage". */
  rest_fine: boolean;
  fluid_leak: "yes" | "no" | null;
  fire_damage: "yes" | "no" | null;
  catalytic_converter: "present" | "missing" | null;
  parts_missing: "yes" | "no" | null;
  already_repaired: "yes" | "partly" | "no" | null;
  warning_lights: WarningLight[];
  /** true: the note says no warning lights are on (nothing to label). */
  no_lights: boolean;
  repair_estimate: number | null;
  reserve_price: number | null;
  storage_cost_per_day: number | null;
  sell_by_days: number | null;
}

const VIN_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
const maybe = <T>(r: () => number, p: number, make: () => T): T | null => (r() < p ? make() : null);
const round = (x: number, step: number) => Math.round(x / step) * step;

/** One random set of facts. `codePool` is the DTC list (data/dtc_codes.csv codes). */
export function sampleFacts(r: () => number, codePool: readonly string[] = CODE_POOL, withV2 = false): SynthFacts {
  const [make, model, trims] = pick(r, VEHICLES);
  const year = 2026 - Math.floor(Math.pow(r(), 1.6) * 24);
  const age = Math.max(1, 2026 - year);
  const flags = Object.fromEntries(
    V1_FLAGS.map((n) => [n, weighted<"yes" | "suspected" | "no" | null>(r, [[null, 60], ["yes", 10], ["suspected", 15], ["no", 15]])]),
  ) as SynthFacts["flags"];
  // Scan-tool flags have no field any more: new-style notes do not mention them.
  if (withV2) flags.module_no_comm = flags.monitors_incomplete = null;
  const scan = weighted(r, [["none", 50], ["empty", 15], ["codes", 35]] as const);
  const codes =
    scan === "none"
      ? null
      : scan === "empty"
        ? []
        : [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, codePool)))].map((code) => ({
            code,
            status: weighted<CodeStatus>(r, [["confirmed", 70], ["pending", 20], ["history", 10]]),
          }));
  const nSymptoms = weighted(r, [[0, 45], [1, 35], [2, 20]] as const);
  const symptoms = [...new Set(Array.from({ length: nSymptoms }, () => pick(r, SYMPTOMS)))].map(([system, text]) => ({ system, text }));
  const clean = maybe(r, 0.3, () => round(4000 + r() * 30000, 100));
  return {
    vin: maybe(r, 0.15, () => Array.from({ length: 17 }, () => pick(r, [...VIN_CHARS])).join("")),
    year: maybe(r, 0.9, () => year),
    make: maybe(r, 0.92, () => make),
    model: maybe(r, 0.9, () => model),
    trim: maybe(r, 0.4, () => pick(r, trims)),
    odometer: maybe(r, 0.75, () => round(age * (6000 + r() * 10000), pick(r, [1, 100, 1000]))),
    location_state: maybe(r, 0.6, () => pick(r, STATES)[0]),
    title_brand: weighted(r, [["clean", 55], ["salvage", 25], ["rebuilt", 8], ["nonrepairable", 4], [null, 8]] as const),
    title_state: maybe(r, 0.15, () => pick(r, STATES)[0]),
    runs_drives: weighted(r, [["run_and_drive", 45], ["engine_starts", 15], ["no", 20], [null, 20]] as const),
    flags,
    codes,
    lanes_allowed: weighted(r, [[null, 90], [["acv"], 5], [["copart"], 5]] as const) as SynthFacts["lanes_allowed"],
    reported_symptoms: symptoms,
    clean_wholesale: clean,
    salvage_comps: maybe(r, 0.2, () => Array.from({ length: 2 + Math.floor(r() * 3) }, () => round(300 + r() * 4000, 25))),
    purchase_price: maybe(r, 0.15, () => round(1000 + r() * 25000, 100)),
    voice: pick(r, VOICES),
    injection: r() < 0.05,
    role_line: r() < 0.05,
    v2: withV2 ? sampleV2(r, symptoms.map((s) => s.text)) : null,
  };
}

const GROUPS: readonly (readonly Part[])[] = [
  ["front_bumper", "hood", "grille"], ["left_headlight", "left_front_fender"], ["right_headlight", "right_front_fender"], ["rear_bumper", "tailgate_or_rear_doors"],
  ["left_front_door", "left_rear_door"], ["right_front_door", "right_rear_door"], ["left_taillight", "left_rear_quarter"], ["right_taillight", "right_rear_quarter"],
  ["windshield"], ["roof"], ["left_mirror"], ["right_mirror"], ["wheels_and_tires"], ["interior"], ["engine_bay"], ["underbody"],
];

/** Facts for the new fields. Nothing here contradicts what the note's complaints already say (v1.ts SYMPTOM_FIELDS). */
function sampleV2(r: () => number, symptomTexts: string[]): V2Facts {
  const said = symptomTexts.map((t) => SYMPTOM_FIELDS[t]).filter((x) => x !== undefined);
  const taken = new Set<string>(said.flatMap((x) => (x.grade ? [x.grade[0]] : [])));
  const mentions = (key: string) => said.some((x) => x.field?.[0] === key);
  // Part damage: none (40%), "no damage" (8%), or one to three groups of parts.
  const kind = weighted(r, [["none", 40], ["clean", 8], ["damage", 52]] as const);
  const parts: V2Facts["parts"] = [];
  if (kind === "damage") {
    const groups = [...GROUPS].sort(() => r() - 0.5).slice(0, 1 + Math.floor(r() * 3));
    for (const g of groups) {
      const some = g.filter((p) => !taken.has(p) && r() < 0.75);
      if (some.length > 0) parts.push({ parts: some, grade: weighted(r, [["replace", 45], ["repairable", 45], ["fine", 10]] as const) });
    }
  }
  const lights = said.some((x) => x.light) ? [] : weighted(r, [[[], 80], [["check_engine"], 8], [["abs"], 4], [["other"], 4], [["check_engine", "abs"], 4]] as const);
  return {
    seller_type: maybe(r, 0.35, () => pick(r, ENUMS.seller_type)),
    title_in_hand: maybe(r, 0.35, () => pick(r, ["yes", "yes", "no"] as const)),
    lien: maybe(r, 0.3, () => pick(r, ["none", "none", "open"] as const)),
    odometer_status: maybe(r, 0.2, () => weighted(r, [["actual", 60], ["not_actual", 25], ["exempt", 15]] as const)),
    keys: maybe(r, 0.4, () => pick(r, ["yes", "yes", "no"] as const)),
    engine_condition: mentions("engine_condition") ? null : maybe(r, 0.3, () => pick(r, ["ok", "failed"] as const)),
    transmission_condition: mentions("transmission_condition") ? null : maybe(r, 0.25, () => pick(r, ["ok", "failed"] as const)),
    drivetrain: maybe(r, 0.2, () => pick(r, ENUMS.drivetrain)),
    fuel_type: maybe(r, 0.12, () => pick(r, ENUMS.fuel_type)),
    zip: maybe(r, 0.12, () => String(10000 + Math.floor(r() * 89999))),
    areas: kind === "clean" ? [] : weighted(r, [[0, 50], [1, 38], [2, 12]] as const) === 0 ? [] : [...new Set(Array.from({ length: 1 + (r() < 0.25 ? 1 : 0) }, () => pick(r, AREAS)))],
    parts,
    rest_fine: kind === "clean" || (parts.length > 0 && r() < 0.6),
    fluid_leak: said.some((x) => x.flag === "fluid_leak") ? null : maybe(r, 0.3, () => pick(r, ["yes", "no", "no"] as const)),
    fire_damage: maybe(r, 0.12, () => pick(r, ["yes", "no"] as const)),
    catalytic_converter: maybe(r, 0.2, () => pick(r, ["present", "missing"] as const)),
    parts_missing: maybe(r, 0.15, () => pick(r, ["yes", "no"] as const)),
    already_repaired: maybe(r, 0.2, () => pick(r, ENUMS.already_repaired)),
    warning_lights: [...lights],
    no_lights: lights.length === 0 && !said.some((x) => x.light) && r() < 0.08,
    repair_estimate: maybe(r, 0.25, () => round(400 + r() * 12000, 50)),
    reserve_price: maybe(r, 0.25, () => round(1500 + r() * 25000, 100)),
    storage_cost_per_day: maybe(r, 0.1, () => round(15 + r() * 60, 5)),
    sell_by_days: maybe(r, 0.12, () => pick(r, [3, 5, 7, 10, 14, 21, 30])),
  };
}

/** The writer's quotes for a note: one exact phrase per mentioned fact (null when not written). */
export interface WriterQuotes {
  notes: string;
  evidence: Record<string, string | null>;
  codes: { code: string; evidence: string | null }[];
}

/** The answer a perfect reader would give, from the sampled facts and the writer's quotes (checked afterwards). */
export function extractionFromFacts(facts: SynthFacts, w: WriterQuotes): V1Extraction {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (k: string, value: unknown): any => (value === null || value === undefined ? NONE : { value, evidence: w.evidence[k] ?? null });
  return {
    vin: q("vin", facts.vin),
    year: q("year", facts.year),
    make: q("make", facts.make),
    model: q("model", facts.model),
    trim: q("trim", facts.trim),
    odometer: q("odometer", facts.odometer),
    location_state: q("location_state", facts.location_state),
    title_brand: q("title_brand", facts.title_brand),
    title_state: q("title_state", facts.title_state),
    runs_drives: q("runs_drives", facts.runs_drives),
    flags: Object.fromEntries(V1_FLAGS.map((n) => [n, q(n, facts.flags[n])])),
    scan_done: facts.codes !== null ? { value: true, evidence: w.evidence.scan_done ?? null } : NONE,
    codes: (facts.codes ?? []).map((c) => ({ ...c, evidence: w.codes.find((x) => x.code === c.code)?.evidence ?? null })),
    lanes_allowed: q("lanes_allowed", facts.lanes_allowed),
    reported_symptoms: facts.reported_symptoms,
    clean_wholesale: q("clean_wholesale", facts.clean_wholesale),
    salvage_comps: q("salvage_comps", facts.salvage_comps),
    purchase_price: q("purchase_price", facts.purchase_price),
    unmapped: [],
  };
}

// ---------------------------------------------------------------------------
// Comparing assessments, metrics, gates
// ---------------------------------------------------------------------------

export const UNKNOWN = "∅";
/** Fields where a misread changes which lane the vehicle can or should go to. */
export const HIGH_STAKES = ["title_status", "run_status", "flags.frame_suspected", "flags.airbags_deployed", "flags.flood_suspected", "lanes_allowed", "seller_type", "title_in_hand", "keys", "grades.replace"] as const;

/** The compared value of every field: UNKNOWN when the assessment says nothing, else a normalized string. */
export function assessmentFields(a: Assessment): Record<string, string> {
  const s = (v: unknown) => (v === null || v === undefined || v === "unknown" || (Array.isArray(v) && v.length === 0) ? UNKNOWN : Array.isArray(v) ? v.join(",") : String(v));
  const name = (v: unknown) => (typeof v === "string" && v ? v.toLowerCase().replace(/[^a-z0-9]/g, "") : UNKNOWN);
  const get = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], a);
  const out: Record<string, string> = {};
  for (const f of FIELDS) out[f.path] = f.kind.t === "name" ? name(get(f.path)) : f.kind.t === "lanes" ? s([...((get(f.path) as string[] | null) ?? [])].sort()) : s(get(f.path));
  for (const n of FLAGS) out[`flags.${n}`] = s(a.flags[n]);
  for (const g of a.grades) out[`grades.${g.part}`] = s(g.grade);
  // The parts graded "replace", as one field: the expensive misses.
  out["grades.replace"] = s(a.grades.filter((g) => g.grade === "replace").map((g) => g.part));
  out.warning_lights = s([...a.warning_lights].sort());
  out.codes = s(a.codes.map((c) => `${c.code}:${c.status}`).sort());
  out.symptoms = s([...new Set(a.symptoms.map((x) => x.system))].sort());
  return out;
}

/** One test note scored against one reading (null = the reader failed). */
export interface ItemResult {
  id: string;
  failed: string | null;
  gold: Record<string, string>;
  pred: Record<string, string>;
  /** Unsupported-answer issues (UNSUPPORTED_KINDS) the checks removed from the model's answer. */
  unsupported: number;
  latency_ms: number;
}

export function scoreItem(id: string, gold: Assessment, pred: Assessment | null, issues: Issue[], extra: { failed?: string | null; latency_ms?: number } = {}): ItemResult {
  const goldFields = assessmentFields(gold);
  return {
    id,
    failed: extra.failed ?? (pred ? null : "no reading"),
    gold: goldFields,
    pred: pred ? assessmentFields(pred) : Object.fromEntries(Object.keys(goldFields).map((k) => [k, UNKNOWN])),
    unsupported: issues.filter((i) => UNSUPPORTED_KINDS.includes(i.kind)).length,
    latency_ms: extra.latency_ms ?? 0,
  };
}

export interface Metrics {
  n: number;
  failed: number;
  field_accuracy: Record<string, number>;
  overall_accuracy: number;
  /** Accuracy on the fields where the gold says something (a reader that leaves everything unknown scores 0 here). */
  stated_accuracy: number;
  /** Fields the reader filled where the gold says nothing, per note. */
  invented_rate: number;
  /** Fields the gold states that the reader left unknown, per note. */
  missed_rate: number;
  /** Answers the checks removed, per note (model readers only). */
  unsupported_rate: number;
  latency_p50_ms: number;
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);

export function metrics(items: ItemResult[]): Metrics {
  const fields = Object.keys(items[0]?.gold ?? {});
  const field_accuracy: Record<string, number> = {};
  let right = 0, total = 0, stated = 0, statedRight = 0, invented = 0, missed = 0;
  for (const f of fields) {
    const hits = items.filter((i) => i.gold[f] === i.pred[f]).length;
    field_accuracy[f] = ratio(hits, items.length);
    right += hits;
    total += items.length;
  }
  for (const i of items) {
    for (const f of fields) {
      const g = i.gold[f] !== UNKNOWN, p = i.pred[f] !== UNKNOWN;
      if (g) stated++;
      if (g && i.gold[f] === i.pred[f]) statedRight++;
      if (p && !g) invented++;
      if (g && !p) missed++;
    }
  }
  const latencies = items.filter((i) => !i.failed).map((i) => i.latency_ms).sort((a, b) => a - b);
  return {
    n: items.length,
    failed: items.filter((i) => i.failed).length,
    field_accuracy,
    overall_accuracy: ratio(right, total),
    stated_accuracy: ratio(statedRight, stated),
    invented_rate: ratio(invented, items.length),
    missed_rate: ratio(missed, items.length),
    unsupported_rate: ratio(items.reduce((s, i) => s + i.unsupported, 0), items.length),
    latency_p50_ms: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)]! : 0,
  };
}

export const MAX_P50_LATENCY_MS = 3000;

/** The promotion gates: the candidate must do at least as well as the baseline on every one. */
export function gates(candidate: Metrics, baseline: Metrics): { gate: string; pass: boolean; detail: string }[] {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const failRate = (m: Metrics) => (m.n === 0 ? 0 : m.failed / m.n);
  return [
    { gate: "failed readings <= baseline", pass: failRate(candidate) <= failRate(baseline), detail: `${candidate.failed} of ${candidate.n} vs ${baseline.failed} of ${baseline.n}` },
    { gate: "overall field accuracy >= baseline", pass: candidate.overall_accuracy >= baseline.overall_accuracy, detail: `${pct(candidate.overall_accuracy)} vs ${pct(baseline.overall_accuracy)}` },
    { gate: "accuracy on stated fields >= baseline", pass: candidate.stated_accuracy >= baseline.stated_accuracy, detail: `${pct(candidate.stated_accuracy)} vs ${pct(baseline.stated_accuracy)}` },
    ...HIGH_STAKES.map((f) => {
      const c = candidate.field_accuracy[f] ?? 0, b = baseline.field_accuracy[f] ?? 0;
      return { gate: `${f} accuracy >= baseline`, pass: c >= b, detail: `${pct(c)} vs ${pct(b)}` };
    }),
    { gate: "invented values <= baseline", pass: candidate.invented_rate <= baseline.invented_rate, detail: `${candidate.invented_rate.toFixed(2)} vs ${baseline.invented_rate.toFixed(2)} per note` },
    { gate: `p50 latency <= ${MAX_P50_LATENCY_MS} ms`, pass: candidate.latency_p50_ms <= MAX_P50_LATENCY_MS, detail: `${candidate.latency_p50_ms} ms` },
  ];
}

// ---------------------------------------------------------------------------
// SFT export helpers
// ---------------------------------------------------------------------------

/** Targets that carry a rare, expensive fact: oversampled in training (dollar weighting for a reader). */
export function isHighStakes(t: Answer): boolean {
  const v = (k: string) => (t[k] as { value?: unknown } | null | undefined)?.value;
  const flag = (n: string) => t.flags?.[n]?.value;
  return (
    ["salvage", "non_repairable", "rebuilt", "flood"].includes(String(v("title_status"))) ||
    v("run_status") === "does_not_start" ||
    flag("frame_suspected") === "yes" || flag("airbags_deployed") === "yes" || flag("flood_suspected") === "yes" ||
    v("title_in_hand") === "no" || v("keys") === "no" ||
    ((v("lanes_allowed") as unknown[] | undefined)?.length ?? 0) > 0
  );
}

/** VINs written in a text (17 VIN characters). */
export const vinsIn = (s: string): string[] => [...s.toUpperCase().matchAll(/(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/g)].map((m) => m[0]);

/** train or dev, stable per id. */
export const splitOf = (id: string, devShare: number): "train" | "dev" => (parseInt(sha256(id).slice(0, 8), 16) / 0xffffffff < devShare ? "dev" : "train");

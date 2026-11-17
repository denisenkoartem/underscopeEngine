// The one JSON the reader returns for a seller's description, whichever reader wrote it (rules.ts or
// model.ts). The engine analyzes this JSON later; the reader itself decides nothing.
//
// Every key the page already used keeps its name and values (vin, title_status, mileage, region,
// run_status, values.clean_wholesale, values.salvage_comps, grades, the first three flags, evidence,
// missing, questions, additional). The rest was added on 2026-11-16 from what ACV's and Copart's rules
// say decides the seller's margin (reader/README.md, "Criteria").
//
// What the text does not say stays "unknown", null or an empty list. Nothing is guessed.
//
// The Python engine mirrors this file (engine/src/underscope/assessment.py) and its marketplace model uses
// these fields as features (engine/src/underscope/router.py). Renaming or removing a key, or changing an
// enum value, fails engine/tests/test_assessment.py and means retraining that model (`underscope train-router`).

export const PARTS = ['front_bumper', 'hood', 'grille', 'left_headlight', 'right_headlight', 'windshield', 'left_front_fender', 'right_front_fender', 'left_front_door', 'right_front_door', 'left_rear_door', 'right_rear_door', 'left_mirror', 'right_mirror', 'left_rear_quarter', 'right_rear_quarter', 'tailgate_or_rear_doors', 'rear_bumper', 'left_taillight', 'right_taillight', 'wheels_and_tires', 'roof', 'interior', 'engine_bay', 'underbody'] as const;
export type Part = (typeof PARTS)[number];
export const GRADES = ['fine', 'repairable', 'replace'] as const;
export type GradeName = (typeof GRADES)[number] | 'unknown';
export type Tri = boolean | 'unknown';

/** Fields with a fixed list of values. "unknown" is always allowed on top of these. */
export const ENUMS = {
  title_status: ['clean', 'salvage', 'rebuilt', 'flood', 'non_repairable', 'lemon'],
  lien: ['none', 'open'],
  odometer_status: ['actual', 'not_actual', 'exempt'],
  seller_type: ['dealer', 'insurer', 'fleet', 'lender', 'individual'],
  run_status: ['runs_and_drives', 'starts', 'does_not_start'],
  engine_condition: ['ok', 'minor', 'failed'],
  transmission_condition: ['ok', 'minor', 'failed'],
  drivetrain: ['fwd', 'rwd', 'awd', '4wd'],
  fuel_type: ['gas', 'diesel', 'hybrid', 'electric'],
  primary_damage: ['front', 'rear', 'side', 'rollover', 'all_over', 'undercarriage', 'mechanical', 'hail', 'water', 'fire', 'vandalism', 'theft', 'minor', 'none'],
  secondary_damage: ['front', 'rear', 'side', 'rollover', 'all_over', 'undercarriage', 'mechanical', 'hail', 'water', 'fire', 'vandalism', 'theft', 'minor', 'none'],
  catalytic_converter: ['present', 'missing'],
  already_repaired: ['yes', 'partly', 'no'],
} as const;
export type EnumField = keyof typeof ENUMS;
type EnumOf<K extends EnumField> = (typeof ENUMS)[K][number] | 'unknown';
export type TitleStatus = EnumOf<'title_status'>;
export type RunStatus = EnumOf<'run_status'>;
export type DamageArea = EnumOf<'primary_damage'>;

/** Yes / no facts outside `flags`. */
export const TRI_FIELDS = ['title_in_hand', 'keys', 'parts_missing'] as const;
export type TriField = (typeof TRI_FIELDS)[number];
export const FLAGS = ['airbags_deployed', 'frame_suspected', 'fluid_leak', 'flood_suspected', 'fire_damage'] as const;
export type FlagName = (typeof FLAGS)[number];
export const VALUE_FIELDS = ['clean_wholesale', 'purchase_price', 'repair_estimate', 'reserve_price'] as const;
export type ValueField = (typeof VALUE_FIELDS)[number];
export const WARNING_LIGHTS = ['check_engine', 'abs', 'airbag', 'other'] as const;
export type WarningLight = (typeof WARNING_LIGHTS)[number];
export const LANES = ['acv', 'copart'] as const;
export type Lane = (typeof LANES)[number];
export const CODE_STATUSES = ['confirmed', 'pending', 'history'] as const;
export type CodeStatus = (typeof CODE_STATUSES)[number];
export const SYMPTOM_SYSTEMS = ['transmission', 'engine', 'brakes', 'steering_suspension', 'electrical', 'body', 'interior', 'other'] as const;
export type SymptomSystem = (typeof SYMPTOM_SYSTEMS)[number];

export type Assessment = {
  /** What read the text: the keyword rules, the trained model, or both merged by read.ts. */
  reader: 'rules' | 'model' | 'rules+model';
  vin: string | null;
  /** Only what the text itself says; the VIN decode is the better source. */
  vehicle: { year: number | null; make: string | null; model: string | null; trim: string | null };

  // Title and paperwork
  title_status: TitleStatus;
  title_state: string | null;                  // US state that issued the title, two letters
  title_in_hand: Tri;
  lien: EnumOf<'lien'>;

  // Mileage, place, seller
  mileage: number | null;
  odometer_status: EnumOf<'odometer_status'>;
  region: string | null;                       // US state the vehicle is in, two letters
  zip: string | null;
  seller_type: EnumOf<'seller_type'>;
  /** Set only when the seller limits where it may be sold. */
  lanes_allowed: Lane[] | null;

  // Running condition
  run_status: RunStatus;
  keys: Tri;
  engine_condition: EnumOf<'engine_condition'>;
  transmission_condition: EnumOf<'transmission_condition'>;
  drivetrain: EnumOf<'drivetrain'>;
  fuel_type: EnumOf<'fuel_type'>;

  // Damage
  primary_damage: DamageArea;
  secondary_damage: DamageArea;
  grades: { part: Part; grade: GradeName }[];  // all 25 parts
  flags: Record<FlagName, Tri>;
  catalytic_converter: EnumOf<'catalytic_converter'>;
  parts_missing: Tri;
  already_repaired: EnumOf<'already_repaired'>;

  // Complaints, in the seller's words
  warning_lights: WarningLight[];
  codes: { code: string; status: CodeStatus }[];
  symptoms: { system: SymptomSystem; text: string }[];

  // Money and timing
  values: { clean_wholesale: number | null; salvage_comps: number[]; purchase_price: number | null; repair_estimate: number | null; reserve_price: number | null };
  storage_cost_per_day: number | null;
  sell_by_days: number | null;

  evidence: Record<string, string>;            // field path -> the words it was read from
  /** Every fact the reader was expecting, in the order the page asks for it, given or not. */
  expected: { field: string; need: 'needed' | 'helpful'; given: boolean; ask: string }[];
  /** How much of the expected input is there. `note` is null when nothing is missing. */
  precision: { expected: number; given: number; level: 'full' | 'reduced' | 'low'; note: string | null };
  missing: string[];                           // expected and needed for the decision, not given
  could_add: string[];                         // expected and helpful, not given
  questions: string[];                         // things the text says but not clearly enough
  additional: string[];                        // what the seller said that fits no field
  /** Fields the rules and the model read differently, with the value kept and the one dropped (read.ts). */
  conflicts: { field: string; kept: unknown; dropped: unknown }[];
};

export function emptyAssessment(reader: Assessment['reader']): Assessment {
  return {
    reader, vin: null, vehicle: { year: null, make: null, model: null, trim: null },
    title_status: 'unknown', title_state: null, title_in_hand: 'unknown', lien: 'unknown',
    mileage: null, odometer_status: 'unknown', region: null, zip: null, seller_type: 'unknown', lanes_allowed: null,
    run_status: 'unknown', keys: 'unknown', engine_condition: 'unknown', transmission_condition: 'unknown', drivetrain: 'unknown', fuel_type: 'unknown',
    primary_damage: 'unknown', secondary_damage: 'unknown',
    grades: PARTS.map((part) => ({ part, grade: 'unknown' as const })),
    flags: { airbags_deployed: 'unknown', frame_suspected: 'unknown', fluid_leak: 'unknown', flood_suspected: 'unknown', fire_damage: 'unknown' },
    catalytic_converter: 'unknown', parts_missing: 'unknown', already_repaired: 'unknown',
    warning_lights: [], codes: [], symptoms: [],
    values: { clean_wholesale: null, salvage_comps: [], purchase_price: null, repair_estimate: null, reserve_price: null },
    storage_cost_per_day: null, sell_by_days: null,
    evidence: {}, expected: [], precision: { expected: 0, given: 0, level: 'low', note: null }, missing: [], could_add: [], questions: [], additional: [], conflicts: [],
  };
}

/** One fact the reader expects a description to give. */
interface Expectation {
  /** Path of the field in the Assessment. */
  field: string;
  /** How to ask the seller for it. */
  ask: (a: Assessment) => string;
  /** needed: the decision leans on it. helpful: it sharpens the decision. */
  need: 'needed' | 'helpful';
  given: (a: Assessment) => boolean;
  /** Only expected when this holds (e.g. "is the mileage actual" needs a mileage). */
  when?: (a: Assessment) => boolean;
}
const graded = (a: Assessment) => a.grades.filter((g) => g.grade !== 'unknown').length;

/** Everything the reader expects to find, in the order the page asks for it. */
export const EXPECTED: readonly Expectation[] = [
  { field: 'title_status', need: 'needed', ask: () => 'the title status (clean, salvage, rebuilt, flood, non-repairable or lemon)', given: (a) => a.title_status !== 'unknown' },
  { field: 'values.clean_wholesale', need: 'needed', ask: () => 'the clean wholesale value (same year, model and mileage, no damage)', given: (a) => a.values.clean_wholesale !== null },
  { field: 'values.salvage_comps', need: 'needed', ask: (a) => `sold prices of at least 3 similar damaged vehicles (${a.values.salvage_comps.length} so far)`, given: (a) => a.values.salvage_comps.length >= 3 },
  { field: 'mileage', need: 'needed', ask: () => 'the mileage', given: (a) => a.mileage !== null },
  { field: 'grades', need: 'needed', ask: () => 'what is damaged, part by part, or "no damage"', given: (a) => graded(a) > 0 },
  { field: 'grades.rest', need: 'needed', ask: () => 'whether the rest of the vehicle is undamaged ("everything else is fine")', given: (a) => graded(a) === PARTS.length || a.evidence['grades.rest'] !== undefined, when: (a) => graded(a) > 0 },
  { field: 'flags.airbags_deployed', need: 'needed', ask: () => 'whether the airbags deployed', given: (a) => a.flags.airbags_deployed !== 'unknown' },
  { field: 'flags.frame_suspected', need: 'needed', ask: () => 'whether the frame is damaged', given: (a) => a.flags.frame_suspected !== 'unknown' },
  { field: 'flags.fluid_leak', need: 'needed', ask: () => 'whether any fluids are leaking', given: (a) => a.flags.fluid_leak !== 'unknown' },
  { field: 'seller_type', need: 'helpful', ask: () => 'who is selling (dealer, insurer, fleet, lender or private owner)', given: (a) => a.seller_type !== 'unknown' },
  { field: 'title_in_hand', need: 'helpful', ask: () => 'whether the title is in hand', given: (a) => a.title_in_hand !== 'unknown' },
  { field: 'lien', need: 'helpful', ask: () => 'whether there is an open lien', given: (a) => a.lien !== 'unknown' },
  { field: 'odometer_status', need: 'helpful', ask: () => 'whether the mileage is actual', given: (a) => a.odometer_status !== 'unknown', when: (a) => a.mileage !== null },
  { field: 'run_status', need: 'helpful', ask: () => 'whether it runs and drives', given: (a) => a.run_status !== 'unknown' },
  { field: 'keys', need: 'helpful', ask: () => 'whether the keys are with it', given: (a) => a.keys !== 'unknown' },
  { field: 'engine_condition', need: 'helpful', ask: () => 'the engine condition', given: (a) => a.engine_condition !== 'unknown' },
  { field: 'transmission_condition', need: 'helpful', ask: () => 'the transmission condition', given: (a) => a.transmission_condition !== 'unknown' },
  { field: 'primary_damage', need: 'helpful', ask: () => 'where the main damage is (front, rear, side, hail, water, fire...)', given: (a) => a.primary_damage !== 'unknown' },
  { field: 'flags.flood_suspected', need: 'helpful', ask: () => 'whether there are any flood signs', given: (a) => a.flags.flood_suspected !== 'unknown' },
  { field: 'catalytic_converter', need: 'helpful', ask: () => 'whether the catalytic converter is present', given: (a) => a.catalytic_converter !== 'unknown' },
  { field: 'values.repair_estimate', need: 'helpful', ask: () => 'a repair quote, if you have one', given: (a) => a.values.repair_estimate !== null },
  { field: 'values.reserve_price', need: 'helpful', ask: () => 'the lowest price you would accept', given: (a) => a.values.reserve_price !== null },
  { field: 'region', need: 'helpful', ask: () => 'the state the vehicle is in', given: (a) => a.region !== null },
];

/**
 * Say what the reader was expecting and what it got: `expected` (every expected fact, given or not),
 * `missing` (needed, not given), `could_add` (helpful, not given) and `precision` (how much of the
 * expected input is there, with the sentence to show when the answer will be less precise).
 */
export function listMissing(a: Assessment): void {
  a.expected = EXPECTED.filter((e) => !e.when || e.when(a)).map((e) => ({ field: e.field, need: e.need, given: e.given(a), ask: e.ask(a) }));
  const open = a.expected.filter((e) => !e.given);
  a.missing = open.filter((e) => e.need === 'needed').map((e) => e.ask);
  a.could_add = open.filter((e) => e.need === 'helpful').map((e) => e.ask);
  const level = a.missing.length > 0 ? 'low' : a.could_add.length > 0 ? 'reduced' : 'full';
  a.precision = {
    expected: a.expected.length,
    given: a.expected.length - open.length,
    level,
    note: level === 'full' ? null
      : `The answer wouldn't be as precise: ${open.length} of the ${a.expected.length} facts the reader was expecting were not given${a.missing.length ? ` (${a.missing.length} of them needed for the decision)` : ''}.`,
  };
}

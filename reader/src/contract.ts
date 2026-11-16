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
  missing: string[];                           // what the decision cannot run without
  could_add: string[];                         // what would sharpen the decision
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
    evidence: {}, missing: [], could_add: [], questions: [], additional: [], conflicts: [],
  };
}

/** Fill `missing` (the decision needs these) and `could_add` (these sharpen it) from what is still unknown. */
export function listMissing(a: Assessment): void {
  const graded = a.grades.filter((g) => g.grade !== 'unknown').length;
  const m: string[] = [];
  if (a.title_status === 'unknown') m.push('the title status (clean, salvage, rebuilt, flood, non-repairable or lemon)');
  if (a.values.clean_wholesale === null) m.push('the clean wholesale value (same year, model and mileage, no damage)');
  if (a.values.salvage_comps.length < 3) m.push(`sold prices of at least 3 similar damaged vehicles (${a.values.salvage_comps.length} so far)`);
  if (a.mileage === null) m.push('the mileage');
  if (graded === 0) m.push('what is damaged, part by part, or "no damage"');
  else if (graded < PARTS.length && a.evidence['grades.rest'] === undefined) m.push('whether the rest of the vehicle is undamaged ("everything else is fine")');
  if (a.flags.airbags_deployed === 'unknown') m.push('whether the airbags deployed');
  if (a.flags.frame_suspected === 'unknown') m.push('whether the frame is damaged');
  if (a.flags.fluid_leak === 'unknown') m.push('whether any fluids are leaking');
  a.missing = m;

  const c: string[] = [];
  if (a.seller_type === 'unknown') c.push('who is selling (dealer, insurer, fleet, lender or private owner)');
  if (a.title_in_hand === 'unknown') c.push('whether the title is in hand');
  if (a.lien === 'unknown') c.push('whether there is an open lien');
  if (a.mileage !== null && a.odometer_status === 'unknown') c.push('whether the mileage is actual');
  if (a.run_status === 'unknown') c.push('whether it runs and drives');
  if (a.keys === 'unknown') c.push('whether the keys are with it');
  if (a.engine_condition === 'unknown') c.push('the engine condition');
  if (a.transmission_condition === 'unknown') c.push('the transmission condition');
  if (a.primary_damage === 'unknown') c.push('where the main damage is (front, rear, side, hail, water, fire...)');
  if (a.flags.flood_suspected === 'unknown') c.push('whether there are any flood signs');
  if (a.catalytic_converter === 'unknown') c.push('whether the catalytic converter is present');
  if (a.values.repair_estimate === null) c.push('a repair quote, if you have one');
  if (a.values.reserve_price === null) c.push('the lowest price you would accept');
  if (a.region === null) c.push('the state the vehicle is in');
  a.could_add = c;
}

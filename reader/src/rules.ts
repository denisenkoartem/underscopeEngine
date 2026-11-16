// The free reader: a seller's description -> the assessment JSON (contract.ts), by keyword rules.
// No AI, no network, no cost. Every value comes with the words it was read from (`evidence`); what the
// text does not say stays unknown; sentences nothing was read from are kept in `additional`.
// The page calls it through POST /api/parse-notes as the seller types.
import { PARTS, emptyAssessment, listMissing, type Assessment, type CodeStatus, type DamageArea, type GradeName, type Part, type SymptomSystem, type TitleStatus, type Tri, type WarningLight } from './contract.js';

// ---- Vocabulary ----
const TITLE_WORD: [RegExp, TitleStatus][] = [
  [/non[- ]?repairable|junk|parts[- ]only|certificate of destruction/, 'non_repairable'],
  [/flood|water[- ]damage/, 'flood'],
  [/rebuilt|reconstructed|prior salvage/, 'rebuilt'],
  [/salvage/, 'salvage'],
  [/lemon|buy[- ]?back/, 'lemon'],
  [/clean|clear/, 'clean'],
];
const TITLE_ALT = 'non[- ]?repairable|junk|parts[- ]only|flood|water[- ]damage|rebuilt|reconstructed|prior salvage|salvage|lemon|buy[- ]?back|clean|clear';
const STATE_GAP = '(?:(?:[a-z]{2}|new (?:york|jersey|mexico|hampshire)|north (?:carolina|dakota)|south (?:carolina|dakota)|west virginia|rhode island|[a-z]{4,13})\\s+)?';
const TITLE_RE = new RegExp(`\\b(${TITLE_ALT})\\s+${STATE_GAP}(?:title|brand(?:ed)?|certificate)\\b|\\btitle(?:\\s+status)?\\s*(?:is|was|:|=|-)?\\s*(?:a\\s+)?(?:branded\\s+)?(${TITLE_ALT})\\b|\\b(certificate of destruction|lemon (?:law )?buy[- ]?back)\\b`, 'i');

const GRADE_WORDS: [GradeName, RegExp][] = [
  ['unknown', /\b(?:not (?:been )?(?:checked|inspected|seen|visible|looked at)|unknown|not sure|unsure|can'?t (?:see|tell)|haven'?t (?:checked|looked|seen)|didn'?t (?:check|look))\b/g],
  ['fine', /\b(?:no|not|without|zero|free of)\s+(?:any\s+)?(?:visible\s+)?(?:damaged?|dents?|scratch(?:es|ed)?|cracks?|cracked|broken|issues?|problems?)\b|\b(?:fine|ok|okay|good|intact|undamaged|perfect|untouched|straight|like new)\b/g],
  ['replace', /\b(?:replac\w*|missing|gone|destroyed|smashed|shattered|crushed|totaled|torn off|ripped off|broken|busted|blown|caved in|needs? (?:a )?new|flat|deployed)\b/g],
  ['repairable', /\b(?:dent\w*|ding\w*|scratch\w*|scuff\w*|scrap\w+|chip\w*|crack\w*|bent|crease\w*|repair\w*|fix\w*|damaged?|rust\w*|hail|pushed in|loose|hanging|torn|stain\w*|worn|curb(?:ed)? rash)\b/g],
];
const NEG_BEFORE = /\b(?:no|not|never|nothing|without|none|zero|isn'?t|wasn'?t|aren'?t|didn'?t|did not|doesn'?t|does not|don'?t|free of)\b[^,;.]{0,28}$/;
const UNSURE = /\b(?:not sure|unsure|don'?t know|do not know|unknown|can'?t tell|cannot tell|maybe|possibl[ey]|might|not checked|haven'?t checked)\b|\?/;
const NEG_AFTER = /^[^,;.]{0,28}\b(?:not|never|none|didn'?t|did not|intact|ok|okay|fine|good|straight)\b/;

const SIDE = '(?:(left|driver(?:\'?s)?(?:[- ]side)?|lh|right|passenger(?:\'?s)?(?:[- ]side)?|rh|both)\\s+)?';
// noun pattern -> part, or for sided parts the name after left_/right_. Checked in order; longer names first.
const SIDED: [RegExp, string][] = [
  [/head\s?l(?:ight|amp)s?/, 'headlight'], [/tail\s?l(?:ight|amp)s?|brake lights?/, 'taillight'],
  [/(?:side[- ]?|door\s|wing\s)?mirrors?/, 'mirror'],
  [/quarter(?:\s?panels?)?|rear fenders?|bed\s?sides?/, 'rear_quarter'],
  [/rear (?:passenger |driver )?doors?|back doors?/, 'rear_door'],
  [/(?:front )?fenders?/, 'front_fender'], [/(?:front )?doors?/, 'front_door'],
];
const PLAIN: [RegExp, Part | 'bumper'][] = [
  [/front bumper(?: cover)?/, 'front_bumper'], [/rear bumper(?: cover)?|back bumper/, 'rear_bumper'], [/bumpers?/, 'bumper'],
  [/hood|bonnet/, 'hood'], [/grill?e?/, 'grille'], [/windshield|windscreen|front glass/, 'windshield'],
  [/tail\s?gate|lift\s?gate|trunk(?: lid)?|deck\s?lid|hatch(?:back)?|barn doors?|cargo doors?/, 'tailgate_or_rear_doors'],
  [/wheels?|tires?|tyres?|rims?/, 'wheels_and_tires'], [/roof/, 'roof'],
  [/interior|seats?|dash(?:board)?|upholstery|carpets?|headliner/, 'interior'],
  [/engine (?:bay|compartment)|radiator(?: support)?|core support|condenser|intercooler/, 'engine_bay'],
  [/underbody|undercarriage|frame rails?|sub\s?frame|exhaust|muffler|skid plate/, 'underbody'],
];
const PART_RE = new RegExp(
  `(?<![a-z])${SIDE}(?:(front|rear|back)\\s+)?${SIDE}(?:(${SIDED.map(([r]) => r.source).join('|')})|(${PLAIN.map(([r]) => r.source).join('|')}))\\b`, 'gi');

const STATES: Record<string, string> = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };
const STATE_CODES = new Set(Object.values(STATES));


// ---- Vocabulary for the 2026-11-16 criteria. Checked in order; the first match in the first sentence wins. ----
type Table<T extends string> = [RegExp, T][];
const TITLE_IN_HAND: Table<'yes' | 'no'> = [
  [/\bno title\b|\btitle (?:is |was )?(?:absent|missing|lost|pending|delayed|not (?:in hand|here|available|present|ready))|\bwaiting (?:on|for) (?:the |a )?title|\blost (?:the )?title|\btitle (?:is )?(?:at|with) the (?:bank|lender|lienholder|dmv)|\btitle (?:is )?in the mail|\b(?:don'?t|do not) have (?:the |a )?title/, 'no'],
  [/\btitle (?:is |are )?(?:in|on) hand\b|\b(?:have|has|got|with) (?:the |a )?(?:clean |clear |salvage |rebuilt )?title\b|\btitle (?:is )?(?:here|present|ready|available|attached)\b/, 'yes'],
];
const LIEN: Table<'none' | 'open'> = [
  [/\bnot paid off\b|\bstill owes?\b/, 'open'],
  [/\bno liens?\b|\blien[- ]free\b|\bfree and clear\b|\bpaid off\b|\blien (?:was |is |has been )?(?:released|satisfied|cleared|paid)|\bwithout (?:a |any )?liens?\b/, 'none'],
  [/\b(?:open|active|outstanding|existing|unpaid) liens?\b|\b(?:has|have|is|with|there is) (?:a|an) liens?\b|\blien on (?:it|the|this)\b|\bstill owes?\b|\bloan (?:balance|on it)\b|\bpayoff\b|\bnot paid off\b|\b(?:bank|lender) holds\b/, 'open'],
];
const ODOMETER_STATUS: Table<'actual' | 'not_actual' | 'exempt'> = [
  [/\bnot actual\b|\btmu\b|\btrue (?:miles?|mileage) unknown\b|\bodometer (?:was |is |has been )?(?:rolled back|broken|replaced|not working|inaccurate)|\bodometer (?:rollback|discrepancy)|\bcluster (?:was |has been )?(?:swapped|replaced)|\bmileage (?:is )?(?:unknown|not verified)/, 'not_actual'],
  [/\bexempt\b/, 'exempt'],
  [/\bactual (?:miles?|mileage)\b|\b(?:miles?|mileage) (?:is |are )?actual\b/, 'actual'],
];
const SELLER_TYPE: Table<'dealer' | 'insurer' | 'fleet' | 'lender' | 'individual'> = [
  [/\binsurance (?:company |carrier )?(?:sale|vehicle|total loss)\b|\bselling (?:it )?for (?:an? |the )?insur\w+|\binsurer is selling\b|\btotal loss claim\b|\bclaims? adjuster\b/, 'insurer'],
  [/\b(?:repo|repossess\w*|bank[- ]owned|lender is selling)\b/, 'lender'],
  [/\b(?:fleet|ex[- ]rental|rental (?:car|unit|company)|company (?:truck|car|van|vehicle))\b/, 'fleet'],
  [/\b(?:dealer(?:ship)?|trade[- ]in|(?:on|off) our lot)\b(?! auctions?| sales?)/, 'dealer'],
  [/\bprivate (?:seller|party|owner|sale)\b|\bpersonal (?:car|truck|vehicle)\b|\bi am the owner\b|\bowner selling\b|\bselling it myself\b/, 'individual'],
];
const KEYS: Table<'yes' | 'no'> = [
  [/\bno keys?\b|\bwithout (?:a |the |any )?keys?\b|(?<!spare )\bkeys? (?:are |is |were )?(?:missing|lost|gone)\b|\blost (?:the )?keys?\b|\bmissing (?:the )?keys?\b/, 'no'],
  [/\b(?:with|has|have|two|2|both|one|1|all) keys?\b|\bkeys? (?:are |is )?(?:present|included|available|in hand|with it|here)\b|\bkey (?:and|\+) fob\b|\bkey fob\b/, 'yes'],
];
const ENGINE: Table<'ok' | 'minor' | 'failed'> = [
  [/\b(?:engine|motor) (?:is |was )?(?:seized|blown|locked(?: up)?|dead|toast|shot|failed|done|gone)\b|\bblown (?:engine|motor|head gasket)\b|\brod knock\b|\bthrown? (?:a )?rod\b|\bno compression\b|\bneeds (?:an? )?(?:new |replacement )?(?:engine|motor)\b|\bhydro[- ]?locked\b|\bengine failure\b/, 'failed'],
  [/\bmisfir\w*|\brough idle\b|\bengine (?:knocks?|ticks?|smokes?|leaks?)\b|\b(?:oil|coolant) leak\b|\bburns oil\b|\bticking\b|\boverheat\w*|\b(?:white|blue|black) smoke\b|\bloses power\b/, 'minor'],
  [/\b(?:engine|motor) (?:is |runs |sounds )?(?:fine|good|strong|ok|okay|great|smooth|healthy|solid)\b|\bengine and trans\w* (?:are |both )?(?:fine|good|ok|okay|strong|solid)\b|\bno engine (?:issues|problems)\b/, 'ok'],
];
const TRANSMISSION: Table<'ok' | 'minor' | 'failed'> = [
  [/\btrans\w* (?:is |was )?(?:gone|shot|failed|blown|dead|bad|out|done)\b|\bno (?:reverse|drive gears?|gears?)\b|\bneeds (?:a )?(?:new |replacement )?trans\w*|\btransmission failure\b|\bwon'?t (?:shift|go into (?:drive|reverse))\b/, 'failed'],
  [/\btrans\w*[^.,;]{0,24}\b(?:slip\w*|whin\w*|nois\w*|jerk\w*|leak\w*|flar\w*|shudder\w*|smells? burnt|limp mode)|\bhard shift\w*|\bshifts? (?:hard|rough|late)\b/, 'minor'],
  [/\btrans\w* (?:is |shifts |works )?(?:fine|good|ok|okay|smooth\w*|strong|great|solid)\b|\bshifts (?:fine|good|smooth\w*|great|well)\b|\bengine and trans\w* (?:are |both )?(?:fine|good|ok|okay|strong|solid)\b/, 'ok'],
];
const DRIVETRAIN: Table<'fwd' | 'rwd' | 'awd' | '4wd'> = [
  [/\b(?:4x4|4wd|four[- ]wheel[- ]drive)\b/, '4wd'], [/\bawd\b|\ball[- ]wheel[- ]drive\b/, 'awd'],
  [/\bfwd\b|\bfront[- ]wheel[- ]drive\b/, 'fwd'], [/\brwd\b|\brear[- ]wheel[- ]drive\b/, 'rwd'],
];
const FUEL: Table<'gas' | 'diesel' | 'hybrid' | 'electric'> = [
  [/\bdiesel\b|\bduramax\b|\bcummins\b|\bpower ?stroke\b|\btdi\b/, 'diesel'], [/\bhybrid\b/, 'hybrid'],
  [/\belectric (?:vehicle|car|motor)\b|\b(?:fully|all)[- ]electric\b|\bev\b/, 'electric'],
  [/\bgas(?:oline)? (?:engine|motor|model|version)\b|\bgasoline\b|\bruns on gas\b/, 'gas'],
];
const CAT: Table<'present' | 'missing'> = [
  [/\b(?:cat(?:alytic converter)?s?|converters?) (?:is |was |has been |are |were |got )?(?:missing|stolen|cut (?:off|out)|gone|removed)\b|\bno cat(?:alytic converter)?s?\b|\b(?:stolen|missing) cat\w*/, 'missing'],
  [/\b(?:cat(?:alytic converter)?s?|converters?) (?:is |are )?(?:present|there|intact|still (?:on|there)|original|on it)\b|\b(?:has|have) (?:its|the|both|original) cat\w*/, 'present'],
];
const PARTS_MISSING: Table<'yes' | 'no'> = [
  [/\bnothing (?:is )?missing\b|\ball parts (?:are )?(?:there|present)\b|\bcomplete (?:car|vehicle|truck|van)\b|\bno parts? missing\b/, 'no'],
  [/\bparts? (?:are |is |were )?(?:missing|removed|stripped|pulled)\b|\b(?:partly |partially )?stripped\b|\bmissing (?:the )?(?:engine|motor|transmission|seats|wheels|radio|battery|ecu|stereo)\b|\b(?:engine|motor|transmission|battery|radio|seats|wheels|stereo|ecu)(?: and (?:the )?\w+)? (?:is |are |were |was )?(?:missing|removed|pulled)\b/, 'yes'],
];
const REPAIRED: Table<'yes' | 'partly' | 'no'> = [
  [/\bpart(?:ly|ially) (?:repaired|fixed)\b|\bpartial repairs?\b|\bsome (?:of the )?(?:repairs?|work) (?:is |are |was )?done\b|\brepairs? (?:were |was |are )?started\b|\bstarted (?:the )?repairs?\b|\bhalf (?:done|repaired|fixed)\b/, 'partly'],
  [/\bnot (?:been )?(?:repaired|fixed)\b|\bno repairs? (?:done|made|yet)\b|\bun-?repaired\b|\bhasn'?t been (?:fixed|repaired)\b|\bnothing (?:has been |was )?(?:fixed|repaired)\b/, 'no'],
  [/\balready (?:been )?(?:repaired|fixed)\b|\bhas been (?:repaired|fixed)\b|\brepairs? (?:are |is |were )?(?:done|complete\w*|finished)\b|\b(?:professionally|fully) repaired\b/, 'yes'],
];
const LANE_LIMIT: Table<'acv' | 'copart'> = [
  [/\bdealer (?:auctions?|sales?) only\b|\bacv only\b|\b(?:to )?dealers only\b|\bwholesale only\b/, 'acv'],
  [/\bsalvage (?:auctions?|buyers) only\b|\bcopart only\b|\bhas to go to (?:a )?salvage\b/, 'copart'],
];
const LIGHTS: Table<WarningLight> = [
  [/\bcheck engine(?: light)?\b|\bcel\b|\bengine light\b|\bservice engine\b/, 'check_engine'], [/\babs light\b|\babs (?:is )?on\b/, 'abs'],
  [/\bair ?bag (?:warning )?light\b|\bsrs light\b/, 'airbag'],
  [/\b(?:traction(?: control)?|tpms|tire pressure|battery|oil(?: pressure)?|brake|stability|4wd|awd) light\b|(?<!air ?bag )\bwarning lights? (?:is |are |stays? )?on\b|\bdash lights? (?:is |are )?(?:on|lit)\b/, 'other'],
];
// Where the damage is, in Copart's listing categories. Every match counts, in the order written.
const AREAS: Table<Exclude<DamageArea, 'unknown' | 'none'>> = [
  [/\bfront[- ]end\b|\bfront (?:hit|impact|collision|damage)\b|\bfront (?:and|&) rear\b|\b(?:hit|damage|damaged) (?:in|on|to) the front\b|\bhead[- ]on\b|\bhit (?:in|on) the front\b|\bfrontal\b/, 'front'],
  [/\brear[- ]end(?:ed)?\b|\brear (?:hit|impact|collision|damage)\b|\bhit from behind\b|\bbacked into\b/, 'rear'],
  [/\bside (?:hit|impact|damage|collision)\b|\bside[- ]?swip\w*|\bt[- ]bon\w*|\b(?:driver|passenger|left|right)(?:'?s)?[- ]side (?:hit|impact|damage)\b/, 'side'],
  [/\broll(?:ed)?[- ]?over\b|\brolled (?:it|the)\b|\bflipped\b/, 'rollover'],
  [/\b(?:damage|damaged|hit|dents?) all (?:over|around)\b|\ball[- ]over damage\b|\bevery panel\b/, 'all_over'],
  [/\bundercarriage (?:damage|hit)\b|\bunderbody damage\b|\bbottomed out\b/, 'undercarriage'],
  [/\bmechanical (?:damage|issues?|problems?|failure)\b|\b(?:engine|transmission) failure\b/, 'mechanical'],
  [/\bhail\b/, 'hail'], [/\bflood\w*|\bwater damage\b|\bsubmerged\b|\bunder ?water\b/, 'water'],
  [/(?<!won'?t |not |to )\bfire\b|\bburn(?:ed|t)\b/, 'fire'], [/\bvandal\w*|\bkeyed\b|\bbroken into\b/, 'vandalism'],
  [/\btheft\b|\b(?:was |got )?stolen\b/, 'theft'],
  [/\bminor (?:dents?|scratches|damage)\b|\bcosmetic (?:only|damage)\b|\blight scratches\b|\bparking lot (?:ding|scrape|scuff)\b/, 'minor'],
];

const SYMPTOM_RE = /\bnois\w*|\bslip\w*|\bknock\w*|\bsmok\w*|\bleak\w*|\bdrip\w*|\bvibrat\w*|\bshak\w*|\bpull(?:s|ing)\b|\bsqueal\w*|\bgrind\w*|\boverheat\w*|\bstall\w*|\bmisfir\w*|\bwhin\w*|\bclunk\w*|\bshudder\w*|\brough idle\b|\bhard shift\w*|\bshifts? (?:hard|rough|late)\b|\bwon'?t shift\b|\blimp mode\b|\bflicker\w*|\bdrains?\b|\b(?:doesn'?t|don'?t|not) work\w*|\bblows warm\b|\bticking\b|\bloses power\b|\bsoft (?:brake )?pedal\b/;
const SYSTEM_OF: [RegExp, SymptomSystem][] = [
  [/trans\w*|shift|gear|reverse|clutch|limp mode/, 'transmission'], [/brak|pedal/, 'brakes'],
  [/steer|suspension|pull|clunk|shak|vibrat|alignment|strut/, 'steering_suspension'],
  [/engine|motor|misfir|overheat|smok|knock|coolant|\boil\b|idle|stall|ticking|loses power/, 'engine'],
  [/electr|battery|light|window|wiring|flicker|drain|alternator/, 'electrical'], [/seat|dash|headliner|carpet/, 'interior'],
];

const MAKES: Record<string, string> = { acura: 'Acura', audi: 'Audi', bmw: 'BMW', buick: 'Buick', cadillac: 'Cadillac', chevrolet: 'Chevrolet', chevy: 'Chevrolet', chrysler: 'Chrysler', dodge: 'Dodge', fiat: 'Fiat', ford: 'Ford', genesis: 'Genesis', gmc: 'GMC', honda: 'Honda', hyundai: 'Hyundai', infiniti: 'Infiniti', jaguar: 'Jaguar', jeep: 'Jeep', kia: 'Kia', lexus: 'Lexus', lincoln: 'Lincoln', mazda: 'Mazda', mercedes: 'Mercedes-Benz', 'mercedes-benz': 'Mercedes-Benz', mini: 'Mini', mitsubishi: 'Mitsubishi', nissan: 'Nissan', porsche: 'Porsche', ram: 'Ram', subaru: 'Subaru', tesla: 'Tesla', toyota: 'Toyota', volkswagen: 'Volkswagen', vw: 'Volkswagen', volvo: 'Volvo' };
const TWO_WORD_MODEL = /^(?:grand (?:cherokee|caravan)|model [3sxy]|\d series|santa fe|land cruiser|town (?:and|&) country|range rover|transit connect|[a-z]+ \d{3,4}(?:hd)?)\b/i;
const VEHICLE_RE = new RegExp(`(?:\\b((?:19[89]|20[0-3])\\d)|'(\\d\\d))\\s+(${Object.keys(MAKES).join('|')})\\s+([A-Za-z0-9][\\w-]*(?:\\s+[A-Za-z0-9][\\w-]*)?)`, 'i');

/** OBD-II code shape inside free text (not part of a longer word). */
const OBD_IN_TEXT = /(?<![A-Za-z0-9])[PBCU][0-9A-F]{4}(?![A-Za-z0-9])/gi;

// ---- Helpers ----
const AMOUNT = '\\$?\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?k?\\b';
function amount(s: string): number {
  const k = /k\s*$/i.test(s);
  const n = Number(s.replace(/[$,\sk]/gi, ''));
  return Math.round(k ? n * 1000 : n);
}
export function vinCheckDigitOk(vin: string): boolean {
  const letters = 'ABCDEFGH.JKLMN.P.R.STUVWXYZ', weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  const val = (c: string) => (/\d/.test(c) ? Number(c) : (letters.indexOf(c) % 9) + 1); // A-H 1-8, J-R 1-9, S-Z 2-9
  const sum = [...vin].reduce((s, c, i) => s + val(c) * weights[i]!, 0) % 11;
  return vin[8] === (sum === 10 ? 'X' : String(sum));
}
const sideOf = (s?: string) => (!s ? null : /^(left|driver|lh)/i.test(s) ? 'left' : /^(right|passenger|rh)/i.test(s) ? 'right' : 'both');

// Three-way flag from the sentences that mention it: a negation near the keyword means false.
function flag(sentences: string[], keyword: RegExp, positive: RegExp | null, ev: Record<string, string>, key: string): Tri {
  for (const s of sentences) {
    const m = keyword.exec(s);
    if (!m) continue;
    const before = s.slice(0, m.index), after = s.slice(m.index + m[0].length);
    if (UNSURE.test(s)) { ev[key] = s.trim(); return 'unknown'; }
    if (NEG_BEFORE.test(before) || NEG_AFTER.test(after)) { ev[key] = s.trim(); return false; }
    if (!positive || positive.test(s)) { ev[key] = s.trim(); return true; }
  }
  return 'unknown';
}

// ---- Parser ----
export function readRules(text: string): Assessment {
  const ev: Record<string, string> = {};
  const questions: string[] = [];
  const used = new Set<number>();              // sentences something was read from
  const sentences = text.split(/(?<=[.!?])\s+(?=\S)|[;\n]+|\s[|/]\s|^\s*[-*\u2022]\s+/m).map((s) => s.trim()).filter(Boolean);
  const lower = sentences.map((s) => s.toLowerCase());
  const note = (key: string, i: number, quote?: string) => { ev[key] = (quote ?? sentences[i]!).trim(); used.add(i); };

  // VIN: 17 characters without I, O, Q, with both letters and digits.
  let vin: string | null = null;
  sentences.forEach((s, i) => {
    for (const m of s.toUpperCase().matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/g)) {
      if (vin || !/\d/.test(m[0]) || !/[A-Z]/.test(m[0])) continue;
      vin = m[0]; note('vin', i, m[0]);
      if (!vinCheckDigitOk(m[0])) questions.push(`The VIN ${m[0]} fails its check digit; one character may be mistyped.`);
    }
  });

  // Title brand.
  let title_status: TitleStatus = 'unknown';
  lower.forEach((s, i) => {
    const m = title_status === 'unknown' ? TITLE_RE.exec(s) : null;
    if (!m) return;
    const word = (m[1] ?? m[2] ?? m[3])!;
    title_status = TITLE_WORD.find(([re]) => re.test(word))![1];
    note('title_status', i, m[0]);
  });

  // Mileage: a number next to miles / odometer.
  let mileage: number | null = null;
  const MILES = new RegExp(`(${AMOUNT})\\s*(?:actual |original |exact |true )?(?:miles|mi\\b|mileage)|(?:mileage|odometer|odo)\\s*(?:is|of|reads|shows|:|=|-)?\\s*(${AMOUNT})`, 'i');
  const mileSpans: string[] = [];
  lower.forEach((s, i) => {
    const m = MILES.exec(s);
    if (!m) return;
    mileSpans.push(m[0]);
    if (mileage === null) { mileage = amount((m[1] ?? m[2])!); note('mileage', i, m[0]); }
  });

  // State: "in PA", "located in Ohio", "state: NY".
  let region: string | null = null;
  sentences.forEach((s, i) => {
    if (region || /\b(?:title|titled|ttl)\b[^,]{0,12}\b(?:in|from)\s+\S+\s*$|\b(?:title|titled|ttl)\s+(?:is\s+)?(?:in|from)\b/i.test(s) && !/\blocated\b|\bpickup\b|\bcar is in\b/i.test(s)) return;
    const code = /\b(?:in|from|state:?|located:?|location:?)\s+([A-Z]{2})\b/.exec(s);
    const name = new RegExp(`\\b(?:in|from|state:?|located:?|location:?)\\s+(${Object.keys(STATES).join('|')})\\b`, 'i').exec(s);
    if (code && STATE_CODES.has(code[1]!)) { region = code[1]!; note('region', i, code[0]); }
    else if (name) { region = STATES[name[1]!.toLowerCase()]!; note('region', i, name[0]); }
  });

  // Run status.
  let run_status: Assessment['run_status'] = 'unknown';
  lower.forEach((s, i) => {
    if (run_status !== 'unknown') return;
    const no = /\b(?:(?:does ?n[o']t|won'?t|will not|doesnt|wont|no) (?:start|run|crank|turn over)|non[- ]?runn(?:er|ing)|not running|no[- ]start|dead engine|engine (?:is )?(?:seized|blown|locked)|towed in|needs a tow)\b/.exec(s);
    const stuck = /\b(?:starts?|runs?|idles)\b[^.]{0,30}\b(?:won'?t (?:move|drive|go into gear)|no drive|(?:does|will) not drive|doesn'?t (?:move|drive))\b/.exec(s);
    const drives = /\b(?:runs?|starts?) ?(?:and|&|\+|\/) ?drives?\b|\bdrives? (?:fine|well|good|ok|okay|great|straight)\b|\bdrivable\b|\bdriveable\b|\br&d\b|\bdaily driver\b|\bdrove it\b|\bstill drives\b|\bruns? n drives?\b|\bruns?\b[^.;]{0,25}\bdrives\b/.exec(s);
    const starts = /\b(?:starts|runs|running(?! \$)|turns on|idles)\b/.exec(s);
    const m = no ?? stuck ?? drives ?? starts;
    if (!m) return;
    run_status = no ? 'does_not_start' : stuck ? 'starts' : drives ? 'runs_and_drives' : 'starts';
    note('run_status', i, m[0]);
  });

  // Other dollar amounts: what was paid, a repair quote, the lowest price accepted, storage per day.
  // Their words are set aside so the clean value and the comps below do not pick the same numbers up.
  const price = (key: string, re: RegExp): number | null => {
    for (let i = 0; i < lower.length; i++) {
      const m = re.exec(lower[i]!);
      const raw = m && (m[1] ?? m[2]);
      if (!m || !raw || amount(raw) < (key === 'storage_cost_per_day' ? 1 : 100)) continue;
      mileSpans.push(m[0]);
      note(key, i, m[0]);
      return amount(raw);
    }
    return null;
  };
  const storage_cost_per_day = price('storage_cost_per_day', new RegExp(`(${AMOUNT})\\s*(?:\\/|per|a|each)\\s*day\\b|\\bstorage[^\\d$.;]{0,25}(${AMOUNT})`, 'i'));
  const purchase_price = price('values.purchase_price', new RegExp(`\\b(?:paid|bought (?:it |this )?for|purchase price|purchased (?:it )?for|got it for|picked it up for)[^\\d$.;]{0,20}(${AMOUNT})`, 'i'));
  const repair_estimate = price('values.repair_estimate', new RegExp(`\\b(?:quot\\w+|estimat\\w+|repair costs?|cost to (?:fix|repair))[^\\d$.;]{0,30}(${AMOUNT})|(${AMOUNT})\\s+(?:to (?:fix|repair)|in repairs?|repair (?:quote|estimate))`, 'i'));
  const reserve_price = price('values.reserve_price', new RegExp(`\\b(?:reserve|asking|won'?t (?:take|go|accept) (?:less than|below|under)|will not (?:take|accept) (?:less than|below|under)|no less than|need (?:to get )?at least|lowest (?:i'?ll|we'?ll|i will|we will)? ?(?:go|take|accept)?(?: is)?|minimum (?:price|bid)|floor(?: price)?)[^\\d$.;]{0,20}(${AMOUNT})`, 'i'));

  // Market values. Clean value: the amount next to "clean / wholesale / book value". Comps: every amount
  // after "comps / similar ones sold for / salvage lots" up to the end of the sentence.
  let clean_wholesale: number | null = null;
  const salvage_comps: number[] = [];
  const CLEAN_KEY = '(?:clean(?:\\s+(?:wholesale|retail|trade[- ]in|book|market))?\\s+(?:value|price)|wholesale(?:\\s+(?:value|price))?|book value|market value|mmr|kbb|blue book|worth)';
  const CLEAN_RE = new RegExp(`${CLEAN_KEY}[^\\d$.;]{0,40}?(${AMOUNT})|(${AMOUNT})\\s+(?:clean|wholesale|book|retail)\\b(?! title)`, 'i');
  const COMPS_RE = /\b(?:comps?|comparables?|similar (?:ones|cars|trucks|vans|vehicles|lots|units)|same (?:model|truck|car|van)s?|salvage (?:lots|sales|auctions?|ones)|damaged (?:ones|lots)|sold (?:for|at)|went for|copart (?:sales|lots|prices))\b/;
  lower.forEach((s0, i) => {
    let s = s0;
    for (const span of mileSpans) s = s.replace(span, ' ');
    const comp = COMPS_RE.exec(s);
    const head = comp ? s.slice(0, comp.index) : s, tail = comp ? s.slice(comp.index) : '';
    const c = clean_wholesale === null ? CLEAN_RE.exec(head) ?? (comp ? null : CLEAN_RE.exec(s)) : null;
    if (c) { clean_wholesale = amount((c[1] ?? c[2])!); note('values.clean_wholesale', i, c[0]); }
    if (comp) {
      const found = [...tail.matchAll(new RegExp(AMOUNT, 'gi'))].map((m) => amount(m[0])).filter((n) => n >= 200);
      if (found.length) { salvage_comps.push(...found); note('values.salvage_comps', i, tail); }
    }
  });

  // Flags.
  // "Frame checked, straight" / "frame measured, within spec": a clean result after a comma.
  const frameOk = lower.findIndex((s) => /\bframe\b[^.;]{0,30}\b(?:straight|within spec|checked out)\b/.test(s) && !/\bnot (?:straight|within spec)\b/.test(s));
  const flags = {
    airbags_deployed: flag(lower, /air\s?bags?|\bsrs\b/, /deploy|blown|popped|went off|out\b|fired|open/, ev, 'flags.airbags_deployed'),
    frame_suspected: frameOk >= 0 ? (note('flags.frame_suspected', frameOk), false as Tri) : flag(lower, /\bframe\b|unibody|structural/, /bent|damag|suspect|kink|twist|tweak|buckl|crack|bad|hit|structural/, ev, 'flags.frame_suspected'),
    fluid_leak: flag(lower, /\bleak\w*|\bdrip\w*|puddle/, null, ev, 'flags.fluid_leak'),
    flood_suspected: flag(lower, /\bflood\w*|water (?:damage|line|intrusion)|submerged|under ?water|musty|damp carpets?|\bsilt\b/, null, ev, 'flags.flood_suspected'),
    fire_damage: flag(lower, /(?<!won'?t |not |to )\bfire\b|\bburn(?:ed|t)\b|scorch\w*|smoke damage|melted/, null, ev, 'flags.fire_damage'),
  };
  lower.forEach((s, i) => { if (/air\s?bags?|\bsrs\b|\bframe\b|unibody|structural|\bleak\w*|\bdrip\w*|puddle|\bflood\w*|water (?:damage|line)|musty|\bfire\b|\bburn(?:ed|t)\b/.test(s)) used.add(i); });

  // Part grades. A sentence is cut at commas and "but"; each part takes the nearest grade word in its
  // piece. A piece that names parts but no damage borrows the grade of the next graded piece, else the last one.
  const found = new Map<Part, GradeName>();
  const setGrade = (p: Part, g: GradeName, quote: string) => {
    const rank = { fine: 0, repairable: 1, replace: 2, unknown: -1 };
    if (!found.has(p) || rank[g] > rank[found.get(p)!]) { found.set(p, g); ev[`grades.${p}`] = quote.trim(); }
  };
  lower.forEach((sentence, i) => {
    const pieces = sentence.split(/,|\bbut\b|\bhowever\b/).map((text) => {
      const parts: { at: number; end: number; ids: Part[] }[] = [];
      for (const m of text.matchAll(PART_RE)) {
        const [word, side1, frontRear, side2, sidedNoun, plainNoun] = m;
        const at = m.index!, end = at + word!.length;
        if (plainNoun) {
          let id = PLAIN.find(([re]) => new RegExp(`^(?:${re.source})$`, 'i').test(plainNoun))![1];
          if (id === 'bumper') {
            if (/front/.test(frontRear ?? '')) id = 'front_bumper';
            else if (frontRear) id = 'rear_bumper';
            else if (/\bfront[- ]?(?:end|hit|impact|collision)|\bhead[- ]on\b/.test(sentence)) id = 'front_bumper';
            else if (/\brear[- ]?(?:end\w*|hit|impact|collision)|\bhit from behind\b/.test(sentence)) id = 'rear_bumper';
            else { questions.push('Which bumper is damaged, front or rear?'); used.add(i); continue; }
          }
          parts.push({ at, end, ids: [id as Part] });
          continue;
        }
        let name = SIDED.find(([re]) => new RegExp(`^(?:${re.source})$`, 'i').test(sidedNoun!))![1];
        if (name === 'front_door' && /rear|back/.test(frontRear ?? '')) name = 'rear_door';
        if (name === 'front_fender' && /rear|back/.test(frontRear ?? '')) name = 'rear_quarter';
        const plural = /s$/.test(sidedNoun!) && !/glass$/.test(sidedNoun!);
        const lr = /\b(?:left|driver\S*|lh)\s+(?:and|&|\+|or)\s+(?:right|passenger\S*|rh)\s+$|\b(?:right|passenger\S*|rh)\s+(?:and|&|\+|or)\s+$/i.test(text.slice(0, at + (side1 ?? '').length + 1)) ;
        const side = lr ? 'both' : sideOf(side1 ?? side2) ?? (plural ? 'both' : null);
        if (!side) { questions.push(`Which side is the ${word!.trim()} on, driver or passenger?`); used.add(i); continue; }
        const ids = (side === 'both' ? ['left', 'right'] : [side]).map((sd) => `${sd}_${name}` as Part);
        parts.push({ at, end, ids });
      }
      const grades: { at: number; end: number; grade: GradeName }[] = [];
      for (const [grade, re] of GRADE_WORDS) {
        for (const m of text.matchAll(re)) {
          if (grades.some((g) => m.index! < g.end && m.index! + m[0].length > g.at)) continue; // inside a longer match
          grades.push({ at: m.index!, end: m.index! + m[0].length, grade });
        }
      }
      return { text, parts, grades };
    });
    pieces.forEach((piece, k) => {
      if (!piece.parts.length) return;
      let grades = piece.grades;
      if (!grades.length) {
        // Only along an unbroken run of pieces that name parts ("bumper, hood and grille need replacing").
        const run = (list: typeof pieces) => { const stop = list.findIndex((p) => !p.parts.length); return (stop < 0 ? list : list.slice(0, stop)).find((p) => p.grades.length); };
        const next = run(pieces.slice(k + 1));
        const prev = run(pieces.slice(0, k).reverse());
        const src = next ?? prev;
        if (!src) return;
        grades = [src.grades[next ? 0 : src.grades.length - 1]!].map((g) => ({ ...g, at: 1e6, end: 1e6 }));
      }
      for (const part of piece.parts) {
        // distance from the part to each grade word; a word right after the part wins a tie
        const dist = (g: { at: number; end: number }) => (g.at >= part.end ? g.at - part.end : part.at - g.end + 0.5);
        const best = (grades.filter((g) => g.at >= part.end || g.end <= part.at).sort((a, b) => dist(a) - dist(b))[0] ?? grades[0])!;
        part.ids.forEach((id) => setGrade(id, best.grade, sentences[i]!));
        used.add(i);
      }
    });
  });
  // "Everything else is fine": parts not mentioned are undamaged, not unknown.
  const restIdx = lower.findIndex((s) => /\b(?:rest|everything else|all else|otherwise|other(?:wise)? (?:panels|parts))\b[^.]{0,40}\b(?:fine|ok|okay|good|clean|undamaged|straight|intact|perfect)\b|\bno other (?:damage|issues|problems)\b|\bno damage\b(?! to)|\bundamaged\b|\bnot damaged\b/.test(s));
  if (restIdx >= 0) note('grades.rest', restIdx);
  const grades = PARTS.map((part) => ({ part, grade: found.get(part) ?? (restIdx >= 0 ? 'fine' as const : 'unknown' as const) }));

  // ---- The 2026-11-16 criteria ----
  const choose = <T extends string>(key: string, table: Table<T>): T | 'unknown' => {
    for (let i = 0; i < lower.length; i++) for (const [re, value] of table) {
      const m = re.exec(lower[i]!);
      if (m) { note(key, i, m[0]); return value; }
    }
    return 'unknown';
  };
  const tri = (key: string, table: Table<'yes' | 'no'>): Tri => { const v = choose(key, table); return v === 'unknown' ? v : v === 'yes'; };

  const a = emptyAssessment('rules');
  Object.assign(a, { vin, title_status, mileage, region, run_status, grades });
  a.flags = flags;
  a.values = { clean_wholesale, salvage_comps, purchase_price, repair_estimate, reserve_price };
  a.storage_cost_per_day = storage_cost_per_day;

  // Year, make and model, when written together ("2018 Ford F-150", "'19 Chevy Malibu").
  sentences.forEach((s, i) => {
    const m = a.vehicle.year === null ? VEHICLE_RE.exec(s) : null;
    if (!m) return;
    const rest = m[4]!, two = TWO_WORD_MODEL.exec(rest);
    const model = two ? two[0] : rest.split(/\s+/)[0]!;
    a.vehicle = { year: m[1] ? Number(m[1]) : Number(m[2]) + (Number(m[2]) <= 30 ? 2000 : 1900), make: MAKES[m[3]!.toLowerCase()]!, model, trim: null };
    const quote = m[0].slice(0, m[0].length - rest.length + model.length);
    for (const k of ['year', 'make', 'model']) ev[`vehicle.${k}`] = quote;
    used.add(i);
  });

  // The state that issued the title: "clean NY title", "title from Florida", "titled in Ohio".
  const stateAlt = `[A-Z]{2}|${Object.keys(STATES).join('|')}`;
  const titleStateRe = new RegExp(`\\b(${stateAlt})\\s+(?:(?:${TITLE_ALT})\\s+)?title\\b|\\btitled?\\s+(?:is\\s+)?(?:from|in|issued in)\\s+(${stateAlt})\\b`, 'gi');
  sentences.forEach((s, i) => {
    for (const m of s.matchAll(titleStateRe)) {
      const w = (m[1] ?? m[2])!;
      // A two-letter code counts only in upper case ("my title" is not Montana... or any state).
      const code = w.length === 2 ? (w === w.toUpperCase() && STATE_CODES.has(w) ? w : null) : STATES[w.toLowerCase()] ?? null;
      if (code && !a.title_state) { a.title_state = code; note('title_state', i, m[0]); }
    }
  });
  sentences.forEach((s, i) => {
    const m = a.zip === null ? /\bzip(?:\s?code)?[:\s]+(\d{5})\b|\b[A-Z]{2},?\s+(\d{5})\b/i.exec(s) : null;
    if (m) { a.zip = (m[1] ?? m[2])!; note('zip', i, m[0]); }
  });

  a.title_in_hand = tri('title_in_hand', TITLE_IN_HAND);
  a.lien = choose('lien', LIEN);
  a.odometer_status = choose('odometer_status', ODOMETER_STATUS);
  a.seller_type = choose('seller_type', SELLER_TYPE);
  a.keys = tri('keys', KEYS);
  a.engine_condition = choose('engine_condition', ENGINE);
  a.transmission_condition = choose('transmission_condition', TRANSMISSION);
  a.drivetrain = choose('drivetrain', DRIVETRAIN);
  a.fuel_type = choose('fuel_type', FUEL);
  a.catalytic_converter = choose('catalytic_converter', CAT);
  a.parts_missing = tri('parts_missing', PARTS_MISSING);
  a.already_repaired = choose('already_repaired', REPAIRED);
  const lane = choose('lanes_allowed', LANE_LIMIT);
  a.lanes_allowed = lane === 'unknown' ? null : [lane];

  // Days left to sell: "must be gone in 10 days", "have 2 weeks to sell it".
  lower.forEach((s, i) => {
    const m = a.sell_by_days === null ? /\b(?:within|in|next|have|has)\s+(\d{1,3})\s+(days?|weeks?)\b(?=[^.]{0,30}\b(?:sell|sold|gone|move|out)\b)|\b(?:sell|sold|gone|moved?|out)\b[^.]{0,30}?\b(?:within|in|next)\s+(\d{1,3})\s+(days?|weeks?)\b/.exec(s) : null;
    if (m) { a.sell_by_days = Number(m[1] ?? m[3]) * (/week/.test((m[2] ?? m[4])!) ? 7 : 1); note('sell_by_days', i, m[0]); }
  });

  // Warning lights that are on (a "no warning lights" sentence lists none).
  lower.forEach((s, i) => {
    for (const [re, light] of LIGHTS) {
      const m = re.exec(s);
      if (!m || NEG_BEFORE.test(s.slice(0, m.index)) || /\b(?:off|not on|no longer on)\b/.test(s.slice(m.index)) || a.warning_lights.includes(light)) continue;
      a.warning_lights.push(light);
      note(`warning_lights.${light}`, i, m[0]);
    }
  });

  // Fault codes, as written. A code is confirmed unless "pending", "history", "past" or "cleared" follows it.
  sentences.forEach((s, i) => {
    for (const m of s.matchAll(OBD_IN_TEXT)) {
      const code = m[0].toUpperCase();
      if (a.codes.some((c) => c.code === code)) continue;
      const after = s.slice(m.index + code.length).split(/[,;.]|(?<![A-Za-z0-9])[PBCU][0-9A-F]{4}(?![A-Za-z0-9])/i)[0]!;
      const w = /\b(pending|history|past|cleared)\b/i.exec(after);
      const status: CodeStatus = !w ? 'confirmed' : w[1]!.toLowerCase() === 'pending' ? 'pending' : 'history';
      a.codes.push({ code, status });
      note(`codes.${code}`, i, m[0]);
    }
  });

  // Complaints in the seller's words: a sentence that names a noise, a leak, a slip, a light...
  sentences.forEach((s, i) => {
    const m = SYMPTOM_RE.exec(lower[i]!);
    if (!m || NEG_BEFORE.test(lower[i]!.slice(0, m.index)) || UNSURE.test(lower[i]!)) return;
    const system = SYSTEM_OF.find(([re]) => re.test(lower[i]!))?.[1] ?? 'other';
    // The clause that holds the complaint, not the whole sentence.
    let from = 0;
    const clause = s.split(/(,|\bbut\b)/i).find((piece) => (from += piece.length) > m.index) ?? s;
    a.symptoms.push({ system: SYSTEM_OF.find(([re]) => re.test(clause.toLowerCase()))?.[1] ?? system, text: clause.replace(/[.!?]+$/, '').trim() });
    used.add(i);
  });

  // Where the damage is: the areas the text names, in the order written.
  const areas: DamageArea[] = [];
  lower.forEach((s, i) => {
    const hits = AREAS.map(([re, area]) => ({ m: re.exec(s), area })).filter((h) => h.m).sort((x, y) => x.m!.index - y.m!.index);
    for (const { m, area } of hits) {
      if (areas.includes(area) || areas.length >= 2 || NEG_BEFORE.test(s.slice(0, m!.index)) || UNSURE.test(s)) continue;
      if (area === 'theft' && /\bcat\w*|converter/.test(s)) continue;
      note(areas.length === 0 ? 'primary_damage' : 'secondary_damage', i, m![0]);
      areas.push(area);
    }
  });
  // "No damage" is an answer too. A damaged part alone is not an area: the text has to name one.
  if (areas.length === 0 && restIdx >= 0 && found.size === 0 && /\bno (?:body )?damage\b|\bundamaged\b|\bnot damaged\b/.test(lower[restIdx]!)) { areas.push('none'); ev.primary_damage = ev['grades.rest']!; }
  a.primary_damage = areas[0] ?? 'unknown';
  a.secondary_damage = areas[1] ?? 'unknown';

  a.evidence = ev;
  a.questions = [...new Set(questions)];
  a.additional = sentences.filter((_, i) => !used.has(i));
  listMissing(a);
  return a;
}

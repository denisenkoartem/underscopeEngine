// Turns the collected texts in data/sample_user_inputs.jsonl into descriptions the reader can read
// far enough for the engine to route: npx tsx scripts/prepare-sample-inputs.ts [assessments-out.jsonl]
//
// The collected texts (NHTSA complaint narratives) describe what is wrong with a vehicle but never the
// title, the market value or what similar damaged vehicles sold for, and the engine cannot choose a
// marketplace without those. This script keeps each real narrative as it is and adds only the facts the
// reader could not find in it: the vehicle line, title, mileage, state, clean wholesale value and comps.
// Mileage and state come from NHTSA's own record of the complaint (meta.recorded) when it has them.
//
// THE ADDED FACTS ARE MADE UP (seeded by the line's id, so a re-run gives the same text). They are
// listed per line in meta.synthetic, and the untouched text stays in notes_original. The prices come
// from a rough depreciation curve, not from any market data.
//
// Each edited text is then read by the rules reader. meta.reader_ok says whether it read the added
// title, value and comps back exactly; meta.reader_missing is what it still asks for.
import { readFileSync, writeFileSync } from 'node:fs';
import { readRules } from '../reader/src/rules.ts';

const FILE = 'data/sample_user_inputs.jsonl';
const NOW_YEAR = 2026;
// Rough new-vehicle prices in dollars, only to scale the made-up values by model.
const NEW_PRICE: Record<string, number> = {
  'F-150': 48000, 'SILVERADO 1500': 47000, '1500': 47000, 'SIERRA 1500': 50000, CAMRY: 29000, CIVIC: 25000, ACCORD: 29000,
  COROLLA: 23000, ALTIMA: 27000, 'GRAND CHEROKEE': 42000, ESCAPE: 30000, RAV4: 31000, 'CR-V': 31000, EQUINOX: 29000,
  EXPLORER: 40000, SONATA: 27000, OPTIMA: 26000, OUTBACK: 32000, 'GRAND CARAVAN': 30000, PACIFICA: 40000, TRANSIT: 45000,
  ROGUE: 29000, WRANGLER: 38000, JETTA: 23000, 'MODEL 3': 42000,
};
const STATES = ['NY', 'PA', 'OH', 'TX', 'FL', 'CA', 'GA', 'IL', 'MI', 'NC', 'NJ', 'VA', 'AZ', 'TN', 'IN', 'MO', 'WI', 'CO'];
const TITLE_WORDS: Record<string, string> = { clean: 'Clean', salvage: 'Salvage', rebuilt: 'Rebuilt', flood: 'Flood', non_repairable: 'Non-repairable', lemon: 'Lemon buyback' };

// Small seeded generator (mulberry32) so the same id always gets the same made-up facts.
function rng(seedText: string) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, weighted: [T, number][]): T => {
  let x = r() * weighted.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of weighted) { if ((x -= w) < 0) return v; }
  return weighted[0]![0];
};
// A made-up VIN with the right maker prefix, model-year letter and check digit. Not a real car's VIN.
const WMI: Record<string, string> = { FORD: '1FA', CHEVROLET: '1G1', RAM: '1C6', TOYOTA: '4T1', HONDA: '1HG', NISSAN: '1N4', JEEP: '1C4', HYUNDAI: '5NP', KIA: '5XX', SUBARU: '4S4', DODGE: '2C4', CHRYSLER: '2C4', GMC: '1GT', VOLKSWAGEN: '3VW', TESLA: '5YJ' };
const YEAR_CODE = 'ABCDEFGHJKLMNPRSTVWXY123456789';   // 2010 = A
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
function makeVin(r: () => number, make: string, year: number): string {
  const some = (n: number) => Array.from({ length: n }, () => VIN_CHARS[Math.floor(r() * VIN_CHARS.length)]).join('');
  const digits = String(Math.floor(r() * 1e6)).padStart(6, '0');
  const v = [...`${WMI[make] ?? '1ZZ'}${some(5)}0${YEAR_CODE[(year - 2010) % YEAR_CODE.length]}${some(1)}${digits}`];
  const letters = 'ABCDEFGH.JKLMN.P.R.STUVWXYZ', weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = v.reduce((t, c, i) => t + (/\d/.test(c) ? Number(c) : (letters.indexOf(c) % 9) + 1) * weights[i]!, 0) % 11;
  v[8] = sum === 10 ? 'X' : String(sum);
  return v.join('');
}
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
const dollars = (n: number) => `$${n.toLocaleString('en-US')}`;

type Line = { id: string; notes: string; notes_original?: string; meta: Record<string, any>; [k: string]: unknown };
const lines: Line[] = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const assessments: unknown[] = [];
let ok = 0;
const missingCount: Record<string, number> = {};

for (const line of lines) {
  if (line.origin !== 'nhtsa_odi_complaint') continue;   // other sources are sale descriptions already: left as they are
  const original = line.notes_original ?? line.notes;
  const m = line.meta, r = rng(line.id);
  const before = readRules(original);                    // what the narrative already says
  const crashed = String(m.crash) === 'True' || String(m.fire) === 'True';
  const age = Math.max(0, NOW_YEAR - Number(m.year));

  const synthetic: Record<string, unknown> = {};
  // The page takes the VIN in its own field, so it is kept beside the text, not inside it.
  const vin = makeVin(rng(`${line.id}:vin`), m.make, Number(m.year));
  synthetic.vin = vin;
  line.vin = vin;
  const head: string[] = [`${m.year} ${m.make.length <= 3 ? m.make : titleCase(m.make)} ${titleCase(m.model)}.`];
  if (before.title_status === 'unknown') {
    const title = pick(r, crashed
      ? [['clean', 45], ['salvage', 33], ['rebuilt', 15], ['flood', 2], ['non_repairable', 5]]
      : [['clean', 84], ['rebuilt', 8], ['salvage', 5], ['lemon', 3]]);
    synthetic.title_status = title;
    head.push(`${TITLE_WORDS[title]} title.`);
  }
  // NHTSA narratives often end with "The failure mileage was 40,913": use that figure, do not invent one.
  const stated = /mileage (?:was|is)(?: approximately| about)? ([\d,]{3,})/i.exec(original);
  const made = Math.round((age * (8000 + r() * 8000) + 3000 + r() * 9000) / 100) * 100;
  // meta.recorded holds what NHTSA recorded with the complaint: real values come before made-up ones.
  const recorded = (m.recorded ?? {}) as { mileage_at_failure?: number | null; consumer_state?: string | null };
  const real = recorded.mileage_at_failure ?? (stated ? Number(stated[1]!.replace(/,/g, '')) : null);
  const mileage = before.mileage ?? real ?? made;
  if (before.mileage === null) {
    if (real === null) synthetic.mileage = mileage;
    head.push(`${mileage.toLocaleString('en-US')} miles.`);
  }
  if (before.region === null) {
    const known = recorded.consumer_state && /^[A-Z]{2}$/.test(recorded.consumer_state) ? recorded.consumer_state : null;
    const st = known ?? STATES[Math.floor(r() * STATES.length)]!;
    if (!known) synthetic.region = st;
    head.push(`Located in ${st}.`);
  }

  const tail: string[] = [];
  let clean = before.values.clean_wholesale;
  if (clean === null) {
    const wear = Math.max(0.55, 1 - Math.max(0, mileage - age * 12000) / 400000);
    clean = Math.max(1500, Math.round(((NEW_PRICE[m.model] ?? 30000) * 0.82 * 0.88 ** age * wear * (0.92 + r() * 0.16)) / 100) * 100);
    synthetic.clean_wholesale = clean;
    tail.push(`Clean wholesale value is ${dollars(clean)}.`);
  }
  if (before.values.salvage_comps.length < 3) {
    const [lo, hi] = crashed ? [0.15, 0.42] : [0.3, 0.62];
    const n = 3 + Math.floor(r() * 4);
    const comps = Array.from({ length: n }, () => Math.max(300, Math.round((clean! * (lo + r() * (hi - lo))) / 50) * 50)).sort((a, b) => a - b);
    synthetic.salvage_comps = comps;
    tail.push(`Similar damaged ones sold for ${comps.map(dollars).join(', ')}.`);
  }

  // The made-up facts go on their own lines so the reader never joins them to a sentence of the narrative.
  line.notes_original = original;
  line.notes = [head.join(' '), original, tail.join(' ')].filter(Boolean).join('\n');

  const a = readRules(line.notes);
  const want = { title: synthetic.title_status ?? before.title_status, clean, comps: synthetic.salvage_comps ?? before.values.salvage_comps };
  const readerOk = a.title_status === want.title && a.values.clean_wholesale === want.clean && JSON.stringify(a.values.salvage_comps) === JSON.stringify(want.comps);
  if (readerOk) ok++;
  for (const x of a.missing) { const k = x.replace(/\s*\(.*$/, ''); missingCount[k] = (missingCount[k] ?? 0) + 1; }
  line.meta = { ...m, synthetic, reader_ok: readerOk, reader_missing: a.missing };
  assessments.push({ id: line.id, reader_ok: readerOk, vin, vehicle: { year: String(m.year), make: m.make, model: m.model }, assessment: a });
}

writeFileSync(FILE, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
if (process.argv[2]) writeFileSync(process.argv[2], assessments.map((x) => JSON.stringify(x)).join('\n') + '\n');
console.log(`${assessments.length} NHTSA texts edited; the reader read the added title, value and comps back exactly in ${ok}.`);
console.log('Still asked for by the reader (texts):', missingCount);

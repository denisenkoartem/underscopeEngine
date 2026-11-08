// Fix-vs-sell-as-is decision (CLAUDE.md "Repair band", "As-is band", "Decision").
// Pure logic, no AI: cheap enough to rerun on every reviewer edit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---- Config: every assumption lives here ----
export const DECISION_CONFIG = {
  draws: 1000,
  fixAbove: 0.7,          // P(fix wins) above this -> "fix"
  sellBelow: 0.3,         // below this -> "sell as-is"; between -> "too close to call"
  minComps: 3,            // CLAUDE.md asks for 5-10; fewer than 3 is too thin to decide
  defaults: {             // seller inputs; the page can override each one
    labor_rate: 95,        // $/hour
    fix_days: 30,          // repair + resale
    as_is_days: 7,
    daily_cost: 20,        // holding cost per day
    fix_selling_fee: 450,  // selling the repaired vehicle
    as_is_fee: 350,        // salvage auction seller fee
    transport: 150,
  },
  paintPerPanel: [150, 400] as [number, number],
  conditionHaircut: [0.05, 0.12] as [number, number],  // repaired car vs. clean wholesale
  // After-repair value discount by title. Salvage/flood become rebuilt after repair (research doc: 20-40%).
  titleDiscount: {
    clean: [0, 0], rebuilt: [0.2, 0.4], salvage: [0.2, 0.4], flood: [0.3, 0.5], lemon: [0.15, 0.3], unknown: [0, 0.2],
  } as Record<string, [number, number]>,
  // Fixed amounts added to the TOP of the repair band, each recorded with its reason.
  widen: { frame_suspected: 3000, airbags_unknown: 1500, fluid_leak_unknown: 500, critical_code: 2000, many_unknown_parts: 1000 },
  manyUnknownParts: 5,
};

export type Grade = { part: string; grade: 'fine' | 'repairable' | 'replace' | 'unknown' };
type Tri = boolean | 'unknown';
export type Flags = { airbags_deployed?: Tri; frame_suspected?: Tri; fluid_leak?: Tri };
export type CodeIn = { code: string; description?: string; severity?: string; cost_low: number; cost_high: number };
export type DecideInput = {
  title_status?: string;
  grades: Grade[];
  flags?: Flags;
  codes?: CodeIn[];
  values?: { clean_wholesale?: number; salvage_comps?: number[] };
  assumptions?: Partial<typeof DECISION_CONFIG.defaults>;
};

type Line = { label: string; low: number; high: number };
type Widen = { key: string; reason: string; check: string; amount: number };
type Band = { low: number; high: number };
type Net = Band & { p10: number; p50: number; p90: number };

export type Decision = {
  repair: Band & { lines: Line[]; widen: Widen[] };
  arv: (Band & { title_discount: [number, number] }) | null;
  as_is: (Band & { comps: number }) | null;
  fix_net: Net | null;
  as_is_net: Net | null;
  days: { fix: number; as_is: number };
  p_fix: number | null;
  verdict: 'fix' | 'sell_as_is' | 'too_close' | 'not_fixable' | null;
  check: { label: string; p_fix_if_resolved: number } | null;
  missing: string[];
  assumptions: typeof DECISION_CONFIG.defaults;
};

// ---- Repair cost table (data/repair_costs.csv) ----
type CostRow = { parts_low: number; parts_high: number; labor_low: number; labor_high: number; paint: boolean };
let table: Map<string, CostRow> | null = null;
function costTable(): Map<string, CostRow> {
  if (table) return table;
  const [, ...lines] = readFileSync(join(process.cwd(), 'data', 'repair_costs.csv'), 'utf8').trim().split(/\r?\n/);
  table = new Map(lines.map((l) => {
    const [part, grade, pl, ph, ll, lh, paint] = l.split(',');
    return [`${part}:${grade}`, { parts_low: +pl, parts_high: +ph, labor_low: +ll, labor_high: +lh, paint: paint === 'yes' }];
  }));
  return table;
}

const label = (p: string) => p.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function partLine(part: string, grade: string, rate: number, note = ''): Line | null {
  const r = costTable().get(`${part}:${grade}`);
  if (!r) return null;
  const [pl, ph] = r.paint ? DECISION_CONFIG.paintPerPanel : [0, 0];
  return {
    label: `${label(part)}, ${grade}${note}`,
    low: Math.round(r.parts_low + r.labor_low * rate + pl),
    high: Math.round(r.parts_high + r.labor_high * rate + ph),
  };
}

export function repairBand(inp: DecideInput, rate: number): Decision['repair'] {
  const lines: Line[] = [];
  const grades = new Map(inp.grades.map((g) => [g.part, g.grade]));
  for (const [part, grade] of grades) {
    if (grade === 'repairable' || grade === 'replace') { const l = partLine(part, grade, rate); if (l) lines.push(l); }
  }
  const f = inp.flags ?? {};
  if (f.airbags_deployed === true && grades.get('interior') !== 'replace') {
    const l = partLine('interior', 'replace', rate, ' (airbags deployed)'); if (l) lines.push(l);
  }
  for (const c of inp.codes ?? []) {
    if (c.cost_high > 0) lines.push({ label: `${c.code}${c.description && c.description !== 'unknown' ? ` ${c.description}` : ''}`, low: c.cost_low, high: c.cost_high });
  }

  const W = DECISION_CONFIG.widen;
  const widen: Widen[] = [];
  if (f.frame_suspected === true) widen.push({ key: 'frame_suspected', reason: 'Frame damage suspected', check: 'Get a frame inspection', amount: W.frame_suspected });
  if (f.airbags_deployed === 'unknown') widen.push({ key: 'airbags_unknown', reason: "Can't tell if airbags deployed", check: 'Check whether the airbags deployed', amount: W.airbags_unknown });
  if (f.fluid_leak === 'unknown') widen.push({ key: 'fluid_leak_unknown', reason: "Can't tell if fluids are leaking", check: 'Check under the vehicle for fluid leaks', amount: W.fluid_leak_unknown });
  for (const c of inp.codes ?? []) {
    if (c.severity === 'critical') widen.push({ key: `critical_code:${c.code}`, reason: `${c.code} is critical`, check: `Have a mechanic diagnose ${c.code}`, amount: W.critical_code });
  }
  const unknownParts = [...grades.values()].filter((g) => g === 'unknown').length;
  if (unknownParts >= DECISION_CONFIG.manyUnknownParts) {
    widen.push({ key: 'many_unknown_parts', reason: `${unknownParts} parts not visible in the photos`, check: 'Photograph the parts that aren\'t visible', amount: W.many_unknown_parts });
  }

  const low = lines.reduce((s, l) => s + l.low, 0);
  const high = lines.reduce((s, l) => s + l.high, 0) + widen.reduce((s, w) => s + w.amount, 0);
  return { low, high, lines, widen };
}

// ---- Seeded random so the same inputs always give the same answer ----
function rng(seedText: string) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pct = (sorted: number[], p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
const net = (xs: number[]): Net => { const s = [...xs].sort((a, b) => a - b); return { low: Math.round(s[0]), high: Math.round(s[s.length - 1]), p10: pct(s, 0.1), p50: pct(s, 0.5), p90: pct(s, 0.9) }; };

function simulate(repair: Band, arv: Band, asIs: Band, a: typeof DECISION_CONFIG.defaults, seed: string) {
  // Separate streams: editing repair inputs never moves the as-is draws.
  const rf = rng(seed), rs = rng(JSON.stringify([asIs.low, asIs.high]));
  const u = (b: Band, r: () => number) => b.low + (b.high - b.low) * r();
  const fix: number[] = [], sell: number[] = [];
  let wins = 0;
  for (let i = 0; i < DECISION_CONFIG.draws; i++) {
    const f = u(arv, rf) - u(repair, rf) - a.fix_days * a.daily_cost - a.fix_selling_fee;
    const s = u(asIs, rs) - a.as_is_fee - a.transport;
    fix.push(f); sell.push(s); if (f > s) wins++;
  }
  return { p: wins / DECISION_CONFIG.draws, fix, sell };
}

export function decide(inp: DecideInput): Decision {
  const a = { ...DECISION_CONFIG.defaults, ...(inp.assumptions ?? {}) };
  const title = inp.title_status ?? 'unknown';
  const repair = repairBand(inp, a.labor_rate);
  const clean = inp.values?.clean_wholesale;
  const comps = (inp.values?.salvage_comps ?? []).filter((n) => Number.isFinite(n) && n > 0);
  const missing: string[] = [];
  if (!(clean && clean > 0)) missing.push('clean wholesale value');
  if (comps.length < DECISION_CONFIG.minComps) missing.push(`at least ${DECISION_CONFIG.minComps} comparable salvage sales`);

  const asIs = comps.length ? { low: Math.min(...comps), high: Math.max(...comps), comps: comps.length } : null;
  const disc = DECISION_CONFIG.titleDiscount[title] ?? DECISION_CONFIG.titleDiscount.unknown;
  const h = DECISION_CONFIG.conditionHaircut;
  const arv = clean && title !== 'non_repairable'
    ? { low: Math.round(clean * (1 - h[1]) * (1 - disc[1])), high: Math.round(clean * (1 - h[0]) * (1 - disc[0])), title_discount: disc }
    : null;
  const base = { repair, arv, as_is: asIs, days: { fix: a.fix_days, as_is: a.as_is_days }, missing, assumptions: a };

  if (missing.length || !asIs) return { ...base, fix_net: null, as_is_net: null, p_fix: null, verdict: null, check: null };

  const sellNet = (s: number[]) => net(s);
  if (title === 'non_repairable' || !arv) {
    const r = rng('asis'), s = Array.from({ length: DECISION_CONFIG.draws }, () => asIs.low + (asIs.high - asIs.low) * r() - a.as_is_fee - a.transport);
    return { ...base, fix_net: null, as_is_net: sellNet(s), p_fix: 0, verdict: 'not_fixable', check: null };
  }

  const seed = JSON.stringify([repair.low, repair.high, arv, asIs, a]);
  const sim = simulate(repair, arv, asIs, a, seed);
  const verdict = sim.p > DECISION_CONFIG.fixAbove ? 'fix' : sim.p < DECISION_CONFIG.sellBelow ? 'sell_as_is' : 'too_close';

  // Close call: which single check would move P(fix wins) the most if it came back clean?
  let check: Decision['check'] = null;
  if (verdict === 'too_close') {
    const candidates = repair.widen.map((w) => ({ label: w.check, repair: { low: repair.low, high: repair.high - w.amount }, arv }));
    if (title === 'unknown') {
      candidates.push({ label: 'Confirm the title status', repair, arv: { ...arv, low: Math.round(clean! * (1 - h[1])), high: Math.round(clean! * (1 - h[0])) } });
    }
    if (!candidates.length) candidates.push({ label: 'Get a written repair quote', repair: { low: (repair.low + repair.high) / 2 * 0.9, high: (repair.low + repair.high) / 2 * 1.1 }, arv });
    for (const c of candidates) {
      const p = simulate(c.repair, c.arv, asIs, a, seed).p;
      if (!check || Math.abs(p - sim.p) > Math.abs(check.p_fix_if_resolved - sim.p)) check = { label: c.label, p_fix_if_resolved: Math.round(p * 100) / 100 };
    }
  }

  return { ...base, fix_net: net(sim.fix), as_is_net: sellNet(sim.sell), p_fix: Math.round(sim.p * 100) / 100, verdict, check };
}

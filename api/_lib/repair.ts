// Repair estimate: what the damaged parts cost to put right, as a low-high range.
// A lookup in data/repair_costs.csv (part x grade -> parts cost, labor hours, paint) plus fixed
// allowances for what nobody has checked. No randomness and no market values: whether repairing pays
// is the engine's question (engine/, POST /api/route), which takes this estimate as its repair cost.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every number the estimate uses that is not in the CSV.
export const REPAIR_CONFIG = {
  laborRate: 95,                                       // $/hour, unless the caller gives one
  paintPerPanel: [150, 400] as [number, number],       // added per painted panel
  // Added to the TOP of the range only, each with its reason and the check that would remove it.
  allowance: { frame_suspected: 3000, airbags_unknown: 1500, fluid_leak_unknown: 500, many_unknown_parts: 1000 },
  manyUnknownParts: 5,                                 // this many ungraded parts triggers the last allowance
};

export type Grade = { part: string; grade: 'fine' | 'repairable' | 'replace' | 'unknown' };
type Tri = boolean | 'unknown';
export type Flags = { airbags_deployed?: Tri; frame_suspected?: Tri; fluid_leak?: Tri };
export type RepairInput = { grades: Grade[]; flags?: Flags; labor_rate?: number };

type Line = { label: string; low: number; high: number };
type Allowance = { key: string; reason: string; check: string; amount: number };
export type RepairEstimate = { low: number; high: number; lines: Line[]; allowances: Allowance[]; labor_rate: number };

type CostRow = { parts_low: number; parts_high: number; labor_low: number; labor_high: number; paint: boolean };
let table: Map<string, CostRow> | null = null;
function costTable(): Map<string, CostRow> {
  if (table) return table;
  const [, ...rows] = readFileSync(join(process.cwd(), 'data', 'repair_costs.csv'), 'utf8').trim().split(/\r?\n/);
  table = new Map(rows.map((row) => {
    const [part, grade, pl, ph, ll, lh, paint] = row.split(',');
    return [`${part}:${grade}`, { parts_low: +pl!, parts_high: +ph!, labor_low: +ll!, labor_high: +lh!, paint: paint === 'yes' }];
  }));
  return table;
}

const label = (part: string) => part.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function partLine(part: string, grade: string, rate: number, note = ''): Line | null {
  const row = costTable().get(`${part}:${grade}`);
  if (!row) return null;
  const [paintLow, paintHigh] = row.paint ? REPAIR_CONFIG.paintPerPanel : [0, 0];
  return {
    label: `${label(part)}, ${grade}${note}`,
    low: Math.round(row.parts_low + row.labor_low * rate + paintLow),
    high: Math.round(row.parts_high + row.labor_high * rate + paintHigh),
  };
}

export function repairEstimate(input: RepairInput): RepairEstimate {
  const rate = Number.isFinite(input.labor_rate) && input.labor_rate! >= 0 ? input.labor_rate! : REPAIR_CONFIG.laborRate;
  const grades = new Map(input.grades.map((g) => [g.part, g.grade]));
  const flags = input.flags ?? {};

  const lines: Line[] = [];
  for (const [part, grade] of grades) {
    if (grade !== 'repairable' && grade !== 'replace') continue;
    const line = partLine(part, grade, rate);
    if (line) lines.push(line);
  }
  // Deployed airbags mean the interior is replaced, even if the description graded it otherwise.
  if (flags.airbags_deployed === true && grades.get('interior') !== 'replace') {
    const line = partLine('interior', 'replace', rate, ' (airbags deployed)');
    if (line) lines.push(line);
  }

  const A = REPAIR_CONFIG.allowance;
  const allowances: Allowance[] = [];
  if (flags.frame_suspected === true) allowances.push({ key: 'frame_suspected', reason: 'Frame damage suspected', check: 'Get a frame inspection', amount: A.frame_suspected });
  if (flags.airbags_deployed === 'unknown') allowances.push({ key: 'airbags_unknown', reason: "Can't tell if airbags deployed", check: 'Check whether the airbags deployed', amount: A.airbags_unknown });
  if (flags.fluid_leak === 'unknown') allowances.push({ key: 'fluid_leak_unknown', reason: "Can't tell if fluids are leaking", check: 'Check under the vehicle for fluid leaks', amount: A.fluid_leak_unknown });
  const ungraded = [...grades.values()].filter((g) => g === 'unknown').length;
  if (ungraded >= REPAIR_CONFIG.manyUnknownParts) {
    allowances.push({ key: 'many_unknown_parts', reason: `${ungraded} parts not described`, check: "Describe or inspect the parts that aren't covered", amount: A.many_unknown_parts });
  }

  return {
    low: lines.reduce((sum, l) => sum + l.low, 0),
    high: lines.reduce((sum, l) => sum + l.high, 0) + allowances.reduce((sum, a) => sum + a.amount, 0),
    lines, allowances, labor_rate: rate,
  };
}

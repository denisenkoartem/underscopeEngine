// Runs each sample vehicle (public/demo_vehicles.json) the way the page does: its notes go through
// the parser, the parsed JSON through the decision. Fails if the parser reads something other than
// the sample's title, grades, flags or values, or if the verdict differs from "expect".
import { readFileSync } from 'node:fs';
import { readRules as parseNotes, vinCheckDigitOk } from '../reader/src/rules.ts';
import { PARTS } from '../reader/src/contract.ts';
import { decide } from '../api/_lib/decision.ts';

const { vehicles } = JSON.parse(readFileSync('public/demo_vehicles.json', 'utf8'));
const $ = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const range = (b: { p10: number; p90: number } | null) => (b ? `${$(b.p10)} to ${$(b.p90)}` : '-');

let failed = 0;
const rows = [];
for (const v of vehicles) {
  const p = parseNotes(v.notes);
  const flags = p.flags as Record<string, boolean | 'unknown'>;
  const diffs: string[] = [];
  if (!vinCheckDigitOk(v.vin)) diffs.push('VIN check digit');
  if (p.title_status !== v.title_status) diffs.push(`title ${p.title_status}`);
  for (const part of PARTS) {
    const got = p.grades.find((g) => g.part === part)!.grade, want = v.grades[part] ?? 'fine';
    if (got !== want) diffs.push(`${part} ${got} (want ${want})`);
  }
  for (const k of Object.keys(v.flags)) if (flags[k] !== v.flags[k]) diffs.push(`${k} ${flags[k]}`);
  if (JSON.stringify({ clean_wholesale: p.values.clean_wholesale, salvage_comps: p.values.salvage_comps }) !== JSON.stringify(v.values)) diffs.push(`values ${JSON.stringify(p.values)}`);
  const d = decide({ title_status: p.title_status, grades: p.grades, flags: p.flags, values: { clean_wholesale: p.values.clean_wholesale ?? undefined, salvage_comps: p.values.salvage_comps } });
  const ok = d.verdict === v.expect && !diffs.length;
  if (!ok) failed++;
  rows.push({
    vehicle: v.id, repair: `${$(d.repair.low)} to ${$(d.repair.high)}`,
    'fix net (P10-P90)': range(d.fix_net), 'as-is net (P10-P90)': range(d.as_is_net),
    'P(fix)': d.p_fix, verdict: d.verdict, check: d.check?.label ?? '',
    pass: ok ? 'yes' : d.verdict !== v.expect ? `NO (want ${v.expect})` : `NO, parser: ${diffs.join('; ')}`,
  });
  if (diffs.length) console.log(`${v.id}: ${diffs.join('; ')}`);
}
console.table(rows);
console.log(failed ? `${failed} of ${vehicles.length} FAILED` : `All ${vehicles.length} sample vehicles parse as expected and give the expected verdict.`);
process.exit(failed ? 1 : 0);

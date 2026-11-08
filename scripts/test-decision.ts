// Runs each demo vehicle (public/demo_vehicles.json) through the codes decoder and the
// decision engine, prints both net ranges, and fails if a verdict differs from "expect".
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { decodeScan } from '../api/decode-codes.ts';
import { PARTS } from '../api/grade-photos.ts';
import { decide, type Grade } from '../api/_lib/decision.ts';

const { vehicles } = JSON.parse(readFileSync('public/demo_vehicles.json', 'utf8'));
const $ = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const range = (b: { p10: number; p90: number } | null) => (b ? `${$(b.p10)} to ${$(b.p90)}` : '-');

let failed = 0;
const rows = [];
for (const v of vehicles) {
  const codes = await decodeScan(v.vin, v.codes, v.title_status);
  const grades: Grade[] = PARTS.map((p) => ({ part: p, grade: v.grades[p] ?? 'fine' }));
  const d = decide({ title_status: codes.title_status, grades, flags: v.flags, codes: codes.codes, values: v.values });
  const ok = d.verdict === v.expect;
  if (!ok) failed++;
  rows.push({
    vehicle: v.id, repair: `${$(d.repair.low)} to ${$(d.repair.high)}`,
    'fix net (P10-P90)': range(d.fix_net), 'as-is net (P10-P90)': range(d.as_is_net),
    'P(fix)': d.p_fix, verdict: d.verdict, check: d.check?.label ?? '', pass: ok ? 'yes' : `NO (want ${v.expect})`,
  });
}
console.table(rows);
console.log(failed ? `${failed} of ${vehicles.length} FAILED` : `All ${vehicles.length} demo vehicles give the expected verdict.`);
process.exit(failed ? 1 : 0);

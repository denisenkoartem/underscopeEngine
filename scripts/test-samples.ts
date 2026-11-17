// Runs each sample vehicle (public/demo_vehicles.json) the way the page does: its boxes (`fields`) and
// general box (`notes`) are written into one text (reader/src/form.ts), the rules reader reads it, and
// the repair estimate prices the grades. Fails if the reader reads something other than the sample's
// title, grades, flags or values, or if the repair estimate differs from the sample's `repair`.
// The marketplace decision is the engine's and is tested there (engine/tests).
//
//   npm run test:samples             check
//   npm run test:samples -- --write  record the current repair estimates as the expected ones
import { readFileSync, writeFileSync } from 'node:fs';
import { readRules, vinCheckDigitOk } from '../reader/src/rules.ts';
import { PARTS } from '../reader/src/contract.ts';
import { compose } from '../reader/src/form.ts';
import { repairEstimate } from '../api/_lib/repair.ts';

const FILE = 'public/demo_vehicles.json';
const write = process.argv.includes('--write');
const file = JSON.parse(readFileSync(FILE, 'utf8'));
const dollars = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

let failed = 0;
const rows = [];
for (const v of file.vehicles) {
  const read = readRules(compose(v.fields, v.notes));
  const flags = read.flags as Record<string, boolean | 'unknown'>;
  const diffs: string[] = [];
  if (!vinCheckDigitOk(v.vin)) diffs.push('VIN check digit');
  if (read.title_status !== v.title_status) diffs.push(`title ${read.title_status}`);
  for (const part of PARTS) {
    const got = read.grades.find((g) => g.part === part)!.grade, want = v.grades[part] ?? 'fine';
    if (got !== want) diffs.push(`${part} ${got} (want ${want})`);
  }
  for (const k of Object.keys(v.flags)) if (flags[k] !== v.flags[k]) diffs.push(`${k} ${flags[k]}`);
  const values = { clean_wholesale: read.values.clean_wholesale, salvage_comps: read.values.salvage_comps };
  if (JSON.stringify(values) !== JSON.stringify(v.values)) diffs.push(`values ${JSON.stringify(values)}`);

  const repair = repairEstimate({ grades: read.grades, flags: read.flags });
  if (write) v.repair = { low: repair.low, high: repair.high };
  else if (!v.repair || v.repair.low !== repair.low || v.repair.high !== repair.high) diffs.push(`repair ${repair.low} to ${repair.high} (want ${v.repair?.low} to ${v.repair?.high})`);

  if (diffs.length) failed++;
  rows.push({ vehicle: v.id, title: read.title_status, repair: `${dollars(repair.low)} to ${dollars(repair.high)}`, pass: diffs.length ? `NO: ${diffs.join('; ')}` : 'yes' });
}
console.table(rows);
if (write) {
  writeFileSync(FILE, JSON.stringify(file, null, 2) + '\n');
  console.log(`Recorded the repair estimate of ${file.vehicles.length} sample vehicles in ${FILE}.`);
} else {
  console.log(failed ? `${failed} of ${file.vehicles.length} FAILED` : `All ${file.vehicles.length} sample vehicles read as expected and give the expected repair estimate.`);
}
process.exit(failed && !write ? 1 : 0);

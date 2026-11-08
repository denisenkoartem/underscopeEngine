// Runs the 10 demo scans through the decoder and prints a summary table.
// Fails (exit 1) if any scan's triage differs from expected_triage.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { decodeScan } from '../api/decode-codes.ts';

type Scan = { id: string; vin: string; codes: string[]; expected_triage: string };
const scans: Scan[] = JSON.parse(readFileSync('data/test_scans.json', 'utf8'));

const rows = [];
let failed = 0;
for (const s of scans) {
  const r = await decodeScan(s.vin, s.codes);
  const ok = r.triage === s.expected_triage;
  if (!ok) failed++;
  rows.push({
    scan: s.id,
    vehicle: [r.vehicle.year, r.vehicle.make, r.vehicle.model].filter(Boolean).join(' '),
    codes: r.summary.count,
    worst: r.summary.worst_severity,
    cost: `$${r.summary.cost_low}-$${r.summary.cost_high}`,
    triage: r.triage === 'full_inspection' ? 'full_inspection' : 'skip/sell_as_is',
    sources: [...new Set(r.codes.map((c) => c.source))].join(','),
    pass: ok ? 'yes' : 'NO',
  });
}

console.table(rows);
console.log(failed ? `${failed} of ${scans.length} scans FAILED` : `All ${scans.length} scans passed.`);
process.exit(failed ? 1 : 0);

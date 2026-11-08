// Runs every scan in data/test_scans.json through the decoder and saves it to
// the scans table with is_demo = true (old demo rows are replaced).
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { decodeScan } from '../api/decode-codes.ts';

type Scan = { id: string; vin: string; codes: string[] };
const scans: Scan[] = JSON.parse(readFileSync('data/test_scans.json', 'utf8'));

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
const db = createClient(url, key, { auth: { persistSession: false } });

const rows = [];
for (const s of scans) {
  const result = await decodeScan(s.vin, s.codes);
  rows.push({ vin: s.vin, codes: s.codes, result, is_demo: true });
  console.log(`${s.id.padEnd(11)} ${result.triage}`);
}

const del = await db.from('scans').delete().eq('is_demo', true);
if (del.error) throw new Error(del.error.message);
const ins = await db.from('scans').insert(rows);
if (ins.error) throw new Error(ins.error.message);
console.log(`Saved ${rows.length} demo scans.`);

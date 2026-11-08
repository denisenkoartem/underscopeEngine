// Loads data/dtc_codes.csv into the Supabase dtc_codes table (upsert, safe to re-run).
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');

// Simple CSV: the description is the only field that may contain commas, so split
// off the first column and the last four columns and keep the middle as the description.
const [, ...lines] = readFileSync('data/dtc_codes.csv', 'utf8').trim().split(/\r?\n/);
const rows = lines.map((line) => {
  const parts = line.split(',');
  const [code] = parts;
  const [system, severity, low, high] = parts.slice(-4);
  const description = parts.slice(1, -4).join(',');
  return { code, description, system, severity, cost_low: Number(low), cost_high: Number(high) };
});

const db = createClient(url, key, { auth: { persistSession: false } });
const { error } = await db.from('dtc_codes').upsert(rows, { onConflict: 'code' });
if (error) throw new Error(error.message);
console.log(`Upserted ${rows.length} codes into dtc_codes.`);

// Loads data/vehicles.local.json (gitignored, real VINs) into the Supabase vehicles registry.
// Format: see data/vehicles.example.json. Safe to re-run (upsert by VIN).
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');

const TITLES = ['clean', 'salvage', 'rebuilt', 'flood', 'non_repairable', 'lemon'];
const SOURCES = ['title_document', 'dealer_listing', 'online_listing', 'nmvtis_report'];
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

const rows = JSON.parse(readFileSync('data/vehicles.local.json', 'utf8')).map((v: any, i: number) => {
  const vin = String(v.vin ?? '').trim().toUpperCase();
  const problems = [
    !VIN_RE.test(vin) && 'vin must be 17 characters without I, O or Q',
    !TITLES.includes(v.title_status) && `title_status must be one of ${TITLES.join(', ')}`,
    !SOURCES.includes(v.source) && `source must be one of ${SOURCES.join(', ')}`,
    v.title_state && !/^[A-Z]{2}$/.test(v.title_state) && 'title_state must be a 2-letter state code',
  ].filter(Boolean);
  if (v.clean_wholesale != null && !(Number(v.clean_wholesale) > 0)) problems.push('clean_wholesale must be a positive number');
  if (v.salvage_comps != null && !(Array.isArray(v.salvage_comps) && v.salvage_comps.every((n: unknown) => Number(n) > 0))) problems.push('salvage_comps must be a list of positive numbers');
  if (problems.length) throw new Error(`Entry ${i + 1}: ${problems.join('; ')}`);
  return {
    vin, title_status: v.title_status, title_state: v.title_state ?? null,
    odometer: v.odometer ?? null, source: v.source, note: v.note ?? null,
    clean_wholesale: v.clean_wholesale ?? null, salvage_comps: v.salvage_comps ?? null, values_note: v.values_note ?? null,
    updated_at: new Date().toISOString(),
  };
});

if (!rows.length) { console.log('data/vehicles.local.json is empty; nothing to load.'); process.exit(0); }
const db = createClient(url, key, { auth: { persistSession: false } });
const { error } = await db.from('vehicles').upsert(rows, { onConflict: 'vin' });
if (error) throw new Error(error.message);
console.log(`Loaded ${rows.length} vehicle(s): ${rows.map((r: any) => `${r.vin.slice(0, 8)}… ${r.title_status}`).join(', ')}`);

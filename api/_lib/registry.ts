// Demo registry lookup (Supabase `vehicles`, server-only under RLS).
// Returns only what the page may show; odometer and notes stay private.
import { createClient } from '@supabase/supabase-js';

export type RegistryTitle = {
  title_status: 'clean' | 'salvage' | 'rebuilt' | 'flood' | 'non_repairable' | 'lemon';
  title_state: string | null;
  source: 'title_document' | 'dealer_listing' | 'online_listing' | 'nmvtis_report';
  clean_wholesale: number | null;
  salvage_comps: number[] | null;
  values_note: string | null;
};

export async function lookupRegistry(vin: string): Promise<RegistryTitle | null> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // no server key: behave as if not registered
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.from('vehicles').select('title_status, title_state, source, clean_wholesale, salvage_comps, values_note').eq('vin', vin).maybeSingle();
  if (error) { console.warn(`vehicles lookup failed: ${error.message}`); return null; }
  return data as RegistryTitle | null;
}

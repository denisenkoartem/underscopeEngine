// GET /api/vehicle?vin=...  -> year, make, model and engine from the free NHTSA vPIC decode.
// Title and market values are not looked up anywhere: the seller types them (see /api/parse-notes).
import type { ApiRequest, ApiResponse } from './_lib/http.js';
import { vinCheckDigitOk } from '../reader/src/rules.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const VPIC_TIMEOUT_MS = 8000;
export type Vehicle = { year: string | null; make: string | null; model: string | null; engine: string | null };

export async function decodeVin(vin: string): Promise<Vehicle> {
  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(VPIC_TIMEOUT_MS) });
    const r = (await res.json()).Results?.[0] ?? {};
    const v = (s: string) => (r[s] && String(r[s]).trim()) || null;
    const engine = [v('DisplacementL') && `${Number(v('DisplacementL')).toFixed(1)}L`, v('FuelTypePrimary')]
      .filter(Boolean).join(' ') || null;
    return { year: v('ModelYear'), make: v('Make'), model: v('Model'), engine };
  } catch {
    return { year: null, make: null, model: null, engine: null }; // vPIC down: the check still runs
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET /api/vehicle?vin=...' });

  const vin = String(req.query.vin ?? '').trim().toUpperCase();
  if (!VIN_RE.test(vin)) return res.status(400).json({ error: 'vin must be 17 characters (no I, O or Q)' });
  return res.status(200).json({ vin, check_digit_ok: vinCheckDigitOk(vin), vehicle: await decodeVin(vin) });
}

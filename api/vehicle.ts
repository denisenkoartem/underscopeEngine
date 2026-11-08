// GET /api/vehicle?vin=...  -> whether the VIN is in the demo registry, and its verified title.
// The page calls this as soon as a full VIN is typed, to fill in the title status.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { lookupRegistry } from './_lib/registry.js';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET /api/vehicle?vin=...' });

  const vin = String(req.query.vin ?? '').trim().toUpperCase();
  if (!VIN_RE.test(vin)) return res.status(400).json({ error: 'vin must be 17 characters (no I, O or Q)' });
  const hit = await lookupRegistry(vin);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(hit ? { vin, registered: true, ...hit } : { vin, registered: false });
}

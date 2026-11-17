// POST /api/repair-estimate  { grades, flags?, labor_rate? }
//   -> { low, high, lines, allowances, labor_rate }: the cost to repair the graded parts.
// A table lookup (api/_lib/repair.ts), so the page calls it again on every reviewer edit.
// It does not say whether repairing pays; POST /api/route does, using this estimate.
import type { ApiRequest, ApiResponse } from './_lib/http.js';
import { REPAIR_CONFIG, repairEstimate } from './_lib/repair.js';

const GRADES = ['fine', 'repairable', 'replace', 'unknown'];

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: 'POST /api/repair-estimate',
      body: {
        grades: [{ part: 'hood', grade: 'replace' }],
        flags: { airbags_deployed: 'unknown', frame_suspected: false, fluid_leak: false },
        labor_rate: REPAIR_CONFIG.laborRate,
      },
      returns: 'low, high, lines (one per damaged part), allowances (added to high for what is unchecked), labor_rate',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const body = req.body ?? {};
  const valid = Array.isArray(body.grades)
    && body.grades.every((g: unknown) => typeof (g as { part?: unknown })?.part === 'string' && GRADES.includes((g as { grade?: string })?.grade ?? ''));
  if (!valid) return res.status(400).json({ error: `grades must be an array of { part, grade }, grade one of: ${GRADES.join(', ')}` });
  if (body.labor_rate !== undefined && !(typeof body.labor_rate === 'number' && body.labor_rate >= 0)) {
    return res.status(400).json({ error: 'labor_rate must be a number of dollars per hour, 0 or more' });
  }
  return res.status(200).json(repairEstimate(body));
}

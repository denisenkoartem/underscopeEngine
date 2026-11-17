// POST /api/parse-notes  { text } or { fields, text } -> the seller's description as JSON: title, mileage, state, run status,
// market values, 25 part grades, flags, the words each value was read from, and what is still missing.
// `fields` are the page's boxes (reader/src/form.ts: title, mileage, clean, comps, damage, airbags, frame, leaks);
// they are written into one text with `text`, the general box, and read together.
// Rules only (reader/src/rules.ts): no AI call, no cost. The JSON is the reader's contract (reader/src/contract.ts).
import type { ApiRequest, ApiResponse } from './_lib/http.js';
import { readRules } from '../reader/src/rules.js';
import { composeBody } from '../reader/src/form.js';

const MAX_CHARS = 20_000;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: 'POST /api/parse-notes',
      body: { text: 'Clean title, 84k miles. Front bumper and hood need replacing. Clean wholesale value $24,500. Similar damaged ones sold for 9800, 10400, 11200.' },
      or: { fields: { title: 'clean', mileage: '84k', clean: '$24,500', comps: '9800, 10400, 11200', damage: 'Front bumper and hood need replacing. Everything else is fine.', airbags: 'no', frame: 'no', leaks: 'not sure' }, text: 'Dealer trade-in, runs and drives, two keys.' },
      returns: 'vin, title_status, mileage, region, run_status, values, grades[25], flags, evidence, missing, questions, additional',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const text = composeBody(req.body);
  if (text === null || text.length > MAX_CHARS) return res.status(400).json({ error: `text and every field must be strings, up to ${MAX_CHARS} characters together` });
  return res.status(200).json(readRules(text));
}

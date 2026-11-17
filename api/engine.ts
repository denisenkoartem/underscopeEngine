// POST /api/engine  { text } or { fields, text } -> { assessment, issues, model_error, model }
// The seller's description read by the reader with its trained model (reader/src/read.ts): the keyword
// rules and the model merged into one assessment JSON (reader/src/contract.ts). It decides nothing; the
// engine analyzes the JSON. POST /api/parse-notes is the same reader without the model.
//
// Off unless ENGINE_ENABLED=1. The model is the server at PARSER_BASE_URL (reader/model/serve.py locally);
// without it, or when it gives no answer, the result is the rules' reading and model_error says why.
import type { ApiRequest, ApiResponse } from './_lib/http.js';
import { DEFAULT_MODEL, MAX_TEXT_CHARS } from '../reader/src/model.js';
import { read } from '../reader/src/read.js';
import { composeBody } from '../reader/src/form.js';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  const enabled = process.env.ENGINE_ENABLED === '1';
  const model = process.env.PARSER_BASE_URL ? `${process.env.PARSER_MODEL || DEFAULT_MODEL} at ${process.env.PARSER_BASE_URL}` : null;
  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: 'POST /api/engine',
      enabled,
      body: { text: 'Clean title in hand, 84k miles, no keys. Front hit: bumper and hood need replacing, rest is fine. Runs and drives. Shop quoted $3,200.' },
      returns: 'assessment (the reader JSON: every field of /api/parse-notes, read by the rules and the model together), issues (model answers the checks removed), model_error, model',
      model: model ?? 'none configured (set PARSER_BASE_URL); the rules read alone',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  if (!enabled) return res.status(501).json({ error: '/api/engine is off here (set ENGINE_ENABLED=1 to turn it on)' });
  // The page's boxes and its general box, written into one text (reader/src/form.ts).
  const text = composeBody(req.body);
  if (text === null || text.trim() === '' || text.length > MAX_TEXT_CHARS) return res.status(400).json({ error: `text (or fields) must be non-empty strings of up to ${MAX_TEXT_CHARS} characters together` });
  try {
    const r = await read(text, { log: (line) => console.error(line) });
    return res.status(200).json({ ...r, model });
  } catch (e) {
    return res.status(500).json({ error: `reader failed: ${(e as Error).message}` });
  }
}

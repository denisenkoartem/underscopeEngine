// Local dev server: serves public/ and runs api/*.ts like Vercel does, without the Vercel CLI or a login.
// npm run dev  ->  http://localhost:3000   (PORT=xxxx to change). Reads keys from .env.
import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');
const MAX_BODY = 4.5 * 1024 * 1024; // Vercel's request body cap, so local behaves like production
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// Minimal VercelRequest/VercelResponse: query, parsed JSON body, res.status().json(), res.setHeader(), res.end().
function vercelRes(res: ServerResponse) {
  const r = res as ServerResponse & { status: (c: number) => typeof r; json: (b: unknown) => typeof r; send: (b: unknown) => typeof r };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify(b)); return r; };
  r.send = (b) => { typeof b === 'object' && !Buffer.isBuffer(b) ? r.json(b) : r.end(b as string); return r; };
  return r;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const name = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const file = join(ROOT, 'api', `${name}.ts`);
  if (!/^[\w-]+$/.test(name) || name.startsWith('_') || !existsSync(file)) return vercelRes(res).status(404).json({ error: `No function /api/${name}` });

  const raw = await readBody(req);
  if (raw === null) return vercelRes(res).status(413).json({ error: 'Request body over 4.5 MB (Vercel limit)' });
  let body: unknown = undefined;
  if (raw.length) {
    const text = raw.toString('utf8');
    try { body = (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(text) : text; }
    catch { return vercelRes(res).status(400).json({ error: 'Invalid JSON body' }); }
  }
  Object.assign(req, { query: Object.fromEntries(url.searchParams), body, cookies: {} });

  const started = Date.now();
  const mod = await import(pathToFileURL(file).href);
  await mod.default(req, vercelRes(res));
  console.log(`${req.method} ${url.pathname} -> ${res.statusCode} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function handleStatic(res: ServerResponse, url: URL) {
  let path = join(PUBLIC, decodeURIComponent(url.pathname));
  if (!path.startsWith(PUBLIC)) return res.writeHead(403).end();
  try { if ((await stat(path)).isDirectory()) path = join(path, 'index.html'); } catch { return res.writeHead(404).end('Not found'); }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  } catch { res.writeHead(404).end('Not found'); }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) vercelRes(res).status(500).json({ error: (e as Error).message });
  }
}).listen(PORT, () => console.log(`Underscope dev server: http://localhost:${PORT}  (api/*.ts + public/)`));

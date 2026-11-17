// Scores the engine on data/market_cases/cases.json: made-up seller descriptions, each with the
// marketplace where published descriptions of ACV and Copart say that kind of car sells.
// Path: description -> reader rules -> engine (underscope route-assessment) -> marketplace.
// Not a measure of which marketplace pays more: no public data records that.
//   npx tsx scripts/market-check.ts [--show] [--typos 5]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRules } from '../reader/src/rules.ts';

const base = JSON.parse(readFileSync('data/market_cases/cases.json', 'utf8')).cases;
// --typos N: N extra copies of every case with sentences shuffled and about one word in ten
// mistyped (two neighbouring letters swapped), seeded. The expected marketplace does not change.
const nTypos = Number(process.argv[process.argv.indexOf('--typos') + 1]) || 0;
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const mistype = (text: string) => text.split(/(?<=[.!?])\s+/).sort(() => rnd() - 0.5).join(' ')
  .replace(/[A-Za-z]{4,}/g, (w) => { if (rnd() > 0.1) return w; const i = 1 + Math.floor(rnd() * (w.length - 2)); return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2); });
const cases = process.argv.includes('--typos')
  ? base.flatMap((c: any) => Array.from({ length: nTypos }, (_, k) => ({ ...c, id: `${c.id}-t${k + 1}`, text: mistype(c.text) })))
  : base;
const file = join(mkdtempSync(join(tmpdir(), 'market-')), 'a.jsonl');
writeFileSync(file, cases.map((c: any) => JSON.stringify({ id: c.id, kind: 'market_case', a: readRules(c.text) })).join('\n') + '\n');
const out = execFileSync('engine/.venv/bin/underscope', ['route-assessment', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
const rows = out.trim().split('\n').map((l) => JSON.parse(l));
const show = process.argv.includes('--show');
const tally: Record<string, [number, number]> = {};
let ok = 0;
cases.forEach((c: any, i: number) => {
  const r = rows[i].route ?? rows[i];
  const got = r.marketplace ?? r.destination ?? null;
  const hit = got === c.expect;
  ok += +hit;
  for (const k of ['all', c.expect, c.basis, `precision ${r.precision?.level}`, `decided by ${r.decided_by}`]) { tally[k] ??= [0, 0]; tally[k][0] += +hit; tally[k][1]++; }
  if (show && !hit) console.log(`${c.id} want ${c.expect} got ${got} (${r.decided_by}, p_acv ${r.p_acv}, ${r.confidence}, ${r.precision?.level})\n    ${c.text.slice(0, 230)}`);
});
console.table(Object.fromEntries(Object.entries(tally).map(([k, [h, n]]) => [k, { right: h, of: n, share: `${((100 * h) / n).toFixed(1)}%` }])));
process.exit(ok / cases.length >= 0.9 ? 0 : 1);

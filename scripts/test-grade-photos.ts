// Runs test vehicles through the two-stage photo grading the page uses, times each stage, saves the result.
//   1. /api/classify-photos: photos at 768 px with a labelled 4x4 grid -> view per photo + grid boxes (gpt-4o-mini)
//   2. crops cut from the FULL-resolution photos around those boxes (as the page does with a canvas)
//   3. /api/grade-photos: photos at 1000 px + views + crops (OPENAI_MODEL, e.g. gpt-4o)
// npm run test:photos -- [vehicle ids...]   (default: every folder in test_vehicles/). Needs `npm run dev` running.
// OUT=name.json changes the output file in each vehicle folder (default grade.json). Uses ImageMagick `convert`.
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = join(ROOT, 'test_vehicles');
const API = process.env.API_URL ?? 'http://localhost:3000/api';
const VIN = process.env.TEST_VIN ?? '00000000000000000'; // neutral: the model must identify the vehicle from the photos
const OUT = process.env.OUT ?? 'grade.json';
const MAX_CROPS = 10, CROP_SIDE = 768, PAD = 0.15;
const VERCEL_LIMIT_S = 60;

type Region = { kind: 'damage' | 'vin_label' | 'odometer'; part: string; note: string; cells?: string; box: { x: number; y: number; w: number; h: number } };
const num = (f: string) => Number(f.match(/(\d+)\.\w+$/)?.[1] ?? 0);
const jpeg = (args: string[]) => 'data:image/jpeg;base64,' + execFileSync('convert', args).toString('base64');
const resized = (p: string, side: number, q: number) => jpeg([p, '-auto-orient', '-resize', `${side}x${side}>`, '-quality', String(q), 'jpg:-']);
const size = (p: string) => execFileSync('identify', ['-format', '%w %h', p]).toString().split(' ').map(Number);
// Stage-1 image: 768 px with the labelled 4x4 grid (columns A-D, rows 1-4), same as drawGrid() in public/index.html.
function gridded(p: string) {
  const [W, H] = size(p), k = Math.min(1, 768 / Math.max(W, H)), w = Math.round(W * k), h = Math.round(H * k);
  const draw: string[] = [];
  for (let i = 1; i < 4; i++) draw.push('-draw', `line ${Math.round((w * i) / 4)},0 ${Math.round((w * i) / 4)},${h}`, '-draw', `line 0,${Math.round((h * i) / 4)} ${w},${Math.round((h * i) / 4)}`);
  const labels: string[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) labels.push('-annotate', `+${Math.round((w * c) / 4) + 5}+${Math.round((h * r) / 4) + 21}`, `${'ABCD'[c]}${r + 1}`);
  return jpeg([p, '-auto-orient', '-resize', `${w}x${h}!`, '-stroke', 'rgba(255,230,0,0.85)', '-strokewidth', '2', ...draw,
    '-stroke', 'black', '-strokewidth', '1', '-fill', 'rgb(255,230,0)', '-pointsize', '19', '-font', 'DejaVu-Sans-Bold', ...labels, '-quality', '80', 'jpg:-']);
}
const post = async (path: string, body: unknown) => {
  const res = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${json.error ?? ''}`);
  return json;
};

// Labels and the odometer first (they need the pixels most), then damage, up to MAX_CROPS.
function pickCrops(classes: { photo: number; regions: Region[] }[]) {
  const all = classes.flatMap((c) => c.regions.map((r) => ({ photo: c.photo, ...r })));
  const rank = (k: string) => (k === 'vin_label' ? 0 : k === 'odometer' ? 1 : 2);
  return all.sort((a, b) => rank(a.kind) - rank(b.kind)).slice(0, MAX_CROPS);
}

function cutCrop(file: string, box: Region['box']) {
  const [W, H] = size(file);
  const x0 = Math.max(0, (box.x - box.w * PAD) * W), y0 = Math.max(0, (box.y - box.h * PAD) * H);
  const x1 = Math.min(W, (box.x + box.w * (1 + PAD)) * W), y1 = Math.min(H, (box.y + box.h * (1 + PAD)) * H);
  const w = Math.max(32, Math.round(x1 - x0)), h = Math.max(32, Math.round(y1 - y0));
  return jpeg([file, '-auto-orient', '-crop', `${w}x${h}+${Math.round(x0)}+${Math.round(y0)}`, '+repage',
    '-resize', `${CROP_SIDE}x${CROP_SIDE}`, '-quality', '82', 'jpg:-']);
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(DIR).filter((d) => /^\d+$/.test(d)).sort();
const rows: string[] = [];
for (const id of ids) {
  const folder = join(DIR, id);
  if (!existsSync(folder)) { console.error(`${id}: no folder ${folder}`); continue; }
  const files = readdirSync(folder).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort((a, b) => num(a) - num(b) || a.localeCompare(b)).map((f) => join(folder, f));
  try {
    const t0 = Date.now();
    const stage1 = await post('classify-photos', { photos: files.map(gridded) });
    const t1 = Date.now();
    const picked = pickCrops(stage1.photos);
    const crops = picked.map((r) => ({ photo: r.photo, kind: r.kind, part: r.part, note: r.note, image: cutCrop(files[r.photo - 1], r.box) }));
    const views = stage1.photos.map((p: { view: string }) => p.view);
    const photos = files.map((f) => resized(f, 1000, 80));
    const mb = (photos.join('').length + crops.reduce((n, c) => n + c.image.length, 0)) / 1e6;
    const result = await post('grade-photos', { vin: VIN, photos, views, crops });
    const t2 = Date.now();
    const s1 = (t1 - t0) / 1000, s2 = (t2 - t1) / 1000;
    writeFileSync(join(folder, OUT), JSON.stringify({ seconds: (t2 - t0) / 1000, stage1_seconds: s1, stage2_seconds: s2, stage1, crops: picked, result }, null, 2));
    const g = result.parts.reduce((m: Record<string, number>, p: any) => (m[p.grade] = (m[p.grade] ?? 0) + 1, m), {});
    const v = result.vehicle;
    rows.push(`${id.padEnd(9)} ${String(files.length).padStart(3)} photos ${String(crops.length).padStart(2)} crops ${mb.toFixed(1)} MB  ` +
      `stage1 ${s1.toFixed(0)}s${s1 > VERCEL_LIMIT_S ? '!' : ''} stage2 ${s2.toFixed(0)}s${s2 > VERCEL_LIMIT_S ? '!' : ''}  ` +
      `${[v.year, v.make, v.model].filter(Boolean).join(' ') || 'unidentified'} | ${g.replace ?? 0} replace, ${g.repairable ?? 0} repairable, ${g.unknown ?? 0} unknown`);
  } catch (e) {
    rows.push(`${id.padEnd(9)} ERROR ${(e as Error).message.slice(0, 160)}`);
  }
  console.log(rows.at(-1));
}
console.log(`\n${rows.length} vehicle(s) -> ${OUT}`);

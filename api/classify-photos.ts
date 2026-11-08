// POST /api/classify-photos  { photos: [768 px JPEG data URLs with the 4x4 grid drawn on them] }
//   -> per photo: what it shows, which vehicle side (computed here, not by the model), and grid boxes around damage,
//      the VIN label and the odometer.
// Stage 1 of photo grading. A cheap model (OPENAI_CLASSIFY_MODEL, default gpt-4o-mini) answers only simple
// questions about the image ("are the headlights on the left or right of the picture?", "which grid cells hold the
// dent?"). Turning that into the vehicle's left/right is done in code, because small models get it wrong when asked
// directly. The page draws the grid (see drawGrid in public/index.html), cuts the boxes out of the full-resolution
// photos and sends photos + views + crops to /api/grade-photos (stage 2).
import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

export const config = { maxDuration: 60 };

export const CLASSIFY_CONFIG = {
  model: process.env.OPENAI_CLASSIFY_MODEL || 'gpt-4o-mini',
  maxPhotos: 30,
  maxRegionsPerPhoto: 3,
  imageDetail: 'high' as const,
};

const SHOWS = ['exterior', 'interior', 'dashboard', 'engine_bay', 'underbody', 'label_or_document', 'detail', 'other'] as const;
const POSITION = ['not_visible', 'image_left', 'image_center', 'image_right'] as const;
const KINDS = ['damage', 'vin_label', 'odometer'] as const;
// Parts without a side; code adds left_/right_ from the photo's view.
const GENERIC_PARTS = ['front_bumper', 'hood', 'grille', 'headlight', 'windshield', 'front_fender', 'front_door', 'rear_door',
  'mirror', 'rear_quarter', 'tailgate_or_rear_doors', 'rear_bumper', 'taillight', 'wheels_and_tires', 'roof', 'interior',
  'engine_bay', 'underbody', 'none'] as const;
const SIDED = new Set(['headlight', 'front_fender', 'front_door', 'rear_door', 'mirror', 'rear_quarter', 'taillight']);
export const GRID = { cols: ['A', 'B', 'C', 'D'], rows: ['1', '2', '3', '4'] };
const CELLS = GRID.rows.flatMap((r) => GRID.cols.map((c) => `${c}${r}`));

export type Region = { kind: (typeof KINDS)[number]; part: string; note: string; cells: string; box: { x: number; y: number; w: number; h: number } };
export type PhotoClass = { photo: number; view: string; side: 'left' | 'right' | null; observed: { shows: string; at_left: string; at_right: string; front_end: string; rear_end: string }; regions: Region[] };

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['photos'],
  properties: {
    photos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['photo', 'shows', 'at_left_of_vehicle', 'at_right_of_vehicle', 'front_end', 'rear_end', 'regions'],
        properties: {
          photo: { type: 'integer' },
          shows: { type: 'string', enum: SHOWS },
          at_left_of_vehicle: { type: 'string' },
          at_right_of_vehicle: { type: 'string' },
          front_end: { type: 'string', enum: POSITION },
          rear_end: { type: 'string', enum: POSITION },
          regions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['kind', 'part', 'note', 'from_cell', 'to_cell'],
              properties: {
                kind: { type: 'string', enum: KINDS },
                part: { type: 'string', enum: GENERIC_PARTS },
                note: { type: 'string' },
                from_cell: { type: 'string', enum: CELLS },
                to_cell: { type: 'string', enum: CELLS },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `You look at photos of one vehicle and answer simple questions about each picture. Reply with JSON only, matching the schema, one entry per photo in order.

Each photo has a yellow 4x4 grid drawn on it. Columns A, B, C, D go left to right; rows 1, 2, 3, 4 go top to bottom; every cell is labelled in its top-left corner (A1 is the top-left cell, D4 the bottom-right).

For every photo:
1. shows: exterior (the outside of the vehicle), interior (seats, door panels), dashboard (instrument cluster, steering wheel close-up), engine_bay, underbody, label_or_document (door-jamb sticker, VIN plate, paperwork), detail (a close-up of one small area), other.
2. at_left_of_vehicle / at_right_of_vehicle: look at the vehicle in the picture and write what you see at its LEFT-most end in the picture and at its RIGHT-most end in the picture, in a few words (for example "headlight, grille and front bumper" or "taillight and rear bumper" or "side mirror and front door"). Write "n/a" when it is not an exterior photo.
3. front_end: where the vehicle's FRONT END (headlights and grille) is in the picture: image_left, image_center or image_right. not_visible if you cannot see the headlights or grille (for example a rear view, or not an exterior photo).
4. rear_end: where the vehicle's REAR END (taillights, tailgate or trunk) is in the picture: image_left, image_center or image_right, or not_visible.
   Base front_end and rear_end on what you wrote in step 2. Describe only positions in the picture, exactly as you see them. Do not think about the vehicle's own left or right side.
   Examples: a side view of a car driving toward the left edge -> front_end image_left, rear_end image_right. A picture taken straight at the grille -> front_end image_center, rear_end not_visible. A three-quarter shot of the front corner with the grille on the left half of the picture -> front_end image_left, rear_end not_visible.
5. regions (at most ${CLASSIFY_CONFIG.maxRegionsPerPhoto}): areas that deserve a full-resolution close-up, as a rectangle of grid cells from from_cell (top-left cell) to to_cell (bottom-right cell). Cover the whole area, a little generously.
   - damage: a real dent, crease, deep scrape, crack, broken or missing part, deployed airbag, or flat tire. part = which part it is on, without left/right (headlight, front_fender, front_door, rear_door, mirror, rear_quarter, taillight, ...). Do NOT mark dirt, water spots, reflections, shadows, stickers or normal wear. A clean photo gets no regions.
   - vin_label: the door-jamb sticker or a VIN plate (part = none).
   - odometer: the mileage display on the instrument cluster (part = none).
   note: a few words, e.g. "large dent low on door", "VIN sticker".`;

const posOf = (cell: string) => ({ col: GRID.cols.indexOf(cell[0]), row: GRID.rows.indexOf(cell.slice(1)) });

// Vehicle view and side from where the front and rear ends are in the picture.
// Front end toward the picture's left edge means we are looking at the vehicle's LEFT side (and vice versa).
export function viewFrom(shows: string, front: string, rear: string): { view: string; side: 'left' | 'right' | null } {
  if (shows !== 'exterior') return { view: shows, side: null };
  const f = front, r = rear;
  if (f === 'image_center' && (r === 'not_visible' || r === 'image_center')) return { view: 'front', side: null };
  if (r === 'image_center' && f === 'not_visible') return { view: 'rear', side: null };
  const votes = { left: 0, right: 0 };
  if (f === 'image_left') votes.left++;
  if (f === 'image_right') votes.right++;
  if (r === 'image_right') votes.left++;
  if (r === 'image_left') votes.right++;
  if (votes.left === votes.right) return { view: 'exterior_unknown_side', side: null };
  const side = votes.left > votes.right ? 'left' : 'right';
  const frontSeen = f !== 'not_visible', rearSeen = r !== 'not_visible';
  const angle = frontSeen && rearSeen ? 'side' : frontSeen ? 'front' : rearSeen ? 'rear' : 'side';
  return { view: angle === 'side' ? `${side}_side` : `${angle}_${side}`, side };
}

// Add left_/right_ to a sided part. Straight-on front photos are mirrored: the picture's left half is the vehicle's right.
function sidedPart(part: string, view: string, side: 'left' | 'right' | null, boxCenterX: number): string {
  if (!SIDED.has(part)) return part;
  let s = side;
  if (view === 'front') s = boxCenterX < 0.5 ? 'right' : 'left';
  if (view === 'rear') s = boxCenterX < 0.5 ? 'left' : 'right';
  return s ? `${s}_${part}` : `${part} (side unknown)`;
}

// Small models describe the ends of the vehicle more reliably than they fill in the position fields, so positions
// come from the descriptions when those are clear, and from front_end / rear_end otherwise.
const FRONT_WORDS = /head ?light|grille|front bumper|hood/i;
const REAR_WORDS = /tail ?light|rear bumper|tailgate|trunk|liftgate|hatch/i;
export function positionsFrom(atLeft: string, atRight: string, front: string, rear: string) {
  const lf = FRONT_WORDS.test(atLeft), rf = FRONT_WORDS.test(atRight), lr = REAR_WORDS.test(atLeft), rr = REAR_WORDS.test(atRight);
  const described = lf || rf || lr || rr; // the descriptions name at least one end of the vehicle
  const f = lf && !rf && !lr ? 'image_left' : rf && !lf && !rr ? 'image_right' : described && !lf && !rf ? 'not_visible' : front;
  const r = lr && !rr && !lf ? 'image_left' : rr && !lr && !rf ? 'image_right' : described && !lr && !rr ? 'not_visible' : rear;
  // The two ends cannot sit on the same side of the picture; if they do, trust the descriptions' front end.
  return f === r && f !== 'not_visible' && f !== 'image_center' ? { front: f, rear: 'not_visible' } : { front: f, rear: r };
}

export async function classifyPhotos(photos: string[]): Promise<PhotoClass[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Set OPENAI_API_KEY');
  const ai = new OpenAI({ apiKey });
  const content = [
    { type: 'text' as const, text: `${photos.length} photo(s) of one vehicle, numbered in order. Each has the 4x4 grid drawn on it.` },
    ...photos.flatMap((url, i) => [
      { type: 'text' as const, text: `Photo ${i + 1}:` },
      { type: 'image_url' as const, image_url: { url, detail: CLASSIFY_CONFIG.imageDetail } },
    ]),
  ];
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.chat.completions.create({
        model: CLASSIFY_CONFIG.model,
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: { name: 'photo_classes', strict: true, schema: SCHEMA } },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
      });
      const raw = JSON.parse(res.choices[0].message.content ?? '');
      return photos.map((_, i) => {
        const p = raw.photos.find((x: { photo: number }) => x.photo === i + 1)
          ?? { shows: 'other', at_left_of_vehicle: '', at_right_of_vehicle: '', front_end: 'not_visible', rear_end: 'not_visible', regions: [] };
        const pos = positionsFrom(p.at_left_of_vehicle, p.at_right_of_vehicle, p.front_end, p.rear_end);
        const { view, side } = viewFrom(p.shows, pos.front, pos.rear);
        const regions: Region[] = p.regions.slice(0, CLASSIFY_CONFIG.maxRegionsPerPhoto).map((r: any) => {
          const a = posOf(r.from_cell), b = posOf(r.to_cell);
          const c0 = Math.min(a.col, b.col), c1 = Math.max(a.col, b.col), r0 = Math.min(a.row, b.row), r1 = Math.max(a.row, b.row);
          const box = { x: c0 / 4, y: r0 / 4, w: (c1 - c0 + 1) / 4, h: (r1 - r0 + 1) / 4 };
          return { kind: r.kind, part: sidedPart(r.part, view, side, box.x + box.w / 2), note: r.note, cells: `${r.from_cell}-${r.to_cell}`, box };
        });
        return { photo: i + 1, view, side, observed: { shows: p.shows, at_left: p.at_left_of_vehicle, at_right: p.at_right_of_vehicle, front_end: p.front_end, rear_end: p.rear_end }, regions };
      });
    } catch (e) {
      lastError = (e as Error).message;
      console.warn(`Photo classification attempt ${attempt + 1} failed: ${lastError.slice(0, 200)}`);
    }
  }
  throw new Error(`Photo classification failed: ${lastError.slice(0, 200)}`);
}

const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST { photos: [data URLs with the grid drawn on] }' });
  const { photos } = req.body ?? {};
  if (!Array.isArray(photos) || photos.length === 0 || photos.length > CLASSIFY_CONFIG.maxPhotos) {
    return res.status(400).json({ error: `photos must be an array of 1 to ${CLASSIFY_CONFIG.maxPhotos} images` });
  }
  if (!photos.every((p) => typeof p === 'string' && PHOTO_RE.test(p))) {
    return res.status(400).json({ error: 'each photo must be a base64 data URL (JPEG, PNG or WebP)' });
  }
  try {
    const started = Date.now();
    const classes = await classifyPhotos(photos);
    return res.status(200).json({ photos: classes, meta: { model: CLASSIFY_CONFIG.model, seconds: Math.round((Date.now() - started) / 100) / 10 } });
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }
}

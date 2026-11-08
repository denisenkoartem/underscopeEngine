// POST /api/grade-photos  { vin, photos: [JPEG data URLs] } -> part grades, every visible problem, flags, photo gaps.
// All photos of one vehicle go to OpenAI in ONE request (CLAUDE.md "Vision call").
// A strict JSON schema with every part as a required key guarantees all 25 parts come back.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { openaiClient } from './_lib/openai.js';

export const config = { maxDuration: 60 };

export const PARTS = [
  'front_bumper', 'hood', 'grille', 'left_headlight', 'right_headlight', 'windshield',
  'left_front_fender', 'right_front_fender', 'left_front_door', 'right_front_door',
  'left_rear_door', 'right_rear_door', 'left_mirror', 'right_mirror', 'left_rear_quarter',
  'right_rear_quarter', 'tailgate_or_rear_doors', 'rear_bumper', 'left_taillight', 'right_taillight',
  'wheels_and_tires', 'roof', 'interior', 'engine_bay', 'underbody',
] as const;
const GRADES = ['fine', 'repairable', 'replace', 'unknown'] as const;
const DAMAGE_TYPES = [
  'dent', 'scratch', 'scrape', 'crack', 'broken', 'shattered_glass', 'missing', 'bent_or_deformed', 'crushed',
  'misaligned_panel', 'rust', 'burn', 'water_line', 'deployed_airbag', 'flat_or_damaged_tire', 'fluid_leak', 'other',
] as const;
const FLAGS = ['airbags_deployed', 'frame_suspected', 'fluid_leak', 'flood_suspected', 'fire_damage', 'suspension_damage_suspected'] as const;

export const GRADE_CONFIG = {
  maxPhotos: 30,
  maxCrops: 10,                      // full-resolution close-ups cut by the page from /api/classify-photos boxes
  imageDetail: 'high' as const,      // damage is small; low detail misses it
  reasoningEffort: 'low' as const,   // only for reasoning models (gpt-5.x, o-series); gpt-4o takes temperature 0 instead
};

// Close-up cut from photo `photo` around a region stage 1 flagged.
export type Crop = { photo: number; kind: 'damage' | 'vin_label' | 'odometer'; part: string; note: string; image: string };
export type GradeOptions = { views?: (string | null)[]; crops?: Crop[] };

type Tri = boolean | 'unknown';
export type Damage = { part: string; type: string; severity: 'minor' | 'moderate' | 'severe'; description: string; photos: number[]; confidence: number };
export type GradeResult = {
  photo_views: { photo: number; view: string; cue: string }[];
  vehicle: {
    year: number | null; make: string | null; model: string | null; trim: string | null; body_type: string; color: string | null;
    identified_from: string;
    vin_visible: string | null;            // read from a photo (door label, dash), if legible
    vin_check_digit_ok: boolean | null;    // false = misread; never trust a VIN that fails this
    vin_matches_input: boolean | null;     // photo VIN vs the VIN the seller typed
    odometer_visible: number | null; odometer_unit: 'mi' | 'km' | 'unknown';
  };
  parts: { part: string; grade: string; confidence: number; evidence_photo: number | null; note: string }[];
  damages: Damage[];
  missing_parts: { item: string; part: string; photos: number[] }[];
  flags: Record<(typeof FLAGS)[number], Tri>;
  primary_damage_area: string;
  overall_severity: 'none' | 'light' | 'moderate' | 'heavy' | 'total_loss_likely';
  photo_gaps: string[];
  summary: string;
  meta: { model: string; seconds: number; attempts: number; photos: number; crops: number };
};

const triState = { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['unknown'] }] };
const nullable = (type: string) => ({ anyOf: [{ type }, { type: 'null' }] });
const photoList = { type: 'array', items: { type: 'integer' } };
const partSchema = {
  type: 'object', additionalProperties: false,
  required: ['grade', 'confidence', 'evidence_photo', 'note'],
  properties: {
    grade: { type: 'string', enum: GRADES },
    confidence: { type: 'number' },
    evidence_photo: nullable('integer'),
    note: { type: 'string' },
  },
};
const VIEWS = ['front', 'front_left', 'left_side', 'rear_left', 'rear', 'rear_right', 'right_side', 'front_right',
  'interior', 'dashboard', 'engine_bay', 'underbody', 'label_or_document', 'detail', 'other'] as const;
// Property order matters: the model writes photo_views first, so left/right is settled before any part is graded.
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['photo_views', 'vehicle', 'parts', 'damages', 'missing_parts', 'flags', 'primary_damage_area', 'overall_severity', 'photo_gaps', 'summary'],
  properties: {
    photo_views: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['photo', 'cue', 'view'],
        properties: { photo: { type: 'integer' }, cue: { type: 'string' }, view: { type: 'string', enum: VIEWS } },
      },
    },
    vehicle: {
      type: 'object', additionalProperties: false,
      required: ['year', 'make', 'model', 'trim', 'body_type', 'color', 'identified_from', 'vin_visible', 'odometer_visible', 'odometer_unit'],
      properties: {
        year: nullable('integer'), make: nullable('string'), model: nullable('string'), trim: nullable('string'),
        body_type: { type: 'string', enum: ['sedan', 'coupe', 'hatchback', 'wagon', 'suv', 'pickup', 'minivan', 'passenger_van', 'cargo_van', 'other', 'unknown'] },
        color: nullable('string'),
        identified_from: { type: 'string' },
        vin_visible: nullable('string'),
        odometer_visible: nullable('integer'),
        odometer_unit: { type: 'string', enum: ['mi', 'km', 'unknown'] },
      },
    },
    parts: { type: 'object', additionalProperties: false, required: [...PARTS], properties: Object.fromEntries(PARTS.map((p) => [p, partSchema])) },
    damages: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['part', 'type', 'severity', 'description', 'photos', 'confidence'],
        properties: {
          part: { type: 'string', enum: PARTS },
          type: { type: 'string', enum: DAMAGE_TYPES },
          severity: { type: 'string', enum: ['minor', 'moderate', 'severe'] },
          description: { type: 'string' },
          photos: photoList,
          confidence: { type: 'number' },
        },
      },
    },
    missing_parts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['item', 'part', 'photos'],
        properties: { item: { type: 'string' }, part: { type: 'string', enum: PARTS }, photos: photoList },
      },
    },
    flags: { type: 'object', additionalProperties: false, required: [...FLAGS], properties: Object.fromEntries(FLAGS.map((f) => [f, triState])) },
    primary_damage_area: { type: 'string', enum: ['front', 'rear', 'left_side', 'right_side', 'roof', 'undercarriage', 'interior', 'all_over', 'none', 'unknown'] },
    overall_severity: { type: 'string', enum: ['none', 'light', 'moderate', 'heavy', 'total_loss_likely'] },
    photo_gaps: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

const SYSTEM = `You are an experienced auto-damage appraiser grading one vehicle from its photos for a used-car remarketing tool. Reply with JSON only, matching the schema. Work through the steps in order; the JSON fields come in the same order.

Left and right ALWAYS mean the vehicle's own sides as seen from the driver's seat (US: left = driver side), never the left or right of the picture.

STEP 1 - photo_views: one entry per photo with its view and the cue you used.
- If a photo's label gives its view ("view from the photo classifier"), copy it. It was worked out from where the headlights and taillights sit in the picture. Override it only if the photo plainly contradicts it, and say why in cue.
- Otherwise: in a side or three-quarter photo, if the vehicle's front end points toward the LEFT edge of the picture you are looking at its LEFT side; toward the RIGHT edge, its RIGHT side. A van's sliding side door and its track rail are on the right side.
- In a straight-on FRONT photo you face the vehicle, so its LEFT headlight, fender and mirror are on the RIGHT half of the picture. In a straight-on REAR photo its LEFT taillight is on the LEFT half.

STEP 2 - look at every photo and every close-up crop before grading. Crops are full-resolution cut-outs of areas a first pass flagged, each from the numbered photo shown in its label; a crop with no real damage is a false alarm, and its part label is only a hint. Scan the whole vehicle in each photo: bumpers, grille, lights, hood, every door, quarter panels, wheels and tires, glass, mirrors. Small dents and creases show as bent reflections or uneven panel gaps.

STEP 3 - grade all 25 parts:
- fine: visible in at least one photo (even at an angle or partly) and undamaged.
- repairable: damaged but fixable: any dent or crease (even small), scrape or scratch through the paint, repairable crack, scuffed or torn bumper cover.
- replace: broken, cracked through, shattered, missing, crushed or torn, or too damaged to repair. A deployed airbag makes interior "replace".
- unknown: ONLY when no photo shows the part at all (typically the underbody, the top of the roof, or a side that was not photographed). Every part you can see in any photo gets fine, repairable or replace.
- Missing real damage costs more than one extra "repairable", so when a panel looks dented or scraped, grade it repairable.
- Dirt, water spots, wash marks, light swirl marks, tiny stone chips and faded headlight lenses are not damage: grade them fine.
- Grade the panel the damage is actually on. Damage on a bumper corner does not make the fender, headlight or grille repairable unless that part itself is dented, scratched, cracked or pushed out of line.
Parts: ${PARTS.join(', ')}. "interior" covers seats, dash and airbags; "engine_bay" covers the radiator area and leaks; "underbody" covers frame rails, exhaust and catalytic converter.
evidence_photo is the number of the photo that best shows the part (never a crop number), or null when the grade is unknown. note is a few words on what you saw. confidence is 0 to 1.

STEP 4 - the rest:
- damages: every distinct problem that needs repair (not dirt or wear), with a specific description (where, how big) and the photo numbers that show it.
- missing_parts: specific items that are absent (e.g. "front bumper cover", "left headlight assembly", "driver mirror glass").
- flags: true/false only when a photo clearly shows it, otherwise "unknown". frame_suspected is true when damage suggests the frame may be bent (crushed corners, pushed-in wheels, misaligned panel gaps, deployed airbags with heavy front damage).
- vehicle: year/make/model/trim/color only from badges, labels, body shape or text visible in the photos; say what you used in identified_from. If a door-jamb label shows a build date (MM/YY), the model year is that year or the next one. Read the VIN from the VIN-label crop if there is one, character by character; copy a VIN or odometer reading only if you can read every character, otherwise null.
- photo_gaps: angles that are missing or unusable (e.g. "no clear underbody photo").
- summary: 2-3 plain sentences for a used-car manager: what is damaged, how badly, and what the photos cannot show. Physical damage only; no prices.`;

// North American VIN check digit (position 9). A misread VIN almost always fails it.
export function vinCheckDigitOk(vin: string | null): boolean | null {
  if (!vin) return null;
  const v = vin.toUpperCase().replace(/\s/g, '');
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  const map: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
  const weights = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = [...v].reduce((s, ch, i) => s + (/\d/.test(ch) ? Number(ch) : map[ch]) * weights[i], 0);
  return v[8] === (sum % 11 === 10 ? 'X' : String(sum % 11));
}

export async function gradePhotos(vin: string, photos: string[], opts: GradeOptions = {}): Promise<GradeResult> {
  const client = openaiClient();
  if (!client) throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL');
  const { ai, model } = client;
  const views = opts.views ?? [];
  const crops = (opts.crops ?? []).slice(0, GRADE_CONFIG.maxCrops);

  const content = [
    { type: 'text' as const, text: `VIN ${vin}. ${photos.length} photo(s), numbered in order below. Grade all ${PARTS.length} parts and list every problem as json.` },
    ...photos.flatMap((url, i) => [
      { type: 'text' as const, text: views[i] ? `Photo ${i + 1} (${views[i]!.replace(/_/g, '-')} view from the photo classifier):` : `Photo ${i + 1}:` },
      { type: 'image_url' as const, image_url: { url, detail: GRADE_CONFIG.imageDetail } },
    ]),
    ...(crops.length ? [{ type: 'text' as const, text: `${crops.length} close-up crop(s) at full resolution:` }] : []),
    ...crops.flatMap((c, i) => [
      { type: 'text' as const, text: `Crop ${i + 1}, from photo ${c.photo} (${c.kind === 'damage' ? `possible damage on ${c.part}` : c.kind.replace('_', ' ')}: ${c.note}):` },
      { type: 'image_url' as const, image_url: { url: c.image, detail: GRADE_CONFIG.imageDetail } },
    ]),
  ];
  // Reasoning models (gpt-5.x, o-series) take reasoning_effort and reject temperature; gpt-4o is the other way round.
  const sampling = /^(gpt-5|o\d)/.test(model) ? { reasoning_effort: GRADE_CONFIG.reasoningEffort } : { temperature: 0 };

  const started = Date.now();
  const okPhoto = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= photos.length;
  const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await ai.chat.completions.create({
        model,
        ...sampling,
        response_format: { type: 'json_schema', json_schema: { name: 'vehicle_grades', strict: true, schema: SCHEMA } },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
      });
      const raw = JSON.parse(res.choices[0].message.content ?? '');
      // Schema guarantees every part; clamp values the schema can't express.
      const parts = PARTS.map((part) => {
        const p = raw.parts[part];
        const photo = okPhoto(p.evidence_photo) ? p.evidence_photo : null;
        return { part, grade: p.grade, confidence: clamp01(p.confidence), evidence_photo: p.grade === 'unknown' ? null : photo, note: p.note };
      });
      const v = raw.vehicle;
      const photoVin = v.vin_visible ? String(v.vin_visible).toUpperCase().replace(/\s/g, '') : null;
      const checkOk = vinCheckDigitOk(photoVin);
      return {
        photo_views: raw.photo_views.filter((p: { photo: number }) => okPhoto(p.photo)),
        vehicle: {
          year: v.year, make: v.make, model: v.model, trim: v.trim, body_type: v.body_type, color: v.color,
          identified_from: v.identified_from,
          vin_visible: photoVin,
          vin_check_digit_ok: checkOk,
          vin_matches_input: photoVin && checkOk ? photoVin === vin : null,
          odometer_visible: v.odometer_visible, odometer_unit: v.odometer_unit,
        },
        parts,
        damages: raw.damages.map((d: Damage) => ({ ...d, photos: d.photos.filter(okPhoto), confidence: clamp01(d.confidence) })),
        missing_parts: raw.missing_parts.map((m: { item: string; part: string; photos: number[] }) => ({ ...m, photos: m.photos.filter(okPhoto) })),
        flags: raw.flags,
        primary_damage_area: raw.primary_damage_area,
        overall_severity: raw.overall_severity,
        photo_gaps: raw.photo_gaps,
        summary: raw.summary,
        meta: { model, seconds: Math.round((Date.now() - started) / 100) / 10, attempts: attempt + 1, photos: photos.length, crops: crops.length },
      };
    } catch (e) {
      lastError = (e as Error).message;
      console.warn(`OpenAI grading attempt ${attempt + 1} failed: ${lastError.slice(0, 200)}`);
    }
  }
  throw new Error(`Photo grading failed: ${lastError.slice(0, 200)}`);
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      endpoint: 'POST /api/grade-photos',
      body: {
        vin: '17-character VIN', photos: ['data:image/jpeg;base64,... (resized to ~1000px, up to 30)'],
        views: ['optional, per photo: view from /api/classify-photos, or null'],
        crops: [{ photo: 1, kind: 'damage | vin_label | odometer', part: 'part name or none', note: '...', image: 'data:image/jpeg;base64,...' }],
      },
      returns: 'vehicle, parts[25] {part, grade, confidence, evidence_photo, note}, damages[], missing_parts[], flags, primary_damage_area, overall_severity, photo_gaps, summary, meta',
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const { vin, photos, views, crops } = req.body ?? {};
  const cleanVin = typeof vin === 'string' ? vin.trim().toUpperCase() : '';
  if (!VIN_RE.test(cleanVin)) return res.status(400).json({ error: 'vin must be 17 characters (no I, O or Q)' });
  if (!Array.isArray(photos) || photos.length === 0 || photos.length > GRADE_CONFIG.maxPhotos) {
    return res.status(400).json({ error: `photos must be an array of 1 to ${GRADE_CONFIG.maxPhotos} images` });
  }
  if (!photos.every((p) => typeof p === 'string' && PHOTO_RE.test(p))) {
    return res.status(400).json({ error: 'each photo must be a base64 data URL (JPEG, PNG or WebP)' });
  }
  if (views !== undefined && (!Array.isArray(views) || !views.every((v) => v === null || typeof v === 'string'))) {
    return res.status(400).json({ error: 'views must be an array of view names or null' });
  }
  const cropsOk = crops === undefined || (Array.isArray(crops) && crops.length <= GRADE_CONFIG.maxCrops && crops.every((c) =>
    c && Number.isInteger(c.photo) && c.photo >= 1 && c.photo <= photos.length && typeof c.image === 'string' && PHOTO_RE.test(c.image)));
  if (!cropsOk) return res.status(400).json({ error: `crops must be up to ${GRADE_CONFIG.maxCrops} {photo, kind, part, note, image} with a valid photo number and data URL` });
  try {
    return res.status(200).json(await gradePhotos(cleanVin, photos, { views, crops }));
  } catch (e) {
    return res.status(502).json({ error: (e as Error).message });
  }
}

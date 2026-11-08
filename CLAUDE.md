# Underscope — UB Hacking demo

## What we're building
A demo for ACV (now owned by Copart) that looks at photos of a damaged vehicle and recommends: **fix it and sell, or sell as-is**. It does NOT predict an exact price; it compares two price *ranges* and says which option likely nets more, or "too close to call".

This is a 24-hour hackathon build. Keep everything simple. Do not add features outside this file.

## Where this fits (background, not scope)
The demo is the first thin slice of a larger plan in two docs by Artem Denisenko, both in the repo root:
- `Underscope_Channel_Routing_Intelligence_—_Research_Plan,_Requirements.pdf` (Nov 5, 2026): research findings, requirements, architecture, 90-day plan
- `Build plan.pdf` (Nov 6, 2026): 14 build steps, model training plan, codemap, deployment architecture

Read them only when a task needs the bigger picture; this file is the source of truth for the demo. The full product is a channel-routing engine (ACV wholesale vs Copart lanes vs parts vs direct buyer); the demo is its two-channel version. Ideas the demo keeps: ranges and a probability of winning, never a single price; a close call names the one check that would change it; things photos can't show become `unknown` and widen the band; misses are weighted by dollars. Everything else in the docs is post-hackathon. The "Do NOT build" list below wins over the docs.

## Scope
- Vehicles: all passenger vehicles (cars, SUVs, pickups, vans).
- 20 test vehicles in `test_vehicles/<id>/` (photos only, used for testing, never training).

## Stack
- Front end: Lovable app (React + TypeScript), hosted on Vercel.
- Back end: Vercel serverless functions in `api/` (TypeScript). All AI calls happen here, never in the browser.
- AI: OpenAI only, called at request time (team decision: no model training; not feasible in the hackathon window). Package `openai`, key `OPENAI_API_KEY` (Karthik's credit).
  - Photo grading `api/grade-photos.ts`: `OPENAI_MODEL` (currently `gpt-5.5`), client from `openaiClient()` in `api/_lib/openai.ts`.
  - Photo classification `api/classify-photos.ts`: `OPENAI_CLASSIFY_MODEL` (default `gpt-4o-mini`).
  - Fault-code explanations `api/decode-codes.ts`: `OPENAI_CODES_MODEL` (defaults to `OPENAI_MODEL`); strict JSON schema, "unknown" allowed. About 9 s with gpt-5.5; set `OPENAI_CODES_MODEL=gpt-4o-mini` if speed matters more.
  - Gemini/Vertex was removed. The Google Cloud project (`project-45b188c0-b276-4e00-a94`, service account `underscope-vertex`) is no longer used by the app.
- Database: Supabase (Postgres), project `zkewmumlgbofqonxpwin`. Tables are small and demo-only; row level security on. Migrations in `supabase/migrations/`.
- Secrets only in environment variables (`.env` locally, Vercel project settings in production): `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_CLASSIFY_MODEL`, `OPENAI_CODES_MODEL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server only), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (front end). Never hardcode or commit keys.

## Repo layout
- `api/` — Vercel functions (`decode-codes.ts` = fault codes module)
- `scripts/` — seed and test scripts, run with `npm run <name>` (tsx)
- `supabase/migrations/` — SQL migrations
- `data/` — `dtc_codes.csv` (seeds the `dtc_codes` table), `test_scans.json` (10 demo scans)
- `test_vehicles/` — test photos, gitignored
- `engine/` — Artem's Python engine (merged from denisenkoartem/underscop with its history): damage detector, evaluation harness, calibration, review sheets, JSON Schema contracts (`engine/docs/contracts`). It has its own `CLAUDE.md` and `README.md`; read those when working inside `engine/`. Setup: `cd engine && python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"` (Windows) then `.venv/Scripts/python -m pytest -q`. Its vision detector uses OpenAI (`--detector openai`, `OPENAI_API_KEY` from the nearest `.env`); `underscope check VIN --photos DIR` runs a real car, `underscope learn` refits confidence calibration from checker-confirmed reviews.
  - Routing (ACV vs Copart): `POST /api/route` (`api/route.py`, Vercel Python function; deps in root `requirements.txt`; `vercel.json` ships `engine/src` and `engine/config`) maps the page's inputs through `engine/src/underscope/bridge.py` and returns the engine's destination and four exits. The page shows it as "Where to send it".
  - Known gap: `/api/decide` (fix vs sell as-is) and the engine use different repair-cost assumptions (`data/repair_costs.csv` vs `engine/config/assumptions.yaml`), so they can disagree on the same car.

## Part list (25) — every part must appear in model output
front_bumper, hood, grille, left_headlight, right_headlight, windshield, left_front_fender, right_front_fender, left_front_door, right_front_door, left_rear_door, right_rear_door, left_mirror, right_mirror, left_rear_quarter, right_rear_quarter, tailgate_or_rear_doors, rear_bumper, left_taillight, right_taillight, wheels_and_tires, roof, interior (seats, dash, airbags), engine_bay (radiator area, leaks), underbody (frame rail, exhaust, catalytic converter)

## Grades
- fine: no visible damage
- repairable: damaged but can be fixed (dent, scratch, crack that can be repaired)
- replace: broken, missing, or too damaged to repair
- unknown: part not visible or unclear in the photos (mandatory option, use it rather than guess)

## Vision call (OpenAI) — built: `api/grade-photos.ts`
- Send all photos of one vehicle in ONE request; resize to ~1000 px long side.
- System prompt demands JSON only. GPT-5 models reject `temperature: 0`, so output is pinned with a strict JSON schema instead (every part is a required key, grades are an enum) plus `reasoning_effort: low`.
- Left/right always mean the vehicle's own sides (driver's seat view); the prompt says so explicitly because models otherwise mix up viewer and vehicle sides.
- Parse the JSON; reject and retry if invalid or any part is missing.
- Output shape:
```json
{
  "parts": [{"part": "hood", "grade": "replace", "confidence": 0.8, "evidence_photo": 2}],
  "flags": {"airbags_deployed": "unknown", "frame_suspected": true, "fluid_leak": false},
  "photo_gaps": ["no clear underbody photo"]
}
```
- API key from environment variable `OPENAI_API_KEY`. Never put it in code or the front end. Uploaded photos are only graded, never used for training.
- Endpoint (owner: Karthik; first version built, tune freely): `api/grade-photos.ts`, `POST { vin, photos }`. The demo page (`public/index.html`) calls it:
  - `photos` is an array of JPEG data URLs (`data:image/jpeg;base64,...`), already resized in the browser to ~1000 px long side, in upload order.
  - `evidence_photo` in the response is 1-based and matches the numbers shown on the page's thumbnails.
  - Return the output shape above with status 200; on failure return a 4xx/5xx with `{ "error": "..." }`.
  - Vercel caps request bodies at ~4.5 MB; the page limits uploads to 30 photos / 4 MB.
  - Create the OpenAI client with `openaiClient()` from `api/_lib/openai.ts`. Tuning knobs (image detail, reasoning effort, max photos) are in `GRADE_CONFIG`.
  - Two stages (Karthik): `POST /api/classify-photos` uses a cheap model (`OPENAI_CLASSIFY_MODEL`, default `gpt-4o-mini`, ~3 s) to label each photo's view (front_right, left_side, ...) and box close-up regions; the page cuts full-resolution crops and sends `views` + `crops` to `/api/grade-photos`. Side rule the models use: if the vehicle's nose points to the right edge of the picture, you're looking at its right side. Grading took ~30 s for one photo in testing; watch the 60 s Vercel limit on large photo sets.

## Fault codes module (owner: Tim) — built: `api/decode-codes.ts`
Input: VIN + list of OBD-II trouble codes from a scan tool (e.g. ["P0300", "C1232"]).
Steps:
1. Validate format: letter + 4 characters. Letter = system: P powertrain, C chassis, B body, U network. Second character 0 = generic (same meaning for all makes), 1 = manufacturer-specific (meaning depends on make from VIN).
2. Generic codes: look up the description in the Supabase table `dtc_codes` (code, description, system, severity, cost_low, cost_high), seeded from `data/dtc_codes.csv`.
3. Manufacturer-specific or not found: ask OpenAI to explain it given the make/model from the NHTSA vPIC VIN decode; it must answer "unknown" if unsure, never guess.
4. Map each code to: system (engine, transmission, brakes/ABS, airbag/SRS, electrical, emissions, body), severity (minor, moderate, major, critical) and a repair cost band low/high. Table codes use the costs in `dtc_codes`; OpenAI-explained codes use a cost band per severity from the config object.
5. Output per vehicle (plus `vehicle` from vPIC and a `reason` for the triage):
```json
{
  "codes": [{"code": "P0300", "description": "Random/multiple cylinder misfire", "system": "engine",
             "severity": "major", "cost_low": 150, "cost_high": 2500, "source": "generic_table"}],
  "summary": {"count": 1, "worst_severity": "major", "cost_low": 150, "cost_high": 2500},
  "triage": "full_inspection",
  "reason": "1 code(s), none critical; inspection worth doing."
}
```
6. Triage rule: if many codes or any critical ones (airbag deployed, transmission, major engine), set "triage": "skip_inspection_sell_as_is", because a full inspection isn't worth the time and money. Thresholds live in one config object (`CONFIG` at the top of `api/decode-codes.ts`).
7. Code costs are added to the repair band; critical codes also widen the band like an unknown flag.
9. Demo registry (the VIN → title bridge): Supabase table `vehicles` holds real VINs whose title a teammate verified by hand (`source`: `title_document`, `dealer_listing`, `online_listing`, `nmvtis_report`). RLS on, no policies, so only the server reads it. `GET /api/vehicle?vin=` returns `registered`, `title_status`, `title_state`, `source` (never odometer or notes); the page calls it to fill in the title. In `decode-codes`, a registry record wins over the seller's choice and the response says so in `title_source`. Load records from `data/vehicles.local.json` (gitignored; format in `data/vehicles.example.json`) with `npm run seed:vehicles`. Never commit real VINs. Label demo vehicles as verified or sample; never present a made-up VIN as a real car's history.
8. Title status: entered by the seller on the page (no free API returns title brands by VIN; paid NMVTIS lookups are out of scope). Optional `title_status` in the request: `clean`, `salvage`, `rebuilt`, `flood`, `non_repairable`, `lemon`, `unknown` (default). It is echoed in the response; `flood` and `non_repairable` set triage to `skip_inspection_sell_as_is` (`CONFIG.triage.skipTitles`).

## Repair band — built: `api/_lib/decision.ts` + `data/repair_costs.csv`
Lookup table (CSV) of part x grade -> parts cost low/high, labor hours low/high, paint yes/no. Seller labor rate is an input.
Repair band = sum of rows for flagged parts. If any flag is "unknown" or frame_suspected is true, widen the top of the band by a fixed amount and record the reason.
- `data/repair_costs.csv` holds rough, unverified industry ranges for a generic passenger vehicle. Replace with shop quotes when available.
- Paint adds `paintPerPanel` per painted panel. `airbags_deployed: true` adds an interior replacement if interior isn't already graded replace.
- Widening amounts (top of band only), each recorded with a reason and a check: frame suspected, airbags unknown, fluid leak unknown, each critical fault code, and 5+ parts not visible. Unknown parts are not costed otherwise.
- Every number is in `DECISION_CONFIG` at the top of `api/_lib/decision.ts`. `vercel.json` bundles the CSV with `api/decide.ts`.

## As-is band
Hand-entered per vehicle: 5-10 comparable sold salvage lots + one clean wholesale value with a condition haircut. Band = low/high of comps.
- Entered on the page, or stored per VIN in the registry (`clean_wholesale`, `salvage_comps`, `values_note`) and filled in automatically. At least 3 comps are required.
- After-repair value = clean wholesale × (1 − condition haircut 5–12%) × (1 − title discount). Title discounts: rebuilt/salvage 20–40% (salvage becomes rebuilt after repair), flood 30–50%, lemon 15–30%, unknown 0–20%. `non_repairable` means fixing isn't allowed: verdict `not_fixable`.

## Decision
- fix_net = after_repair_value - repair_band - holding_days * daily_cost - selling_fee
- as_is_net = as_is_band - fee - transport
- Sample each band 1000 times (uniform low..high), count how often fix wins.
- >70%: "fix". <30%: "sell as-is". Otherwise "too close to call" + the check that would change it most (usually the unknown flag).
- Built: `POST /api/decide` (no AI, deterministic: seeded random, separate streams for fix and as-is). Returns repair band with lines and widenings, after-repair value, as-is band, both nets as P10/P50/P90, days, `p_fix`, `verdict` (`fix`, `sell_as_is`, `too_close`, `not_fixable`, or null with `missing`), and `check` for close calls (the widening or unknown title whose resolution moves `p_fix` most).
- Fault-code triage (`full_inspection` / `skip_inspection_sell_as_is`) is only a note about whether a full inspection is worth paying for. It is not the recommendation; the page never shows it as the headline.

## UI (Lovable)
Upload photos + VIN -> part grid with grade and source photo -> both nets with bands and days -> recommendation -> reviewer toggle to change any grade and recompute live.
- Working version: `public/index.html` + `public/app.js` + `public/app.css` (the Vercel demo). One column (the team prefers it): app bar, heading, vehicle form, then the result (vehicle header with title badge, recommendation, both net ranges, then stacked sections for where the numbers come from, condition, fault codes, API response), then sample vehicles. Clicking a part grade or a flag cycles it and calls `/api/decide` again. The Lovable app can call the same four endpoints.
- Look: tool-like, in ACV's palette and type (orange #D34319 actions, #121212 ink, gray scale, Roboto, 4px radii). No marketing hero, no decorative copy. Underscope branding only: never use ACV's logo or present it as an ACV product; keep the footer line saying it's an independent project.
- Integration points (`public/integrate.html`): deep links (`/?vin=&codes=&title=&clean=&comps=&run=1`, `/?sample=<id>`; every result has Copy link), a bookmarklet that finds a VIN on any listing page (validated by check digit) and opens a check, and the four CORS-open APIs. No access to ACV systems is used; CLAUDE.md's "no ACV integration" still holds.
- Sample vehicles: `public/demo_vehicles.json` (made-up VINs, sample grades and values, one per verdict). Real vehicles come from the registry.

## Test
Run all 20 vehicles; compare model grade vs our grade per part in a sheet. Report agreement % and expensive misses (model "fine" where truth is "replace").
Fault codes: `npm run test:codes` runs the 10 demo scans and checks each triage.
Decision: `npm run test:decision` runs every vehicle in `public/demo_vehicles.json` and checks it gets its `expect` verdict.

## Do NOT build
Fine-tuning, dataset downloads, scraping, logins, payments, extra database tables beyond what a step needs, VIN enrichment beyond the free NHTSA vPIC call, any Copart/ACV integration.

## Known limitation
The vision model is weak on dents/scratches, strong on broken glass, missing bumpers, flat tires. Pick demo vehicles where the decision depends on obvious damage.

## Working style
- Keep code short and readable; one file per step where possible.
- Ask before adding dependencies.
- Don't open or read images in test_vehicles/ unless asked.

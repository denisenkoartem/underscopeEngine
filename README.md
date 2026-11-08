# Underscope

**Fix it and sell, or sell it as-is?** Underscope looks at photos of a damaged vehicle, plus its VIN and OBD-II trouble codes. It compares the likely net from repairing and selling against the likely net from selling as-is, and tells you which one probably pays more. When the two are too close to call, it says so and names the one check that would settle it.

Built for UB Hacking as a demo for ACV, which is now part of Copart.

## Live demo

**https://underscope-eight.vercel.app**

- Enter a VIN, title, photos, fault codes and market values, or click a sample vehicle (one for each kind of answer). You get both net ranges on one scale, P(fix wins), the verdict, and for close calls the one check that would settle it.
- Click any part grade or damage flag in the result to change it; the recommendation recomputes live (the reviewer toggle).
- Registered vehicles (real VINs with a verified title and values) fill in their title and values automatically.
- APIs, all with open CORS so the Lovable app can call them:
  - `GET /api/vehicle?vin=`: verified title and values from the demo registry.
  - `POST /api/grade-photos` `{ vin, photos }`: OpenAI grades 25 parts from photos resized to ~1000px.
  - `POST /api/decode-codes` `{ vin, codes, title_status? }`: decoded fault codes and their cost.
  - `POST /api/decide` `{ title_status, grades, flags, codes, values }`: repair band, both nets, P(fix wins), verdict.
- **Integrate** (https://underscope-eight.vercel.app/integrate.html): deep links like `/?vin=...&codes=...&run=1` that any listing page can use, a drag-to-bookmarks **"Fix or sell?" bookmarklet** that pulls the VIN off any listing page and opens a check, and the API calls.
- Every push to `main` deploys automatically.

## How it works

```
photos + VIN + fault codes
        │
        ├─ vision     OpenAI grades 25 parts: fine / repairable / replace / unknown
        │             and flags hidden risks (airbags, frame, fluid leaks)
        ├─ codes      decode DTCs (Supabase table, or OpenAI + NHTSA vPIC for
        │             manufacturer codes) → system, severity, cost band, triage
        └─ decision   repair band (parts + labor, widened for unknowns)
                      as-is band (comparable salvage sales)
                      1,000 Monte Carlo draws → P(fix wins)
                          > 70%  → fix
                          < 30%  → sell as-is
                          else   → too close to call + what to check
```

Every result is a range, never a single price. Photos can't show frame, mechanical or flood damage, so the model marks those `unknown` instead of guessing, and unknowns widen the repair band.

**Scope:** all passenger vehicles (cars, SUVs, pickups, vans).

The front end is a Lovable app. The seller uploads photos and a VIN, then sees a grid of parts with their grades, the two net bands, and the recommendation. A reviewer can change any grade and the numbers recompute live.

## Repo layout

| Folder | What's in it |
|---|---|
| `api/` | Vercel serverless functions (TypeScript). `vehicle.ts`: GET `?vin=` → verified title from the demo registry, if the VIN is in it. `decode-codes.ts`: POST `{ vin, codes, title_status? }` → decoded fault codes + triage. `grade-photos.ts`: POST `{ vin, photos }` → 25 part grades, flags, photo gaps. `decide.ts`: POST → repair band, both net ranges, P(fix wins), verdict. Shared logic in `api/_lib/` |
| `public/` | The demo page and `demo_vehicles.json` (sample vehicles) |
| `scripts/` | Seed and test scripts |
| `supabase/migrations/` | Database schema (`dtc_codes`, `scans`) with row level security |
| `data/` | `dtc_codes.csv` (60 generic OBD-II codes), `test_scans.json` (10 demo scans) |
| `test_vehicles/` | 20 test vehicles (photos only, gitignored) |
| `engine/` | Artem's Python engine: damage detector, evaluation harness, calibration, review sheets, contracts. See `engine/README.md`. Tests: `cd engine && make test` (217 passing) |

**Stack:** Lovable (React + TypeScript) front end on Vercel, Vercel functions in `api/`, OpenAI at request time for photo grading and fault codes (`openai`; no model training), Supabase (Postgres).

## Setup

Requires Node 20+.

```powershell
npm install
copy .env.example .env             # then fill in the values
npm run seed:codes                 # load data/dtc_codes.csv into Supabase
npm run seed:demo                  # decode the 10 demo scans and save them (is_demo = true)
npm run seed:vehicles              # load real, verified VINs from data/vehicles.local.json (gitignored)
npm run test:codes                 # run the 10 scans and print a summary table
npm run test:decision              # run the sample vehicles through the decision and check each verdict
```

Keys are read only from environment variables: `.env` locally, Vercel project settings in production. `OPENAI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are server-only; the front end only gets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## Testing

We run all 20 test vehicles and compare the model's grade with our own grade for each part. We report the agreement rate and the **expensive misses**: parts the model called `fine` that actually need `replace`.

Known limitation: the vision model is good at broken glass, missing bumpers and flat tires, but weak on dents and scratches. Demo vehicles are chosen so the decision rests on obvious damage.

## Beyond the hackathon

This demo is the first slice of a larger **channel-routing engine**. For each scanned vehicle, the engine would rank every channel it could go to: ACV dealer wholesale, the Copart salvage lanes, recyclers, or a direct buyer. Each channel gets a P10/P50/P90 net band, days to cash, dispute risk and the buyer segment most likely to pay. The plan builds it on proxy data first, adds a published data contract so Copart/ACV data can plug in later, and evaluates it with a backtest harness. It runs in three 30-day phases: mechanism, then evidence, then a shadow-mode pilot. The research plan and build plan documents have the details.

Not in this demo: fine-tuning, scraping, a database, logins, payments, or any Copart/ACV integration.

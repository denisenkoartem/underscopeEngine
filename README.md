# Underscope

**Fix it and sell, or sell it as-is, and on which marketplace?** Underscope takes a VIN and the seller's own description of a damaged vehicle. It compares the likely net from repairing and selling against the likely net from selling as-is, and tells you which one probably pays more. When the two are too close to call, it says so and names the one check that would settle it.

It uses no paid service: no AI call, no database, no keys.

Built for UB Hacking as a demo for ACV, which is now part of Copart.

## Demo

Run it locally with `npm run dev` (http://localhost:3000). It is not deployed anywhere right now.

- Enter a VIN and describe the vehicle in the one text box: title, mileage, damage, clean wholesale value and what similar damaged vehicles sold for, plus anything else. Or click a sample vehicle (one for each kind of answer). You get where to send it, both net ranges on one scale, P(fix wins), the verdict, and for close calls the one check that would settle it.
- As you type, the page shows what it has read so far and what it still needs.
- Click any part grade or damage flag in the result to change it; the recommendation recomputes live (the reviewer toggle).
- APIs, all with open CORS:
  - `POST /api/parse-notes` `{ text }`: the description as JSON (title, mileage, state, run status, values, 25 part grades, flags), with the words each value came from and what is still missing. Rules only.
  - `GET /api/vehicle?vin=`: year, make, model and engine from the free NHTSA vPIC decode.
  - `POST /api/decide` `{ title_status, grades, flags, values }`: repair band, both nets, P(fix wins), verdict.
  - `POST /api/route`: the marketplace, ACV or Copart (Python engine in `engine/`).
- **Integrate** (`/integrate.html`): deep links like `/?vin=...&notes=...&run=1` that any listing page can use, a drag-to-bookmarks **"Fix or sell?" bookmarklet** that pulls the VIN off any listing page and opens a check, and the API calls.

## How it works

```
VIN + the seller's description
        │
        ├─ parser     rules read the text into JSON: title, mileage, market values,
        │             25 parts graded fine / repairable / replace / unknown,
        │             and three flags (airbags, frame, fluid leaks)
        ├─ decision   repair band (parts + labor, widened for unknowns)
        │             as-is band (comparable salvage sales)
        │             1,000 Monte Carlo draws → P(fix wins)
        │                 > 70%  → fix
        │                 < 30%  → sell as-is
        │                 else   → too close to call + what to check
        └─ routing    ACV or Copart, from the same inputs and repair estimate
```

Every result is a range, never a single price. What the description does not say stays `unknown` instead of being guessed, and unknowns widen the repair band. Each parsed value is shown with the words it was read from.

**Scope:** all passenger vehicles (cars, SUVs, pickups, vans).

The seller sees what was read from the description, a grid of parts with their grades, the two net bands, and the recommendation. A reviewer can change any grade and the numbers recompute live.

## Repo layout

| Folder | What's in it |
|---|---|
| `api/` | HTTP functions, served by `scripts/dev-server.ts`. `parse-notes.ts`: description → JSON (`reader/src/rules.ts`). `vehicle.ts`: VIN → year, make, model. `decide.ts`: repair band, both nets, verdict (`_lib/decision.ts`). `route.py`: ACV or Copart. `engine.ts`: optional TypeScript engine with the trained reader. |
| `public/` | The demo page and `demo_vehicles.json` (sample vehicles) |
| `scripts/` | Dev servers and the decision test |
| `data/` | `repair_costs.csv` (part × grade → parts cost, labor hours, paint) |
| `reader/` | The reader: the seller's description in, one assessment JSON out (keyword rules, plus the fine-tuned model in `reader/model/` when it is served). See `reader/README.md` |
| `engine/` | Artem's Python engine: damage detector, evaluation harness, calibration, review sheets, contracts. See `engine/README.md`. Tests: `cd engine && make test` (217 passing) |

**Stack:** plain HTML/JS page, HTTP functions in `api/` run by the local dev server (`npm run dev`), rule-based parsing, the free NHTSA vPIC VIN decode. No AI call and no database in the page's path.

## Setup

Requires Node 20+.

```powershell
pnpm install
npm run test:decision              # sample vehicles: notes -> parser -> decision, checks every parsed value and verdict
```

### Run locally

```sh
npm run dev                        # http://localhost:3000: public/ and api/*.ts (PORT=xxxx to change)
python3 scripts/py-api.py          # 127.0.0.1:3001: api/*.py (/api/route); the dev server forwards to it
```

- `POST /api/engine { text }` is off unless `ENGINE_ENABLED=1`. When it is on, the description is also read by the trained reader, and the page shows that reading under the result.
- The trained reader is served by `reader/model/serve.py`; see `reader/model/README.md`.

## Testing

`npm run test:decision` runs each sample vehicle the way the page does. It fails if the parser reads anything other than the sample's title, grades, flags and values, or if the verdict changes.

Known limitation: the parser only understands what its rules cover. General statements ("front end damage"), mechanical faults and fault codes are kept as extra information and not used in the numbers. Wording outside its vocabulary is missed, not guessed.

## Beyond the hackathon

This demo is the first slice of a larger **channel-routing engine**. For each scanned vehicle, the engine would rank every channel it could go to: ACV dealer wholesale, the Copart salvage lanes, recyclers, or a direct buyer. Each channel gets a P10/P50/P90 net band, days to cash, dispute risk and the buyer segment most likely to pay. The plan builds it on proxy data first, adds a published data contract so Copart/ACV data can plug in later, and evaluates it with a backtest harness. It runs in three 30-day phases: mechanism, then evidence, then a shadow-mode pilot. The research plan and build plan documents have the details.

Not in this demo: fine-tuning, scraping, a database, logins, payments, or any Copart/ACV integration.

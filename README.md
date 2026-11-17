# Underscope

**Where should a damaged car go, ACV or Copart, and should it be repaired first?** Underscope takes
a VIN and the seller's own description of the vehicle, and returns the marketplace, the net-proceeds
range of every exit the title allows, and whether repairing first pays.

Built for UB Hacking as a demo for ACV, which is now part of Copart. Underscope is an independent
project and uses no ACV or Copart systems.

## What is real and what is not

Read this before the numbers.

- **Real:** the pipeline. A description is read into structured facts with the words each fact came
  from, a parts table prices the repair, rules decide which marketplaces the title allows, and a
  simulation and a small model choose between them. All of it is tested and runs with no paid
  service, no database and no keys.
- **Placeholder:** every market number. Fees, discounts, timings and value curves in
  `engine/config/assumptions.yaml` are reasoned guesses, each labelled as such. ACV's and Copart's
  fee schedules are not public.
- **Simulated:** the marketplace model's training data. It learned from made-up cars labelled by the
  engine's own simulation. Its accuracy figures say how closely it copies that simulation, not how
  often it is right about the market. No real sale outcomes are in this repo.

## How it works

```
VIN + the seller's description
        │
        ├─ reader      description → one JSON of facts (title, mileage, values, 25 part grades,
        │              flags, run status, ...), each with the words it was read from.
        │              Keyword rules always; a fine-tuned small model as well when it is switched on.
        ├─ repair      part × grade lookup → repair cost range, with allowances for what is unchecked
        └─ engine      title, flood and seller rules → allowed exits
                       1,000 simulated outcomes per exit → net-proceeds ranges
                       router model → chance ACV nets more than Copart
                       → ACV or Copart, clear / close call / not enough to go on
```

What the description does not say stays `unknown`. It is never guessed, and it widens the ranges and
lowers the stated precision instead.

## Run it

Requires Node 22, pnpm 9 and Python 3.11+.

```sh
pnpm install
cd engine && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]" && cd ..

npm run dev                              # http://localhost:3000: the page and the TypeScript APIs
engine/.venv/bin/python scripts/py-api.py   # 127.0.0.1:3001: /api/route; the dev server forwards to it
```

Open the page, enter a VIN and fill in the boxes, or open one of the sample vehicles.

## APIs

All accept cross-origin requests. `public/integrate.html` shows deep links and a bookmarklet.

| Endpoint | In | Out |
|---|---|---|
| `GET /api/vehicle?vin=` | a VIN | year, make, model, engine (free NHTSA vPIC decode) |
| `POST /api/parse-notes` | `{ text }` or `{ fields, text }` | the reader's JSON, with `evidence`, `missing` and `questions` |
| `POST /api/repair-estimate` | `{ grades, flags?, labor_rate? }` | repair cost range, one line per damaged part |
| `POST /api/route` | the reader's JSON + `vin`, `vehicle`, `repair` | marketplace, `p_acv`, confidence, every allowed exit with its range, notes |
| `POST /api/engine` | `{ text }` | the reader's JSON from the rules and the trained model together; off unless `ENGINE_ENABLED=1` |

## Repo layout

| Folder | What's in it |
|---|---|
| `api/` | The HTTP functions above. `_lib/repair.ts` is the repair estimate; `route.py` calls the engine. |
| `public/` | The demo page (`index.html`, `app.js`, `app.css`), `integrate.html`, and `demo_vehicles.json`. |
| `reader/` | The reader: one contract (`src/contract.ts`), keyword rules (`src/rules.ts`), the model reader (`src/model.ts`), and `model/` to train and serve it. See `reader/README.md`. |
| `engine/` | The Python routing engine: rules, simulation, router model. See `engine/README.md`. |
| `data/` | `repair_costs.csv`; `sample_user_inputs.jsonl` and its sources note (real texts collected for reader training). |
| `scripts/` | The two local servers, the sample test, and the sample-input preparation script. |
| `docs/` | Planning documents. |

## Tests

```sh
npm run typecheck && npm run typecheck:reader
npm run test:reader        # reader unit tests
npm run test:samples       # each sample vehicle: boxes → reader → repair estimate
cd engine && make test lint
```

CI (`.github/workflows/ci.yml`) runs all of these on every pull request.

## Measured so far

- **Reader, keyword rules:** 82.5% of the facts a description states are read correctly, on 191
  hand-written descriptions.
- **Reader, rules plus the fine-tuned model:** 95.2% on the same set, from one training run. The
  model also invents about five times as many values as the rules (0.97 against 0.18 per
  description), so it is not switched on in the page.
- **Router model:** agrees with the full-information simulation on 94.4% of made-up test cars when
  the description is complete, 69.3% when a needed fact is missing. See `engine/reports/router.md`.

## Known limits

- The reader's rules only understand wording they cover. General statements ("front end damage")
  are kept as extra information, not turned into numbers.
- The repair table is rough ranges for a generic passenger vehicle, not shop quotes.
- A car sells once, in one channel. Training the marketplace model on real outcomes needs data that
  shows both sides, which only a partnership can provide.

Not in this demo: scraping, a database, logins, payments, paid APIs, or any Copart/ACV integration.

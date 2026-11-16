# Underscope — UB Hacking demo

## What we're building
A demo for ACV (now owned by Copart) that reads a seller's description of a damaged vehicle and recommends: **fix it and sell, or sell as-is**. It does NOT predict an exact price; it compares two price *ranges* and says which option likely nets more, or "too close to call".

This is a 24-hour hackathon build. Keep everything simple. Do not add features outside this file.

## Where this fits (background, not scope)
The demo is the first thin slice of a larger plan in two docs by Artem Denisenko, both in the repo root:
- `Underscope_Channel_Routing_Intelligence_—_Research_Plan,_Requirements.pdf` (Nov 5, 2026): research findings, requirements, architecture, 90-day plan
- `Build plan.pdf` (Nov 6, 2026): 14 build steps, model training plan, codemap, deployment architecture

Read them only when a task needs the bigger picture; this file is the source of truth for the demo. The full product is a channel-routing engine (ACV wholesale vs Copart lanes vs parts vs direct buyer); the demo is its two-channel version. Ideas the demo keeps: ranges and a probability of winning, never a single price; a close call names the one check that would change it; things photos can't show become `unknown` and widen the band; misses are weighted by dollars. Everything else in the docs is post-hackathon. The "Do NOT build" list below wins over the docs.

## Scope
- Vehicles: all passenger vehicles (cars, SUVs, pickups, vans).

## Stack
- Front end: Lovable app (React + TypeScript).
- Back end: HTTP functions in `api/` (TypeScript), run locally by `scripts/dev-server.ts` (`npm run dev`); `api/*.py` by `scripts/py-api.py`. Request/response types are in `api/_lib/http.ts`. Vercel and Docker are disconnected for now (2026-11-16): no `vercel.json`, no `@vercel/node`, no Dockerfiles. The old Docker setup is on the local branch `archive/docker`. All AI calls happen here, never in the browser.
- No paid services (decided 2026-11-16): the page and its APIs make no AI call, use no database and need no keys. Removed and kept on the local branch `archive/photos-and-codes`: OpenAI photo grading (`grade-photos`, `classify-photos`), the fault-code decoder (`decode-codes`, `dtc_codes`), and the Supabase registry with its migrations. The engine's router model (see "Do NOT build") runs locally and costs nothing.
- What paid lookups would have given (title brand, clean wholesale value, salvage comps) the seller types instead, in one description box. See "Seller description".
- The only outside call is the free NHTSA vPIC VIN decode (`GET /api/vehicle?vin=` -> year, make, model, engine, `check_digit_ok`).
- `.env` is only needed for the optional `/api/engine` (see "Do NOT build").

## Repo layout
- `api/` — HTTP functions: `parse-notes.ts`, `vehicle.ts`, `decide.ts`, `route.py`, `engine.ts`
- `scripts/` — dev servers and `test-decision.ts`
- `data/` — `repair_costs.csv`
- `reader/` — the reader (`@underscope/reader`): the seller's description in, one assessment JSON out (`reader/src/contract.ts`). It decides nothing; the engine analyzes the JSON. `read()` in `reader/src/read.ts` is the only entry point: the keyword rules (`rules.ts`) always read, the trained model (`model.ts`) reads too when `PARSER_BASE_URL` is set, and `merge()` is the one place that decides what the output says when they differ. `reader/model/` trains and serves the model. Root `npm run engine -- read "<text>"`, `npm run test:reader`. Install with `pnpm install` (one lockfile). See `reader/README.md`.
- `docs/` — plans (`plan.pdf`, `build-plan.md`, `ratings-standardization-plan.md`, `team.md`) and `docs/engine/` (the Python engine's CODEMAP, CONTRACTS, PITCH, PROGRESS, TASK). `docs/RULES.md` is the earlier team rule book; no code reads it.
- `engine/` — Artem's Python engine (merged from denisenkoartem/underscop with its history): damage detector, evaluation harness, calibration, review sheets, JSON Schema contracts (`engine/contracts`; its docs are in `docs/engine/`). It has its own `CLAUDE.md` and `README.md`; read those when working inside `engine/`. Setup: `cd engine && python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"` (Windows) then `.venv/Scripts/python -m pytest -q`. Its vision detector uses OpenAI (`--detector openai`, `OPENAI_API_KEY` from the nearest `.env`); `underscope check VIN --photos DIR` runs a real car, `underscope learn` refits confidence calibration from checker-confirmed reviews.
  - Routing (ACV vs Copart): `POST /api/route` (`api/route.py`, served locally by `scripts/py-api.py`; deps in root `requirements.txt`) maps the page's inputs through `engine/src/underscope/bridge.py` and returns the marketplace (ACV or Copart). The page shows it as "Where to send it".
    - The title decides the allowed exits first (`lanes` in `engine/config/assumptions.yaml`). Salvage, flood and non-repairable go to Copart only until ACV confirms its branded-title policy. Part-out is off: dismantlers already bid on Copart.
    - Input: the reader's Assessment (`reader/src/contract.ts`), mirrored in `engine/src/underscope/assessment.py` (schema `engine/contracts/assessment.schema.json`; a test compares the two). Every key is optional and unknown keys are ignored. The page sends the whole parsed record plus `vehicle` and `repair`.
    - The seller's `lanes_allowed` removes marketplaces after the title does (`decided_by: seller_limit`).
    - Facts beyond damage (run status, keys, engine, transmission, flood or fire signs, airbags, catalytic converter, odometer status, title in hand, lien) change repair cost, prices or holding days (`condition` in `engine/config/assumptions.yaml`, all PLACEHOLDER). A fact that is not stated is not guessed: it takes its bad value in a set share of the simulated outcomes. Accepted but not used in the numbers yet: seller type, title state, zip, drivetrain, fuel type, primary and secondary damage, parts missing, already repaired, warning lights, codes, symptoms, purchase price, repair quote, reserve price, storage cost, sell-by days.
    - Who decides (`decided_by`): the title rule or the seller's limit when one marketplace is left; otherwise the **router model** (`engine/src/underscope/router.py`, file `engine/models/router.joblib`), a scikit-learn classifier that gives `p_acv`; the dollar simulation when the model file or scikit-learn is missing, or when the clean value or 3 comps are missing. The simulation always supplies the dollar ranges (`p_acv_simulation`), and a model answer it disagrees with becomes a review reason and at most a `close_call`.
    - What the model sees: the reader's JSON itself (`router.features`: clean value, comps as a share of it, the 25 grades, flags, run status, keys and every other reader field), nothing computed by the engine's formulas. What it learns from: rows of `{assessment, outcome: {acv_net, copart_net}}` (`engine/contracts/router-training-row.schema.json`).
    - Today those rows are made-up cars labelled by the engine's own simulation (`underscope train-router`, report in `engine/reports/router.md`), so the model copies the simulation and knows nothing about real sales. The page says so under the answer. With recorded outcomes: `underscope train-router --data rows.jsonl`; `underscope router-data --out rows.jsonl` writes a template in that format. Retrain after any change to `assumptions.yaml` or to the features.
    - Hand-set numbers live only in `engine/config/assumptions.yaml`, each section labelled PLACEHOLDER: grade-to-damage mapping (`grades`), condition effects (`condition`), the made-up training cars (`router_training`), thresholds (`routing`).
    - `p_acv` is the chance that ACV's best exit nets more than Copart. `confidence` is `clear` at ≥0.70 or ≤0.30, `close_call` in between, and `insufficient` without a clean value and 3 comps. Two ACV exits overlapping is not a close call.
    - An unknown title runs as clean and as salvage. When the two disagree: `verify_first: "Confirm the title brand"`.
    - `input_checks` flags an ACV as-is price the comps can't support.
  - Known gap: the page sends `/api/decide`'s repair estimate to the engine, but the two still use different title discounts, holding costs and fees (`DECISION_CONFIG` vs `engine/config/assumptions.yaml`), so their repair-or-sell-as-is answers can disagree on the same car.

## Part list (25) — every part must appear in the parser's output
front_bumper, hood, grille, left_headlight, right_headlight, windshield, left_front_fender, right_front_fender, left_front_door, right_front_door, left_rear_door, right_rear_door, left_mirror, right_mirror, left_rear_quarter, right_rear_quarter, tailgate_or_rear_doors, rear_bumper, left_taillight, right_taillight, wheels_and_tires, roof, interior (seats, dash, airbags), engine_bay (radiator area, leaks), underbody (frame rail, exhaust, catalytic converter)

## Grades
- fine: no visible damage
- repairable: damaged but can be fixed (dent, scratch, crack that can be repaired)
- replace: broken, missing, or too damaged to repair
- unknown: the description does not cover the part (mandatory option, use it rather than guess)

## Seller description — built: `reader/src/rules.ts`, `POST /api/parse-notes { text }`
The form is a VIN field and one textbox. Its label asks for (input confirmed 2026-11-16): the title (brand, in hand, lien); mileage and whether it is actual, the state, who is selling; whether it runs, keys, engine and transmission; where it was hit, what is damaged part by part and whether the rest is fine; airbags, frame, leaks, flood and fire signs, the catalytic converter; the clean wholesale value and sold prices of at least 3 similar damaged vehicles; a repair quote, the lowest price accepted, deadlines and storage fees; plus anything else.
- `/api/parse-notes` is the reader's keyword rules alone (no AI, no cost) and runs as the seller types, so the page shows "Read so far" and "Still needed" under the box.
- Output: the reader's contract, `reader/src/contract.ts`. The keys the page always used are unchanged; the rest were added on 2026-11-16 (`reader/README.md`, "Criteria"). Shortened:
```json
{
  "reader": "rules", "vin": null, "title_status": "clean", "mileage": 84000, "region": "NY", "run_status": "runs_and_drives",
  "title_in_hand": true, "lien": "none", "seller_type": "dealer", "keys": true, "primary_damage": "front",
  "values": {"clean_wholesale": 24500, "salvage_comps": [9800, 10400, 11200], "repair_estimate": 4200, "reserve_price": 9000, "purchase_price": null},
  "grades": [{"part": "hood", "grade": "replace"}],
  "flags": {"airbags_deployed": false, "frame_suspected": false, "fluid_leak": "unknown", "flood_suspected": "unknown", "fire_damage": "unknown"},
  "evidence": {"title_status": "clean ny title", "grades.hood": "Front bumper, hood and grille need replacing."},
  "missing": ["whether any fluids are leaking"], "could_add": ["whether the catalytic converter is present"],
  "questions": ["Which side is the fender on, driver or passenger?"],
  "additional": ["Owner smoked in it."], "conflicts": []
}
```
- `grades` always holds all 25 parts. A part the text does not mention is `unknown`, unless the text says the rest is fine ("everything else is fine", "no other damage"), which makes unmentioned parts `fine`.
- Left/right are the vehicle's own sides: driver = left, passenger = right. A sided part with no side, or "bumper" with no front/rear, is not guessed: it becomes a question.
- Flags are three-way. A negation near the keyword gives `false`; "not sure", "not checked" or a question mark gives `unknown`.
- Every value has the words it was read from in `evidence`. `missing` lists what the decision cannot run without, `could_add` what would sharpen it. Sentences nothing was read from go to `additional` and are not used in the numbers.
- A damage area (`primary_damage`, `secondary_damage`) is set only when the text names one ("front end hit", "hail damage"), never from a single damaged part.
- Where `/api/engine` is on (`ENGINE_ENABLED=1`), `POST /api/engine { text }` returns the same JSON read by the rules and the trained model together (`reader: "rules+model"`), with `conflicts` listing what they read differently.

## Repair band — built: `api/_lib/decision.ts` + `data/repair_costs.csv`
Lookup table (CSV) of part x grade -> parts cost low/high, labor hours low/high, paint yes/no. Seller labor rate is an input.
Repair band = sum of rows for flagged parts. If any flag is "unknown" or frame_suspected is true, widen the top of the band by a fixed amount and record the reason.
- `data/repair_costs.csv` holds rough, unverified industry ranges for a generic passenger vehicle. Replace with shop quotes when available.
- Paint adds `paintPerPanel` per painted panel. `airbags_deployed: true` adds an interior replacement if interior isn't already graded replace.
- Widening amounts (top of band only), each recorded with a reason and a check: frame suspected, airbags unknown, fluid leak unknown, and 5+ parts not described. Unknown parts are not costed otherwise.
- Every number is in `DECISION_CONFIG` at the top of `api/_lib/decision.ts`.

## As-is band
Hand-entered per vehicle: 5-10 comparable sold salvage lots + one clean wholesale value with a condition haircut. Band = low/high of comps.
- Typed by the seller in the description and read by the parser. At least 3 comps are required.
- After-repair value = clean wholesale × (1 − condition haircut 5–12%) × (1 − title discount). Title discounts: rebuilt/salvage 20–40% (salvage becomes rebuilt after repair), flood 30–50%, lemon 15–30%, unknown 0–20%. `non_repairable` means fixing isn't allowed: verdict `not_fixable`.

## Decision
- fix_net = after_repair_value - repair_band - holding_days * daily_cost - selling_fee
- as_is_net = as_is_band - fee - transport
- Sample each band 1000 times (uniform low..high), count how often fix wins.
- >70%: "fix". <30%: "sell as-is". Otherwise "too close to call" + the check that would change it most (usually the unknown flag).
- Built: `POST /api/decide` (no AI, deterministic: seeded random, separate streams for fix and as-is). Returns repair band with lines and widenings, after-repair value, as-is band, both nets as P10/P50/P90, days, `p_fix`, `verdict` (`fix`, `sell_as_is`, `too_close`, `not_fixable`, or null with `missing`), and `check` for close calls (the widening or unknown title whose resolution moves `p_fix` most).

## UI (Lovable)
VIN + description -> what was read from it -> part grid with grades -> both nets with bands and days -> recommendation -> reviewer toggle to change any grade and recompute live.
- Working version: `public/index.html` + `public/app.js` + `public/app.css` (the demo page). One column (the team prefers it): app bar, heading, vehicle form, then the result (vehicle header with title badge, recommendation, both net ranges, then stacked sections for where the numbers come from, condition, what was read from the description, API response), then sample vehicles. Clicking a part grade or a flag cycles it and calls `/api/decide` again. The Lovable app can call the same endpoints.
- Look: tool-like, in ACV's palette and type (orange #D34319 actions, #121212 ink, gray scale, Roboto, 4px radii). No marketing hero, no decorative copy. Underscope branding only: never use ACV's logo or present it as an ACV product; keep the footer line saying it's an independent project.
- Integration points (`public/integrate.html`): deep links (`/?vin=&notes=&run=1`, `/?sample=<id>`; every result has Copy link), a bookmarklet that finds a VIN on any listing page (validated by check digit) and opens a check, and the CORS-open APIs. No access to ACV systems is used; CLAUDE.md's "no ACV integration" still holds.
- Sample vehicles: `public/demo_vehicles.json` (made-up VINs, one per verdict). Each has `notes`, which the page runs through the parser, and the title, grades, flags and values the parser must read from them.

## Test
`npm run test:decision` runs every vehicle in `public/demo_vehicles.json` the way the page does: notes -> parser -> decision. It fails if the parser reads anything other than the sample's title, grades, flags and values, or if the verdict differs from `expect`.

## Do NOT build
Fine-tuning, dataset downloads, scraping, logins, payments, paid APIs or lookups, a database, VIN enrichment beyond the free NHTSA vPIC call, any Copart/ACV integration.

One exception (post-hackathon, approved 2026-11-08): the **reader fine-tune** in `reader/model/`. Why: gpt-4o-mini shuts down 2027-01-14, and OpenAI ends self-serve fine-tuning on 2027-01-06.
- It trains an open-weights model with LoRA (Apache or MIT license) to read the seller's description into the reader's contract (`reader/src/model.ts`). Locally that is Qwen3-1.7B, the size the 8 GB dev GPU can train and serve; a 4B-8B model on a larger GPU if the gates need it.
- It serves the model behind an OpenAI-compatible endpoint, selected with `PARSER_BASE_URL` + `PARSER_MODEL` (`reader/model/serve.py` locally, vLLM in production).
- State on 2026-11-16: the run1 adapter was trained on the old 19-field answer; no model is trained on the new contract yet. Four training sets and a 191-note test set are prepared for a comparison of five runs against the free rules baseline (`reader/model/README.md`). Training starts only when the user says so.
- Allowed for it: synthetic notes and existing published datasets after a license check (never scraped by us). No paid API: the OpenAI teacher-labeling script was removed with the no-paid-services decision.
- Training dependencies live only in `reader/model/requirements.txt`, never in the root `requirements.txt` (that file deploys `api/route.py`).
- The reader model never picks the marketplace; it only extracts. Lane prices stay with per-lane price models.
- `verifyAnswer` stays in front of every model's output, and the model never overrides the rules silently: `merge()` records every difference in `conflicts`.

Second exception (approved 2026-11-16): the **router model** in `engine/` picks ACV or Copart.
- It is a small scikit-learn classifier (no GPU, no paid API), trained only on cars the engine generates and labels with its own simulation, because no open data shows the best channel for a car. Never describe it as trained on market data.
- The title rules and the seller's lane limit always come before it, and the simulation checks it (see "Routing").
- To train it on real outcomes it needs sold prices with both marketplaces' prices known or estimable; that data comes only from a partnership (`docs/engine/DATA_REQUIREMENTS.md`), never from scraping.
- `scikit-learn` is in the root `requirements.txt` because `api/route.py` loads the model; without it the simulation decides.

## Known limitation
The parser only understands what its rules cover. It does not read general statements ("front end damage"), mechanical faults, or fault codes; those land in `additional`. Wording outside its vocabulary is missed, not guessed, so check "Read so far" before running.

## Working style
- Keep code short and readable; one file per step where possible.
- Ask before adding dependencies.

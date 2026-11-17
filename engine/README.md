# Underscope routing engine

Answers one question for a damaged vehicle: **send it to ACV or to Copart?** It also says whether
repairing first pays, and gives a net-proceeds range for every exit the title allows.

The input is the reader's assessment of a seller's description (`reader/src/contract.ts`), plus the
app's repair estimate. The web app calls it through `POST /api/route` (`api/route.py`).

## Read this first

**Every number in `config/assumptions.yaml` is a placeholder.** Fees, discounts, timings and value
curves are reasoned guesses, each labelled `PLACEHOLDER` with a note on the real data that would
replace it. ACV's and Copart's fee schedules are not public.

**The router model is trained on simulated outcomes, not real sales.** Its accuracy figures
(`reports/router.md`) say how closely it copies the engine's own simulation. They say nothing about
how often either is right about the market. No recorded outcomes exist in this repo.

## How a car is routed

1. **Rules first.** The title, the kind of seller, and any limit the seller sets decide which exits
   are allowed (`lanes` in the config). A salvage, flood or non-repairable title goes to Copart only.
   Parting out is off: dismantlers already bid on Copart.
2. **Dollar simulation.** For each allowed exit, 1,000 seeded draws of net proceeds: sale price less
   repair, fees, transport and holding. This always supplies the dollar ranges.
3. **Router model.** When both marketplaces are allowed and the market values are given, a
   gradient-boosted classifier gives the chance that ACV's best exit nets more than Copart
   (`p_acv`). When it disagrees with the simulation, the answer is flagged as a close call.
4. **Confidence.** `clear` at 0.70 or more, or 0.30 or less; `close_call` in between;
   `insufficient` when the description lacks what the decision needs. An unknown title is run as
   clean and as salvage, and the answer says to confirm the title first when the two disagree.

Nothing is assumed silently: every default, inferred part and counted complaint is listed in the
response's `notes`.

## Code map

| File (`src/underscope/`) | What it does |
|---|---|
| `assessment.py` | The input: a pydantic mirror of the reader's contract. A test checks it against `contract.ts`. |
| `intake.py` | Assessment to the engine's vehicle, damage findings and signals. `FIELD_USE` lists what every input field changes. |
| `valuation.py` | Clean value, repair cost, as-is, salvage and after-repair values, with the effect of each stated fact. |
| `decision.py` | The seeded simulation of net proceeds per exit, the ranking and the "what would change the answer" conditions. |
| `router.py` | The router model: features, made-up training cars, training, the held-out report. |
| `bridge.py` | `route(payload)`: rules, simulation and model put together; the function the API calls. |
| `config.py`, `models.py` | Loading `config/assumptions.yaml`; the engine's internal types. |
| `contracts.py` | Writes the JSON Schemas in `contracts/`; a test fails if they drift from the code. |
| `cli.py` | The `underscope` commands below. |

Money is integer cents inside the engine and whole dollars at the API boundary.

## Setup and commands

```sh
cd engine
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
make test          # pytest
make lint          # ruff
```

| Command | What it does |
|---|---|
| `underscope route-assessment FILE` | Route one assessment (`.json`) or one per line (`.jsonl`) and print the routing JSON. |
| `underscope train-router` | Train the router on made-up cars labelled by the simulation; writes `models/` and `reports/router.md`. |
| `underscope router-check` | Measure the engine as it answers (simulation when the clean value and comps are given, model otherwise) on fresh made-up cars; stores the result with the model. Runs at the end of `train-router` too. |
| `underscope train-router --data rows.jsonl` | Train on recorded outcomes instead (format: `contracts/router-training-row.schema.json`). |
| `underscope router-data --out FILE` | Write simulated training rows, as a template for a file of recorded outcomes. |
| `underscope reader-rates` | Measure how often the reader states each fact and save the rates the training cars are hidden with. Retrain afterwards. |
| `underscope contracts [--check]` | Write, or check, the JSON Schemas in `contracts/`. |

After changing `config/assumptions.yaml`, retrain the router: it learned from the simulation those
numbers drive.

## Training on real outcomes

A recorded row is the reader's assessment of a real car plus what it netted on each marketplace, in
dollars after fees, transport and holding. A car sells once, so real data gives one side of that
pair per car. Until both sides exist for some cars, or per-marketplace price models stand in for the
missing side, the model can only repeat the simulation.

## Layout

```
config/      assumptions.yaml (placeholders), reader_given_rates.json
contracts/   JSON Schemas for the engine's two inputs
models/      the trained router and its metadata
reports/     router.md, written by train-router
src/         the package
tests/       pytest suite; fixtures/ holds the reader's sample assessments
```

The photo pipeline this folder once held (damage detector, review sheets, detector evaluation,
calibration, backtest) was removed with photo grading on 2026-11-16. It is on the local branch
`archive/engine-photo-pipeline`.

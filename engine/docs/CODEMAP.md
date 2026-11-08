# UnderScope codemap

How the code is organized, and how each part serves the product idea. An interactive version
(module map with dependencies, one car traced end to end) was published as a Claude artifact;
this file is the copy that lives with the code.

## The idea, and where each piece of it lives

> A decision engine for damaged vehicles. Given images (eventually from ACV's inspection
> scanners) plus vehicle data, it estimates the net proceeds of each disposition path and
> recommends the one with the highest expected margin. Personas: the dealer and the insurance
> adjuster. Pipeline: perception → valuation → decision → CLI. Real ACV and Copart adapters
> are stubs until there is a data partnership.

| Part of the idea | Where it lives | What it does for the idea |
|---|---|---|
| "Given images" | `vision.py`, `perception.py`, `coverage.py` | Turns photos into damage findings (panel, side, type, severity, confidence, box) and knows which parts of the car the photos show |
| "plus vehicle data" | `models.py` (`VehicleRecord`), `data.py` (ACV/Copart stubs) | Defines the vehicle input; the stubs list exactly what a data partnership must supply |
| (Not in the original idea; added at your request) a person confirms the damage | `review.py`, `cli.py confirm` | A wrong finding means a wrong decision, so a checker confirms every car (or only risky ones) before anything is decided |
| "estimates the net proceeds of each disposition path" | `valuation.py`, `config/assumptions.yaml` | Repair cost, repaired / as-is / salvage / parts values, fees, transport, holding, title brands |
| "recommends the one with the highest expected margin" | `decision.py` | Monte Carlo in integer cents over the four paths, ranked by expected net, with range, runner-up and tipping point |
| "dealer and insurance adjuster" | `decision.persona_answer`, `VehicleRecord.insurance_claim` | Answers each persona's own question; only an insurance claim can brand the title |
| "CLI" | `cli.py` | `evaluate`, `confirm`, `batch`, `queue` for decisions; detector tools; `demo`; `contracts` |
| "adapters are stubs until a data partnership" | `data.py`, `docs/DATA_REQUIREMENTS.md`, `config/assumptions.yaml` | Every number is a labeled PLACEHOLDER naming the real data that replaces it; nothing scrapes ACV or Copart |
| Trust: can we believe it? | `detector_eval.py`, `calibration.py`, `backtest.py`, `sensitivity.py` | Scores the detector on labeled photos, calibrates its confidence, backtests the engine against a deliberately wrong world, and shows where each answer flips |
| Showing it | `demo.py`, `docs/PITCH.md` | A walkthrough of three cars with review sheets, no API key needed |
| Plugging it in | `contracts.py`, `docs/CONTRACTS.md`, `docs/contracts/` | Published formats and guarantees for every hand-off |

## One car through the code

1. `cli.evaluate` loads the vehicle (`models.VehicleRecord`). Bad input stops with exit code 2.
2. The detector reads the photos. `vision.ClaudeVisionDetector.detect_photo` asks Claude about
   each photo, with cached answers; `perception.MockDetector` reads labels instead. Then
   `perception.merge_findings` counts a dent seen in two photos once.
3. `review.build_request` lists every area of the car. `coverage` marks sides no photo shows,
   and `risk_reasons` explains what needs a careful look.
4. `review.save` writes `reviews/<VIN>.json` and the HTML sheet. The command waits with exit
   code 3.
5. `cli.confirm` applies the checker's corrections and signs the review off.
6. `cli.evaluate --confirmed` runs `review.is_stale`: if anything changed, the car goes back
   to the checker.
7. `valuation.value_vehicle` converts the findings into dollar ranges.
8. `decision.evaluate` runs the simulation (`simulate`), ranks the paths, produces the
   persona's answer, finds flip points by bisection (`repair_cost_flip`) and writes the
   explanation.
9. `cli.render` prints the result, or `--json` prints it in the recommendation contract.

## Modules

| Module | Stage | Role |
|---|---|---|
| `models.py` | shared | Vehicle, finding, recommendation types; money in integer cents |
| `config.py` | shared | Loads and validates `assumptions.yaml` (ordered ranges, full coverage, PLACEHOLDER labels) |
| `perception.py` | perception | Detector protocol, mock detector, cross-photo merge |
| `vision.py` | perception | Claude vision detector: schema-constrained answers, boxes, views, downscaling, cache, batches, cost |
| `coverage.py` | perception | Photo view → the panel sides it shows; missing views |
| `review.py` | human review | Review request, risk reasons, staleness, checker edits, HTML sheet, queue |
| `review_confirm.js` | human review | The sheet's form that writes the confirm command |
| `valuation.py` | valuation | Repair cost and the value of each exit |
| `decision.py` | decision | Simulation, ranking, persona answers, flip points, explanation |
| `cli.py` | interface | All commands and exit codes |
| `detector_eval.py` | trust | Detector scoring: precision, recall, severity error, calibration, box overlap |
| `calibration.py` | trust | Confidence calibration with a held-out check |
| `labeling.py`, `coco_import.py` | trust | Ground-truth labels by hand or from COCO datasets |
| `data.py` | trust / data | Synthetic and deliberately misspecified data; ACV/Copart stubs |
| `backtest.py`, `sensitivity.py`, `case_studies.py` | trust | Engine accuracy and regret, flip points, fixture write-ups |
| `demo.py` | showing | Pitch walkthrough with drawn photos and review sheets |
| `contracts.py` | integration | Generates the JSON Schemas in `docs/contracts/` |

## Where to start reading

- **The decision:** `decision.evaluate`, then `valuation.value_vehicle`.
- **The human gate:** `review.ReviewRequest.areas` and `cli.evaluate_cmd`.
- **The photos:** `vision.SYSTEM` (the instructions Claude follows) and
  `ClaudeVisionDetector.detect_photo`.
- **The guarantees:** `tests/test_invariants.py` and `docs/CONTRACTS.md`.

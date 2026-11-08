# UnderScope contracts

What each stage of the pipeline accepts, produces and guarantees. The formats are published as
JSON Schemas in [`docs/contracts/`](contracts/), generated from the code with
`underscope contracts`. `tests/test_contracts.py` fails if a schema no longer matches the code,
so the files are always current. Each guarantee below names the test that enforces it.

```
vehicle.json ──► detector ──► review request ──► checker confirms ──► decision ──► recommendation
 (vehicle)       (labels /     (review-request)   (underscope confirm)               (recommendation)
                  detector-answer)
```

## 1. Vehicle (input) · `vehicle.schema.json`

One vehicle, as JSON. Required: `vin`, `year`, `make`, `model`, `mileage` (≥ 0), `region`.

| Field | Meaning |
|---|---|
| `clean_value_cents` | Market value if undamaged, **integer cents**. Optional; without it a placeholder estimate is used. |
| `title_status` | `clean`, `salvage` or `rebuilt` |
| `insurance_claim` | `true` for the adjuster persona. Only then can repair cost past the total-loss threshold brand the title. |
| `photo_refs` | Photo paths relative to `--photo-root` |
| `undercarriage_damage`, `engine_audio_abnormal` | `true`/`false` from inspection, or `null` when not inspected (sent to the checker to verify) |
| `findings` | Optional damage already known, in the finding format below |

An invalid file stops the command with exit code 2 and names the field (`tests/test_cli.py`).

**Real data sources** (`data.py`): `ACVSource` and `CopartSource` are stubs that raise
`NotImplementedError`. Their `REQUIRED_FIELDS` and `docs/DATA_REQUIREMENTS.md` list what a data
partnership must deliver. The project never scrapes either site.

## 2. Damage finding (shared by every stage)

| Field | Meaning |
|---|---|
| `panel` | `front_bumper`, `rear_bumper`, `hood`, `fender`, `door`, `quarter_panel`, `roof`, `windshield`, `frame` |
| `damage_type` | `dent`, `scratch`, `crack`, `crush`, `broken` |
| `severity` | 0 to 1: share of that panel's full repair the damage needs |
| `confidence` | 0 to 1: probability the damage exists as described. It scales expected repair cost. |
| `side` | `left`, `right`, `center`, or `null` when unknown |
| `photo_ref` | Photo it was seen in |
| `box` | Approximate location in that photo: `[left, top, right, bottom]` as fractions 0 to 1, left < right and top < bottom (`tests/test_models.py`) |
| `verified` | `true` once a human checker confirmed or added it |

## 3. Detector

**Interface** (`perception.DamageDetector`): `detect(vehicle) -> list[DamageFinding]`.

- **Merged output.** One finding per (panel, side, damage type) across all photos, at its
  worst severity and highest confidence, so a dent seen twice is costed once
  (`tests/test_vision.py`).
- **Optional extras the CLI reads when present.** `views` (photo → view), `sightings` (photo →
  that photo's own findings with boxes) and `notes` (photo → damage on no modeled panel, such as
  wheels or mirrors).
- **Failure.** A photo that can't be analyzed raises `vision.DetectionError`. The command stops
  with exit code 2 and does not decide on partial findings (`tests/test_cli.py`).

**Claude detector answer** · `detector-answer.schema.json`. This is what the model must return
for each photo, enforced as structured output: `view`, `findings` (each with a `box`), and
`unmapped_damage`. Values are clamped to 0 to 1, boxes are put in order, and empty boxes are
dropped (`tests/test_vision.py`).

**Cost and repeatability.**
- Answers are cached by photo bytes, model, effort and a hash of the prompt and schema. Asking
  about the same photo again returns the same findings and costs nothing.
- Changing the prompt or schema invalidates the cache automatically.
- Every paid command prints an estimate for photos not yet answered and stops with exit code 1
  unless given `--yes` (`tests/test_cli.py`).

**Labels** · `labels.schema.json`. A map of photo ref → findings. The same format serves as
ground truth, saved predictions and mock-detector input.

## 4. Human review · `review-request.schema.json`

Written to `reviews/<VIN>.json` together with the sheet `reviews/<VIN>.html`.

- **When.** In mode `all` (the default), every vehicle gets a review. In `risky` mode, only
  vehicles with a risk reason do: low confidence, missing inspection, frame damage, no damage
  found, unphotographed sides, damage off the modeled panels, or a close call by the decision
  engine (`tests/test_review.py`).
- **Every area is listed** as damaged, verify or clear. That covers all nine panels plus
  undercarriage and engine. While the review is pending, the frame and any panel side no photo
  shows are "verify", never "clear".
- **Lifecycle.** `pending` → `confirmed`. Only `underscope confirm` makes that change. It
  requires a checker name, marks every finding `verified` with confidence 1.0, and records
  `checker` and `confirmed_at`.
- **Edits.** Finding numbers are the ones the checker saw. Edits apply in this order:
  `--severity N:value` (0 to 1), `--remove N` (highest first), `--add panel:type:severity[:side]`,
  then the undercarriage and engine-audio flags.
- **Staleness.** `source_fingerprint` hashes the vehicle data and the detector's findings. If
  either changes, the confirmed review no longer applies and the car goes back to the checker
  (`tests/test_cli.py`).
- **The sheet** shows the car diagram, the checklist, each photo with numbered damage boxes,
  and a form that writes the exact `confirm` command. The form sends and saves nothing
  (`tests/test_review_confirm_js.py`).

## 5. Decision · `recommendation.schema.json`

Output of `evaluate --json`, and one line per vehicle of `batch --out`. Guarantees, from
`tests/test_invariants.py` unless noted:

- `options` covers all four paths (`repair_then_acv`, `acv_as_is`, `copart_salvage`,
  `part_out`), ranked best first by `expected_cents`. `winner` is `options[0].path`.
- All money is **integer cents**, and `p10_cents ≤ p50_cents ≤ p90_cents` for every path.
- Each path's `components` add up to its `expected_cents`, within one cent per component.
- **Deterministic.** The same vehicle, findings and assumptions always give the same
  recommendation, because the Monte Carlo draws are seeded.
- **Monotone.** More severe damage never raises repair, as-is, repaired, salvage or parts
  value.
- **As-is never sells below salvage** (`tests/test_valuation.py`).
- `needs_human_review` is true exactly when `review_reasons` is non-empty.
- `answer` speaks to the persona. For a dealer (`insurance_claim: false`): does the repair pay
  back? For an adjuster: is it a total loss? `flip_conditions` give the repair cost at which the
  answer changes (`tests/test_decision.py`).
- `findings_status` says whether a checker confirmed the findings.

Every number comes from `config/assumptions.yaml`. Each entry there is a labeled PLACEHOLDER
with a note on the real data that would replace it, and the file is validated on load
(`tests/test_config.py`).

## 6. Command line

| Exit code | Meaning |
|---|---|
| 0 | Done |
| 1 | A paid run needs `--yes` (an estimate was printed), or `contracts --check` found drift |
| 2 | Invalid input, or a photo couldn't be analyzed |
| 3 | Waiting: a vehicle is waiting for a checker, or `detect-eval --collect` found the batch still running |

| Command | Reads | Writes |
|---|---|---|
| `evaluate VEHICLE` | vehicle, photos, optional `--confirmed` review | review request and sheet, or the recommendation |
| `confirm REVIEW --checker NAME` | review request | the same review, confirmed |
| `batch DIR` | folder of vehicles | reviews, queue index `reviews/index.html`, `--out` recommendations (JSONL) |
| `queue` | reviews folder | queue index |
| `detect-eval LABELS` | labels, photos or `--predictions` | report; `--save` predictions; `--batch` state |
| `label`, `import-coco` | photos, COCO annotations | labels |
| `calibrate LABELS PREDICTIONS` | labels, predictions | calibration · `calibration.schema.json` |
| `demo` | fixtures | sample photos, reviews, decisions and a walkthrough page |
| `contracts` | the code | `docs/contracts/*.schema.json` |

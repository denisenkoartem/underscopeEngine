STATUS: DONE

# PROGRESS

`STATUS: DONE` refers to the TASK.md milestones (M1-M9) and keeps `run.sh` from restarting
them. Current work is interactive; see the review log below.

## Checklist
- [x] M1-M9 prototype (unattended run, branch agent/2026-11-01-103713, fast-forwarded to main)
- [x] Review and hardening pass (2026-11-01, interactive)

## Review log (2026-11-01)

| # | Finding | Fix |
|---|---|---|
| F1 | Backtest truth came from the engine's own model (circular) | `data.perturbed` world; report shows same-model and misspecified results |
| F2 | Holding cost charged only on the repair path; as-is/Copart sell days drawn but unused | Holding on every sale path |
| F3 | Part-out value ignored damage | PLACEHOLDER `parts.panel_share_of_parts_value`, `damage_type_loss_factor` |
| F4 | As-is value could price below salvage | Floor as-is at expected salvage |
| F5 | Placeholders tuned so the dent case would favor repair | Reverted to untuned values (1.3x, 6%, $40/day); added `underscope.sensitivity` |
| F6 | Any repair past the total-loss threshold branded the title, even a dealer's own | `VehicleRecord.insurance_claim`; branding only on claims |
| F7 | Flip conditions used a closed form that ignored coupling (wrong amount and direction) | Bisection over a repair-cost scale |
| F8 | "Threshold decides" fired at 0.1% branded draws; explanation said "0%" and "decides" together | PLACEHOLDER `simulation.total_loss_min_branded_share` (5%), counterfactual wording |
| F9 | Config had no schema checks | Ordered ranges, percents, cents, enum coverage, draws |
| F10 | "Borderline write-off" fixture sat at 38% repair ratio vs a 75% threshold | Clean value lowered so it sits at 72% |
| F11 | Repaired-value haircut was a flat 6% regardless of damage (decided by user: scale with severity) | `repaired_value_haircut_pct_at_total_damage` (PLACEHOLDER 20%) x damage score |
| F12 | Title factors were exact points, hiding the risk of repairing salvage cars to rebuilt; salvage cars (10% of set) drove ~60% of misspecified regret | PLACEHOLDER [low, expected, high] ranges, one shared draw across statuses |
| F13 | Review flag compared the winner only to the runner-up; a third path (e.g. part-out) could be the real threat | Flag on P(any other path beats the winner) |
| F14 | A totaled insurance claim still sold as-is on a clean title | Branded draws use the salvage factor; as-is sale floored at the salvage sale per draw |

Checked and fine: integer-cents arithmetic, common random numbers, seeding, fee signs.
Confidence-weighted expected repair cost assumes confidence = P(damage exists); a real
detector's confidence must be calibrated for that to hold.

## What the honest numbers say
- With the untuned placeholders, repair rarely wins. It bears ~1.15x repair (hidden-damage
  reserve), a damage-scaled haircut and extra holding, while buyers only discount as-is cars
  by 1.3x repair. The dent case needs a ~2.4x discount for repair to win.
- Mixed set (mostly light damage), misspecified truth: the engine doesn't beat "always as-is"
  ($84 vs $71); on unflagged cars it ties ($53 vs $53).
- Stratified set (200 per band), misspecified truth: it does beat it ($80 vs $90; unflagged
  $50 vs $80). The mixed-set result was driven by easy cases where as-is is nearly always right.
- Mid band is close to a toss-up with "always as-is". Heavy band is ~61% accurate; even with true
  findings and a correct model the ceiling is 66%, because part-out outcomes vary widely. That's
  irreducible without dismantler data; perception adds ~5 points.

## Human-in-the-loop damage review (2026-11-01, user request)
A checker confirms findings before any decision: `underscope.review`, `evaluate` gate
(`--review-mode all|risky`, `--interactive/--no-interactive`, `--confirmed`, `--skip-confirm`),
`underscope confirm`. Every area (9 panels, undercarriage, engine) is listed as damaged /
verify / clear; the HTML sheet draws a top-down car with every damaged area colored by
severity and high-risk unconfirmed areas (frame, missing inspections) dashed. Confirmed
findings become verified with confidence 1.0. Exit code 3 = awaiting confirmation.
"Risky" reuses existing thresholds; no new numbers were added (config/assumptions.yaml was not
in the approved edit list).

## Autonomous session (2026-11-01, "continue building for 1 hour")
Read the user's instruction as approval to edit existing project code, tests and docs for this
work; CLAUDE.md, .gitignore and pyproject.toml were left alone. Added:
- F14 above (totaled claim sells as-is on a salvage title).
- Persona answer on every recommendation (`Recommendation.answer`): dealer "repair pays back /
  does not pay back" with margin and share of draws; adjuster "total loss / borderline / not",
  using a wording cut-off of 80% / 20% of draws (`decision.TOTAL_LOSS_CLEAR`, not a market number).
- `underscope queue` (reviews list + reviews/index.html) and `underscope batch DIR` (decide
  confirmed, queue the rest, `--out` JSONL, exit 3 while any wait).
- Stratified synthetic sets and a stratified section in reports/backtest.md.
- Stale-review protection: requests store a fingerprint of the vehicle data + detected
  findings; a changed car is refused by `--confirmed` and re-queued by `batch`. Invalid vehicle
  files give a one-line error (`evaluate` exits 2, `batch` skips them).

origin/main (PR #1 merge and a CLAUDE.md edit restoring "within 15 seconds") was merged into
local main on user request, keeping the local CLAUDE.md rule. Not pushed.

## Real damage detector, stage 1 (2026-11-01, user request)
User chose: Claude vision first, dependencies in an optional `vision` extra, a public dataset
picked with the user. Built `vision.ClaudeVisionDetector` (claude-opus-5-5, JSON-schema output
restricted to our panels and damage types, severity/confidence rubric, unmapped damage kept as
checker notes, server-side refusal fallback), `detector_eval` (panel/type matching, P/R/F1,
type accuracy, severity MAE, calibration + Brier, frame misses, clean-photo false alarms,
`--match-by type`), and `underscope detect-eval` (paid runs need `--yes`, actual cost reported,
saved predictions re-scored free). `evaluate`/`batch` take `--detector claude --photo-root`.
Not yet run on a single real photo.

Stage 2 (autonomous hour, 2026-11-01): side on findings and cross-photo merging in the vision
detector (the same dent seen in two photos was costed twice); `underscope label` (resumable
ground-truth labeling, `--prefill` from predictions); side-aware matching in the evaluator;
`underscope import-coco` with a mapping YAML and a mapping for the Humans in the Loop class
names; `detect-eval --batch/--collect` (Message Batches, half price); Pillow in the vision
extra to downscale photos over 5 MB or 1568 px.

Stage 3 (autonomous hour, 2026-11-01): photo views and coverage (a panel side no photo shows is
"verify: not photographed" on a pending review, with the missing views listed as a reason);
per-side coloring on the review diagram and sided checker edits; confidence calibration
(`underscope calibrate`, `--calibration` on evaluate/batch/detect-eval).

Stage 4 (autonomous session, 2026-11-01): the review sheet shows each photo with its view and
the findings it supports (findings link to their photo); `calibrate --holdout` checks the table
on photos it wasn't fitted on; `batch --detector claude` now shows a cost estimate and needs
`--yes`, like detect-eval. Also published a codemap artifact of the repo.

Stage 5 (autonomous hour, 2026-11-01):
- fix: Claude's answers are cached (.cache/vision, keyed by photo bytes, model, effort, prompt
  hash). Before, every `batch` re-run paid again, and slightly different answers changed the
  review fingerprint, so confirmed reviews were voided on every re-run with the claude detector.
- Damage boxes: the detector returns an approximate box per finding; the review sheet draws
  every sighting on its photo, numbered by finding. COCO imports carry boxes; detect-eval
  scores them (mean IoU, boxes on target at IoU 0.5).
- fix: EXIF-rotated photos are sent upright so boxes line up with what the browser shows.
- The sheet's box overlay was checked through tests only; no browser is available here to look
  at it.

Stage 6 (autonomous hour, 2026-11-01; user asked for a pitchable demo, contracts, docs and a
codemap tied to the idea):
- The review sheet writes the `confirm` command from the checker's corrections (tested under
  Node); `confirm --severity N:value`.
- `underscope demo`: a walkthrough (demo/index.html) of the three fixture cars with drawn
  photos, review sheets and each car's decision. Also published as a Claude artifact.
- Contracts: `underscope contracts` generates JSON Schemas (docs/contracts/) from the code; a
  test fails on drift. docs/CONTRACTS.md states each stage's guarantees and the enforcing test.
- docs/PITCH.md (script, ask, Q&A) and docs/CODEMAP.md (idea -> code).
- Correction: the built-in estimate is about $0.07 per photo, so the first 20-photo run is about
  $1.40 live or $0.70 as a batch. Earlier messages to the user said $0.45; that was wrong.
- "Contracts" was read as data/interface contracts, not legal agreements; confirm with the user.

### Detector test data (needs the user)
| Dataset | Labels | License / access | Verdict |
|---|---|---|---|
| Humans in the Loop "Car Parts and Car Damages" | 814 damage photos (8 damage types) + 998 parts photos (21 parts), polygons; damage photos have no panel labels | CC0 1.0 (public domain); download via a form on their site | Recommended |
| CarDD (USTC) | 4,000 photos, 6 damage types | Research only; bars "testing commercial systems"; signed form | Not usable for UnderScope |
| Pixemantic Vehicle Damage-29 (IEEE DataPort) | 5,244 photos, parts + damage types | Paid subscription; no license stated | Not usable as is |
| Roboflow "car damaged part segmentation" | damaged-part classes | Page blocked automated access; license and provenance unverified | Not verified |

Plan for the recommended set once the user has it (the form takes their contact details, so
they must request it): check its annotation format (the importer handles COCO; the shipped
mapping uses the class names from the dataset page), `import-coco` with
config/coco_mapping.humans_in_the_loop.yaml, score with `--match-by type --limit 20` first, then
`underscope label --prefill` a sample to get panel, side and severity labels and score those.

### Proposed CLAUDE.md wording (not applied)
"Few dependencies: pydantic, numpy, pandas, pyyaml, typer, pytest. Optional extras may add
more for a specific feature (`vision`: anthropic, pillow); the core install and tests must not
need them."

## Decisions for humans
- Panels aren't left/right in the model, so the diagram colors both sides of a sided panel.
  Real detector output with sides or pixel boxes would let the sheet highlight exact spots
  on the photos.
- Haircut now scales with damage score (repair cost / clean value). 20% at full damage is
  anchored just under the rebuilt-title discount, not tuned. A structural (frame) premium on
  top is a possible refinement.
- `insurance_claim` defaults to false (dealer). On a claim that crosses the threshold, repair
  leads to a `rebuilt` title and as-is sells on a salvage title. The insurer's own costs (owner
  payout, owner-retained salvage) aren't modeled.
- Adjuster wording cut-off (80% of draws = "total loss") is a presentation choice; change
  `decision.TOTAL_LOSS_CLEAR` if adjusters want a different bar.
- Review threshold 0.35 now applies to P(any other path beats the winner) (6% review rate on
  the synthetic set). Raising or lowering it trades review workload for regret.
- Part-out still deducts a tow cost (transport.parts_cents), beyond the TASK.md formula.
- Unknown inspection flags each add an allowance (both missing adds it twice).

## Blockers
- Manual end-to-end CLI demo in the scratchpad (command included `rm -rf` of a scratch dir) was
  denied; not retried. The same flow is covered by tests/test_cli.py via CliRunner.

## Next step
The engine is now limited mostly by data, not logic: parts-value variance caps the heavy band,
and the dent question hinges on the as-is discount multiple. Real data
(docs/DATA_REQUIREMENTS.md) is the main unlock. Without it, the next useful code step is a real
DamageDetector behind the protocol, scored against labeled photos.

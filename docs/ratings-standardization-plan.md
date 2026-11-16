# Plan: standard output ratings for ACV vs Copart fit

**Date:** 2026-11-08. **Scope:** `reader` (the TypeScript engine), with the same vocabulary for `engine/` (Python, `/api/route`) so the page shows one rating language.

**Goal:** each vehicle's output says, in a defined and checkable way, how well it fits ACV, how well it fits Copart, which one fits better and how sure we are.

## 1. What the engine outputs today, and why it is not a standard

The engine's output is built in four steps:
1. Each category scorer (title, drivable, hidden_risk; `src/categoryScoring.ts`) and market fit (`src/marketFit.ts`) returns two free numbers in [-1, 1]: `acv` and `copart`.
2. Each also returns a self-reported `confidence` in [0, 1].
3. `src/combine.ts` sums weight × score × confidence for each lane, then applies a softmax at temperature 0.5. The result is reported as `probabilities`.
4. `confidence` is "clear" at 0.70 or more (`config/weights.json`).

Problems:

| # | Problem | Where it shows |
| --- | --- | --- |
| 1 | The scale has no anchors. Only the ends are described ("strongly against / strongly for"), so each model uses it differently. | gpt-4o-mini answered ±1 on the Levante run (README "Not calibrated"). The untrained local Qwen3-1.7B scored a salvage title −0.5 for Copart (smoke test, 2026-11-08). |
| 2 | Only the difference acv − copart affects the decision, but both levels are shown, so "+0.8/+0.6" and "+0.2/0.0" look different and decide the same. | `utility()` and `softmax()` in combine.ts. |
| 3 | The weight on each score is the model's own `confidence`. It is not tied to what the facts actually say. Market fit from a local model is capped at 0.3; nothing else is capped. | `contribution()`; `LOCAL_MARKET_MAX_CONFIDENCE`. |
| 4 | "probabilities" is a softmax of judgments, not the probability of anything observable, and nothing calibrates it. | README "Not calibrated". |
| 5 | Ratings from different models (gpt-4o-mini, its successor, the local model) are not comparable, and nothing checks a scorer before it is used. | `SCORING_MODEL`, `SCORING_BASE_URL`. |
| 6 | Some inputs distort the scores. Photo body damage becomes "complaints" for the drivable scorer, three photo flags are dropped, and a non-registry title beats a "salvage title" written in the notes. | `src/website.ts` (from the planning agent's review). |
| 7 | The two engines speak different languages: the Python engine gives dollar bands and a destination, the TS engine gives a softmax "probability". | `/api/route` vs `/api/engine`. |

## 2. The rating contract (what each number means)

This replaces the free numbers. Everything in this section is a definition: no score is hardcoded, and the models still judge.

### 2.1 Category levels: five anchored steps per lane

Each category scorer (and market fit) answers, for each lane, one of five levels. The JSON schema makes this an enum, not any float:

| Level | Name | Meaning for that lane's buyers |
| --- | --- | --- |
| +1 | strong fit | This factor alone would make that lane's buyers compete for the car. |
| +0.5 | helps | It widens that lane's buyer pool or raises its bids. |
| 0 | no effect | Buyers in that lane would not care, or the facts say nothing. |
| −0.5 | hurts | It narrows that lane's buyer pool or lowers its bids. |
| −1 | works against | That lane's buyers would mostly pass, or bid far below normal. |

- **ACV** levels are judged in dealer-wholesale terms: will dealers bid near clean wholesale less reconditioning, or avoid the car and arbitration risk?
- **Copart** levels are judged in salvage terms: rebuilder, parts and export demand.
- A shared rubric file (`prompts/_rubric.md`) holds this table, plus one example per level for each lane. Every `score_*.md` and `market_fit.md` includes it.

### 2.2 Evidence: computed in code, replacing the model's self-reported confidence

How much a category counts depends on what the facts actually establish. The table lives in a new `config/ratings.json`:

| Category | complete (1.0) | partial (0.6) | thin (0.25) |
| --- | --- | --- | --- |
| title | brand stated (or registry-verified) | brand from notes only, with a conflict | unknown |
| drivable | run status stated and a code scan read | run status stated, no scan | run status unknown |
| hidden_risk | every flag resolved (yes/no) | 1 or 2 flags unresolved | 3 or more unresolved |
| market_fit | web analysis with 2+ cited signals | web analysis marked insufficient | local model, no web search |

- The model's confidence is still recorded, but it no longer multiplies the score. Option: use the lower of the two values.
- The local-market cap (0.3) becomes the "thin" row.

### 2.3 Lane fit scores, 0–100, shown to people

`fit(lane) = 50 + 50 × Σ_c weight_c × evidence_c × level_c(lane) / Σ_c weight_c`

- 50 is neutral, 100 is every category strongly for the lane with complete evidence, and 0 is every category strongly against.
- Thin evidence pulls the score toward 50, never toward a lane.
- The output reads like "ACV fit 74 · Copart fit 38".

### 2.4 The comparison and its label

`delta = fit(ACV) − fit(Copart)` drives the softmax (same weights and temperature as today), giving `p_acv`. The label comes from `p_acv` and the rules, using one fixed vocabulary:

| Label | When |
| --- | --- |
| `acv_only` / `copart_only` | A rule removed the other lane (title brand, the seller's lane limit). The reason is given. |
| `strong_acv` / `strong_copart` | p ≥ 0.85 for that lane |
| `lean_acv` / `lean_copart` | 0.70 ≤ p < 0.85 (0.70 is today's `clear_threshold`) |
| `too_close` | 0.30 < p_acv < 0.70; the output also names the check that moves it most (today's `verify_first`) |
| `insufficient` | unknown title with 3+ unresolved flags (today's override), or thin evidence on title and drivable |
| `no_lane` | both lanes ruled out |

Until section 4.5 is done, `p_acv` is shown as "lean strength (not calibrated)", not as a probability.

### 2.5 The output block

A new `Decision.fit`. The existing fields stay for one version, so nothing that reads them breaks:

```json
"fit": {
  "label": "lean_acv",
  "lane": "acv",
  "acv": 74, "copart": 38, "delta": 36,
  "p_acv": 0.78, "calibrated": false,
  "evidence": "partial",
  "drivers": [{"category": "title", "acv": 1, "copart": -0.5, "evidence": 1.0, "weight": 0.35}],
  "verify_first": "frame",
  "rule": null,
  "scorers": {"title": "gpt-4o-mini", "market_fit": "local qwen3-1.7b (no web)"},
  "scorer_validated": true,
  "ratings_version": 1
}
```

- `scorer_validated` is false when any scorer has not passed the checks in section 4.
- The page then shows "test only" next to the label.

## 3. Fix the inputs that distort ratings

Each is small and isolated, so it lands before or with section 2:
- **Photo damage:** body damage leaves `reported_symptoms`. Only mechanical photo findings feed drivable, as a separate `photo_findings` fact with its own line in `score_drivable.md`: engine bay, underbody, wheels/suspension, leak, fire. Body damage enters ratings only when repair cost becomes a category (combine.ts TODO(v2)).
- **Photo flags:** map the three that are dropped. `flood_suspected` becomes flood "suspected"; `suspension_damage_suspected` and `fire_damage` become photo findings.
- **Title conflicts:** a title that is not registry-verified and conflicts with the notes becomes `unknown`. The existing clean/salvage branching then decides, and title evidence is "partial". The page sends `title_source`.
- **Name checks:** run `vehicleNameProblem` on the page's make and model before they reach the market prompt.

## 4. Checks that make "accurately" testable

1. **Reference set** (`fixtures/ratings/reference.jsonl`, about 60 vehicles):
   - Sources: the 6 `examples/`, the 15 records in `sample_vehicles.json`, the 8 `fixtures/website/` payloads, and about 30 built to cover the corners.
   - Each gets an expected label from a teammate who knows dealer and salvage buying, written blind to the engine's output.
   - Targets: exact label in 70% or more of cases, within one step in 95% or more, and never the opposite lane on a `strong_*` case.
2. **Contrast checks** (`scripts/ratings/contrast.ts`, free with the local server): pairs that differ in one fact, where the direction is not in doubt.
   - Better facts never lower that lane's level: runs and drives ≥ starts only ≥ doesn't run (ACV); clean ≥ rebuilt ≥ salvage (ACV); every flag "no" ≥ "suspected" ≥ "unknown" (ACV, hidden risk); a confirmed severe code ≤ no codes (ACV).
   - Irrelevant changes (the VIN, the state, the wording of the notes) never move the label.
3. **Scorer gate:** a scorer must pass items 1 and 2 before its ratings count (`scorer_validated`):
   - every new model, including the gpt-4o-mini successor (due before 2027-01-14) and the local Qwen;
   - every edit to a `score_*.md` prompt.
4. **Stability:** the same record gives the same label (the cache already guarantees this), and each run records `ratings_version`.
5. **Calibration** (later, needs data):
   - Once the per-lane price models exist (Track B of the reader plan, sold prices per lane), estimate both lanes' nets for a held-out set.
   - Fit the temperature and thresholds so `strong_*` is right in 85% or more of cases and `lean_*` in 70% or more.
   - Then `p_acv` becomes "P(ACV nets more)", `calibrated` becomes true, and the labels and output keep their shape.
   - Each car sells once, in one lane, so calibration has to use the price models; past lane choices would only teach habit.

## 5. One vocabulary across both engines

The Python engine already samples net proceeds and counts how often the runner-up beats the winner (`engine/src/underscope/decision.py`, `overlap`). That is a real win probability.
- `bridge.py route()` adds the same `label` from P(winner beats runner-up), with the same thresholds, and `acv_only` / `copart_only` when a title rule removes exits.
- The page shows one label language whichever engine answers.
- The owner of `engine/` decides the exact mapping of its four exits (ACV repair, ACV as-is, Copart, parts) onto ACV and Copart.

## 6. Steps, file by file

| Step | Files | Notes |
| --- | --- | --- |
| 1 | `config/ratings.json`, `src/config.ts` | Levels, evidence table, label thresholds, version, all validated with zod. |
| 2 | `prompts/_rubric.md`, `prompts/score_*.md`, `prompts/market_fit.md` | The five-level rubric; prompts include it. |
| 3 | `src/categoryScoring.ts`, `src/marketFit.ts` | Enum levels in the JSON schemas and zod; bump `CACHE_VERSION`. Old cached floats are migrated to the nearest level, so no tokens are spent re-scoring. |
| 4 | `src/title.ts`, `src/drivable.ts`, `src/hiddenRisk.ts` | One pure `evidence()` per category from the record. |
| 5 | `src/combine.ts`, `src/types.ts` | Evidence in place of model confidence; fit scores; `label()`; `Decision.fit`. |
| 6 | `src/explain.ts` | Reasons and risks say the fits and the label ("ACV fit 74 vs Copart fit 38, lean ACV: title drives it"). |
| 7 | `src/website.ts`, `api/engine.ts` | The section 3 fixes; the response carries `fit`. |
| 8 | `fixtures/ratings/`, `scripts/ratings/{contrast,agreement}.ts`, tests | Unit tests for the math and the labels; the contrast suite; the reference-set agreement report. |
| 9 | `engine/src/underscope/bridge.py` | The shared label (with the engine owner). |
| 10 | `README.md` (Decision JSON), CLAUDE.md | Document the contract. |

**Order:**
- Steps 1–6 with unit tests, about 2 days. Nothing calls an API: tests use fakes, and contrast runs use the local server.
- Step 8's reference set needs a teammate for labeling, about a week elapsed.
- Steps 7 and 9 run in parallel with step 8.
- Calibration (section 4.5) comes after the price models.

## 7. Decisions for the user

1. **Evidence replaces the model's self-reported confidence.** Recommended: yes. It is measurable and the same for every model.
2. **Five-level enum instead of continuous scores.** Recommended: yes. Models agree more on named steps, and the extra precision was never real.
3. **The no-hardcoded-scores rule (2026-11-07) stays.** The rubric defines what the levels mean; the model still picks them. Say so if title, which is nearly rule-like, should become a fixed mapping instead.
4. **Label thresholds:** 0.70 (today's clear threshold) and 0.85 for strong.
5. **Who labels the reference set,** and whether body damage stays out of ratings until repair cost is a category.

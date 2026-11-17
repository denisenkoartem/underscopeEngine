# Router model: ACV or Copart

**Trained on simulated outcomes, not real sales.** The training cars are made up and labelled by the engine's own dollar simulation, so these numbers say how closely the model copies the simulation. They say nothing about how often either is right about the market.

- Model: HistGradientBoostingClassifier (scikit-learn 1.9.1), seed 7
- Training cars: 29,994; held out: 7,499
- Features: 74, all read straight from the reader's JSON

| On the held-out cars | |
|---|---|
| Same marketplace as the full-information simulation | 75.6% |
| Same confidence band (clear or close call) | 53.5% |
| Mean error of p_acv | 0.251 |
| ACV is the better marketplace | 53.1% |
| Dollars lost per car by following the model | $403 |
| Dollars lost per miss | $1,651 |
| Largest single miss | $38,917 |

## By how much the description gives

The model sees the car the way the reader would hand it over, with facts hidden. The answer it is scored against is the simulation run on everything about the car. So this is agreement with the engine's own simulation given full information. It is not accuracy on real sales.

| Precision level | Held-out cars | Same marketplace | Dollars lost per car |
|---|---|---|---|
| full (every expected fact given) | 421 | 94.8% | $29 |
| reduced (only helpful facts missing) | 1,735 | 90.3% | $75 |
| low (a needed fact missing) | 5,343 | 69.3% | $539 |
| all | 7,499 | 75.6% | $403 |

## The engine as it answers

The simulation decides when the seller gives the clean value and the comps; the model decides otherwise. Measured on 3,000 fresh made-up cars (seed 1007, not the training cars), against the simulation run on everything about the car. Still agreement with the engine's own simulation, not accuracy on real sales.

| | Cars | Same marketplace |
|---|---|---|
| full (every expected fact given) | 164 | 100.0% |
| low (a needed fact missing) | 1,921 | 70.3% |
| reduced (only helpful facts missing) | 725 | 92.0% |
| the model decides (a money fact missing) | 1,921 | 70.3% |
| the simulation decides (clean value and comps given) | 889 | 93.5% |
| all | 2,810 | 77.6% |

## Sanity check on the reader's own output

The reader's fixture rows (tests/fixtures/reader_assessments.jsonl), where the model decides: does it name the same marketplace as the simulation run on the same incomplete description? Not a training target, and not a measure of being right: with facts missing the simulation itself runs on placeholders.

| Kind of row | Rows | Model decides | Same marketplace as the simulation |
|---|---|---|---|
| rules | 191 | 104 | 70.2% |
| label | 60 | 27 | 66.7% |
| complete | 60 | 0 | n/a |

## Features that matter most

Drop in agreement when the feature is shuffled:

- `comps_median_usd`: 0.077
- `clean_value`: 0.036
- `run_status`: 0.032
- `parts_replace`: 0.030
- `reserve_price_usd`: 0.024
- `title_status`: 0.022
- `engine_condition`: 0.013
- `comps_min`: 0.013
- `comps_max`: 0.012
- `transmission_condition`: 0.008
- `comps_median`: 0.005
- `app_repair_high_usd`: 0.005

Regenerate with `underscope train-router` (add `--data rows.jsonl` for recorded outcomes).

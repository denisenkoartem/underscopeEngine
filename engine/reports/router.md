# Router model: ACV or Copart

**Trained on simulated outcomes, not real sales.** The training cars are made up and labelled by the engine's own dollar simulation, so these numbers say how closely the model copies the simulation. They say nothing about how often either is right about the market.

- Model: HistGradientBoostingClassifier (scikit-learn 1.9.1), seed 7
- Training cars: 30,946; held out: 7,737
- Features: 74, all read straight from the reader's JSON

| On the held-out cars | |
|---|---|
| Same marketplace as the full-information simulation | 75.7% |
| Same confidence band (clear or close call) | 52.8% |
| Mean error of p_acv | 0.253 |
| ACV is the better marketplace | 53.7% |
| Dollars lost per car by following the model | $402 |
| Dollars lost per miss | $1,656 |
| Largest single miss | $38,917 |

## By how much the description gives

The model sees the car the way the reader would hand it over, with facts hidden. The answer it is scored against is the simulation run on everything about the car. So this is agreement with the engine's own simulation given full information. It is not accuracy on real sales.

| Precision level | Held-out cars | Same marketplace | Dollars lost per car |
|---|---|---|---|
| full (every expected fact given) | 432 | 94.4% | $28 |
| reduced (only helpful facts missing) | 1,797 | 90.8% | $70 |
| low (a needed fact missing) | 5,508 | 69.3% | $540 |
| all | 7,737 | 75.7% | $402 |

## The engine as it answers

The simulation decides when the seller gives the clean value and the comps; the model decides otherwise. Measured on 3,000 fresh made-up cars (seed 1007, not the training cars), against the simulation run on everything about the car. Still agreement with the engine's own simulation, not accuracy on real sales.

| | Cars | Same marketplace |
|---|---|---|
| full (every expected fact given) | 167 | 100.0% |
| low (a needed fact missing) | 1,976 | 70.8% |
| reduced (only helpful facts missing) | 746 | 91.8% |
| the model decides (a money fact missing) | 1,976 | 70.8% |
| the simulation decides (clean value and comps given) | 913 | 93.3% |
| all | 2,889 | 77.9% |

## Sanity check on the reader's own output

The reader's fixture rows (tests/fixtures/reader_assessments.jsonl), where the model decides: does it name the same marketplace as the simulation run on the same incomplete description? Not a training target, and not a measure of being right: with facts missing the simulation itself runs on placeholders.

| Kind of row | Rows | Model decides | Same marketplace as the simulation |
|---|---|---|---|
| rules | 191 | 109 | 70.6% |
| label | 60 | 33 | 66.7% |
| complete | 60 | 37 | 75.7% |

## Features that matter most

Drop in agreement when the feature is shuffled:

- `comps_median_usd`: 0.075
- `clean_value`: 0.034
- `run_status`: 0.033
- `parts_replace`: 0.032
- `reserve_price_usd`: 0.023
- `title_status`: 0.019
- `engine_condition`: 0.013
- `comps_max`: 0.013
- `comps_min`: 0.011
- `transmission_condition`: 0.010
- `flag_flood_suspected`: 0.007
- `primary_damage`: 0.006

Regenerate with `underscope train-router` (add `--data rows.jsonl` for recorded outcomes).

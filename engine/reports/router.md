# Router model: ACV or Copart

**Trained on simulated outcomes, not real sales.** The training cars are made up and labelled by the engine's own dollar simulation, so these numbers say how closely the model copies the simulation. They say nothing about how often either is right about the market.

- Model: HistGradientBoostingClassifier (scikit-learn 1.9.1), seed 7
- Training cars: 32,000; held out: 8,000
- Features: 70, all read straight from the reader's JSON

| On the held-out cars | |
|---|---|
| Same marketplace as the simulation | 95.7% |
| Same confidence band (clear or close call) | 92.9% |
| Mean error of p_acv | 0.045 |
| ACV is the better marketplace | 47.7% |
| Dollars lost per car by following the model | $14 |
| Dollars lost per miss | $314 |
| Largest single miss | $2,990 |

Features that matter most (drop in agreement when the feature is shuffled):

- `clean_value`: 0.174
- `app_repair_low`: 0.085
- `comps_max`: 0.084
- `comps_min`: 0.074
- `parts_replace`: 0.073
- `run_status`: 0.068
- `title_status`: 0.053
- `app_repair_high`: 0.050
- `comps_median`: 0.043
- `engine_condition`: 0.035
- `flag_flood_suspected`: 0.031
- `transmission_condition`: 0.022

Regenerate with `underscope train-router` (add `--data rows.jsonl` for recorded outcomes).

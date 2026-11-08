# Backtest vs oracle (SYNTHETIC data)

**Read this first:** the vehicles and their 'true' outcomes are synthetic. The engine
sees noisy findings (severity noise, 5% missed findings, imperfect confidence); the
oracle sees the true findings and one realized outcome per path. Two truths:

- **Same model:** outcomes drawn from the engine's own placeholder model. This only
  measures perception noise and outcome variance; it is circular by construction.
- **Misspecified:** outcomes drawn from a perturbed world where every placeholder is
  off by up to 25% and market noise is 1.5x wider (`data.perturbed`). The gap between
  the two columns shows how much results lean on the engine's own assumptions.

Neither is accuracy on real auction data.

Vehicles: 500. Oracle = best realized net per vehicle.

| Metric | Same model | Misspecified |
|---|---|---|
| Accuracy (picked the oracle's path) | 90.6% | 90.6% |
| Average regret per vehicle | $60 | $84 |
| Human-review rate | 5.4% | 5.4% |
| Best fixed-policy regret | $106 | $71 |

- Same model: UnderScope ($60) beats the best fixed policy, always acv_as_is ($106).
- Misspecified: UnderScope ($84) does not beat the best fixed policy, always acv_as_is ($71).
- Same model, the 95% of vehicles not flagged for review: UnderScope ($35) beats always acv_as_is ($78) on the same vehicles.
- Misspecified, the 95% of vehicles not flagged for review: UnderScope ($53) ties always acv_as_is ($53) on the same vehicles.

## Same model: by damage band (true repair cost / clean value)

| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |
|---|---|---|---|---|---|
| light (0%-15%) | 266 | 98.5% | $2 | always acv_as_is | $47 |
| mid (15%-50%) | 187 | 88.8% | $91 | always acv_as_is | $121 |
| heavy (>=50%) | 47 | 53.2% | $259 | always part_out | $374 |

## Misspecified: by damage band (true repair cost / clean value)

| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |
|---|---|---|---|---|---|
| light (0%-15%) | 266 | 97.4% | $12 | always acv_as_is | $15 |
| mid (15%-50%) | 187 | 88.8% | $148 | always acv_as_is | $116 |
| heavy (>=50%) | 47 | 59.6% | $236 | always acv_as_is | $212 |

## Same model

Average oracle net $7,960.

| Group | Vehicles | Accuracy | Avg regret |
|---|---|---|---|
| Flagged for review | 27 | 48.1% | $485 |
| Not flagged | 473 | 93.0% | $35 |

| Policy | Avg regret |
|---|---|
| always repair_then_acv | $1,758 |
| always acv_as_is | $106 |
| always copart_salvage | $7,003 |
| always part_out | $4,685 |
| UnderScope | $60 |

## Misspecified

Average oracle net $7,923.

| Group | Vehicles | Accuracy | Avg regret |
|---|---|---|---|
| Flagged for review | 27 | 44.4% | $624 |
| Not flagged | 473 | 93.2% | $53 |

| Policy | Avg regret |
|---|---|
| always repair_then_acv | $2,078 |
| always acv_as_is | $71 |
| always copart_salvage | $6,509 |
| always part_out | $4,982 |
| UnderScope | $84 |

## Stratified set: equal light, mid and heavy damage

600 vehicles, 200 per damage band, picked from a larger synthetic pool so the hard cases have enough rows to judge. Same cars in both truths.

| Metric | Same model | Misspecified |
|---|---|---|
| Accuracy (picked the oracle's path) | 84.2% | 83.7% |
| Average regret per vehicle | $84 | $80 |
| Human-review rate | 11.3% | 11.3% |
| Best fixed-policy regret | $202 | $90 |

- Same model: UnderScope ($84) beats the best fixed policy, always acv_as_is ($202).
- Misspecified: UnderScope ($80) beats the best fixed policy, always acv_as_is ($90).
- Same model, the 89% of vehicles not flagged for review: UnderScope ($60) beats always acv_as_is ($184) on the same vehicles.
- Misspecified, the 89% of vehicles not flagged for review: UnderScope ($50) beats always acv_as_is ($80) on the same vehicles.

### Same model, stratified: by damage band

| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |
|---|---|---|---|---|---|
| light (0%-15%) | 200 | 97.5% | $10 | always acv_as_is | $119 |
| mid (15%-50%) | 200 | 94.5% | $25 | always acv_as_is | $27 |
| heavy (>=50%) | 200 | 60.5% | $218 | always part_out | $317 |

### Misspecified, stratified: by damage band

| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |
|---|---|---|---|---|---|
| light (0%-15%) | 200 | 95.5% | $31 | always acv_as_is | $64 |
| mid (15%-50%) | 200 | 93.0% | $29 | always acv_as_is | $18 |
| heavy (>=50%) | 200 | 62.5% | $179 | always acv_as_is | $188 |

Regret is in dollars (integer cents internally). Regenerate with `.venv/bin/python -m underscope.data && .venv/bin/python -m underscope.backtest`.

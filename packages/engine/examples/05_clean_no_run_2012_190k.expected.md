# Example 5: clean title, does not run, 2012, 190k miles, two unknowns

2012 Chevrolet Express 2500 cargo van, 190,450 mi, OH clean title, `runs_drives: no`, frame `unknown`, module_no_comm `unknown` (a non-runner whose modules were not all reachable), the other three flags `no`. The scan returned one confirmed P0562 (system voltage low), which is in no code set, so no severe modifier.

Market fit uses the offline fallback table (confidence 0.4, as_of_year 2026). Weights: title 0.35, drivable 0.15, hidden_risk 0.25, market_fit 0.25. Temperature 0.5, clear_threshold 0.70. Contribution = weight x score x confidence.

## Why

The clean title still favors ACV, but a non-runner (`drivable.no`), two counted hidden-risk flags (`by_count["2"]`) and the `old_or_high` market row (age 14 > 10, 190,450 > 150,000) together tip the utilities to Copart. The margin is small.

## Category scores and contributions

| category | ACV score | Copart score | confidence | weight | contrib ACV | contrib Copart | from |
|---|---|---|---|---|---|---|---|
| title | +1.00 | -0.30 | 1.0 | 0.35 | +0.350 | -0.105 | row title.clean |
| drivable | -0.80 | +0.60 | 1.0 | 0.15 | -0.120 | +0.090 | row drivable.no |
| hidden_risk | -0.50 | +0.40 | 1.0 | 0.25 | -0.125 | +0.100 | by_count["2"] (frame: unknown, module_no_comm: unknown) |
| market_fit | -0.50 | +0.50 | 0.4 | 0.25 | -0.050 | +0.050 | fallback "old_or_high" (age 14, 190,450 mi) |
| **utility** | | | | | **+0.055** | **+0.135** | |

## Probabilities

Softmax with temperature 0.5: P(ACV) = 1 / (1 + e^(-(U_ACV - U_Copart) / T)) = 1 / (1 + e^(-(0.055 - 0.135) / 0.5)) = 1 / (1 + e^(0.16)) = **0.4601**, P(Copart) = 1 - P(ACV) = **0.5399**.

Contributions to the recommended option (copart), largest first (this order drives `reasons`): hidden_risk +0.100, drivable +0.090, market_fit +0.050, title -0.105.

## Confidence

max P = P(Copart) = 0.5399 < clear_threshold 0.70, so "close_call".

## verify_first

Candidates = counted hidden-risk flags. Recommended option = copart, base P(copart) = 0.5399.

| flag | P(copart) if "no" | P(copart) if "yes" | movement |
|---|---|---|---|
| frame | 0.4526 | 0.4750 | 0.0873 |
| module_no_comm | 0.4526 | 0.4526 | 0.0873 |

Both candidates resolved to "no" leave one counted flag (`by_count["1"]` = 0.0/0.2): U_ACV = 0.180, U_Copart = 0.085, P(Copart) = 1 / (1 + e^(0.19)) = 0.4526, movement 0.0873. Frame resolved to "yes" leaves one counted flag (module_no_comm) and applies the severe modifier to drivable: ACV -0.8 - 0.4 = -1.2, clamped to -1.0; Copart 0.6 + 0.1 = 0.7. Then U_ACV = 0.150, U_Copart = 0.100, P(Copart) = 1 / (1 + e^(0.10)) = 0.4750, movement 0.0649. module_no_comm resolved to "yes" is not a severe cause, so it equals its "no" case. Frame and module_no_comm both move 0.0873, an exact tie, and the tie goes to frame (earlier in FLAG_NAMES): **verify_first = frame**.

## Cross-check

Matches the DESIGN.md hand-computed oracle values: U_acv 0.055, U_copart 0.135, P(Copart)=0.5399 close_call; verify_first frame (both move 0.0873 via ->no; frame->yes moves 0.0649 after clamping; tie -> frame). Computed independently from config/*.json and the DESIGN.md rules, not from the engine code.

```expected
as_of_year: 2026
recommendation: copart
confidence: close_call
verify_first: frame
p_acv: 0.4601
```

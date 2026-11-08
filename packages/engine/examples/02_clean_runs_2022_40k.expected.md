# Example 2: clean title, runs and drives, 2022, about 40k miles, no unknowns

2022 Ford F-150 XLT, 40,312 mi, TX clean title, `run_and_drive`, every hidden-risk flag `no`, scan done with no codes (`codes: []`).

Market fit uses the offline fallback table (confidence 0.4, as_of_year 2026). Weights: title 0.35, drivable 0.15, hidden_risk 0.25, market_fit 0.25. Temperature 0.5, clear_threshold 0.70. Contribution = weight x score x confidence.

## Why

Every category leans toward ACV: clean title, a runner, nothing hidden, and the fallback market row for a young, low-mileage truck (`late_low_miles`: age 4 <= 6 and 40,312 < 100,000).

## Category scores and contributions

| category | ACV score | Copart score | confidence | weight | contrib ACV | contrib Copart | from |
|---|---|---|---|---|---|---|---|
| title | +1.00 | -0.30 | 1.0 | 0.35 | +0.350 | -0.105 | row title.clean |
| drivable | +0.80 | +0.00 | 1.0 | 0.15 | +0.120 | +0.000 | row drivable.run_and_drive |
| hidden_risk | +0.60 | +0.00 | 1.0 | 0.25 | +0.150 | +0.000 | by_count["0"] |
| market_fit | +0.80 | +0.00 | 0.4 | 0.25 | +0.080 | +0.000 | fallback "late_low_miles" (age 4, 40,312 mi) |
| **utility** | | | | | **+0.700** | **-0.105** | |

## Probabilities

Softmax with temperature 0.5: P(ACV) = 1 / (1 + e^(-(U_ACV - U_Copart) / T)) = 1 / (1 + e^(-(0.700 - (-0.105)) / 0.5)) = 1 / (1 + e^(-1.61)) = **0.8334**, P(Copart) = 1 - P(ACV) = **0.1666**.

Contributions to the recommended option (acv), largest first (this order drives `reasons`): title +0.350, hidden_risk +0.150, drivable +0.120, market_fit +0.080.

## Confidence

max P = P(ACV) = 0.8334 >= clear_threshold 0.70, so "clear".

## verify_first

No hidden-risk flag is `unknown` or `suspected`, so there are no verify_first candidates: **verify_first = none**.

## Cross-check

Matches the DESIGN.md hand-computed oracle values: U_acv 0.700, U_copart -0.105, P(ACV)=0.8334 clear, verify null. Computed independently from config/*.json and the DESIGN.md rules, not from the engine code.

```expected
as_of_year: 2026
recommendation: acv
confidence: clear
verify_first: none
p_acv: 0.8334
```

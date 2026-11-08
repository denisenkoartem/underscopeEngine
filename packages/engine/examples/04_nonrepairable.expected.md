# Example 4: nonrepairable title

2017 Ford Transit 250 cargo van, 132,560 mi, FL nonrepairable title, `runs_drives: no`, every hidden-risk flag `no`, no scan in the record (`codes` omitted).

Market fit uses the offline fallback table (confidence 0.4, as_of_year 2026). Weights: title 0.35, drivable 0.15, hidden_risk 0.25, market_fit 0.25. Temperature 0.5, clear_threshold 0.70. Contribution = weight x score x confidence.

## Why

The nonrepairable title row has `acv: "excluded"`, so ACV is removed before any weighing and Copart is the only eligible option: P(Copart) = 1, confidence "clear". The exclusion is reasons[0].

## Category scores and contributions

| category | ACV score | Copart score | confidence | weight | contrib ACV | contrib Copart | from |
|---|---|---|---|---|---|---|---|
| title | excluded | +1.00 | 1.0 | 0.35 | +0.000 | +0.350 | row title.nonrepairable |
| drivable | -0.80 | +0.60 | 1.0 | 0.15 | -0.120 | +0.090 | row drivable.no |
| hidden_risk | +0.60 | +0.00 | 1.0 | 0.25 | +0.150 | +0.000 | by_count["0"] |
| market_fit | +0.30 | +0.20 | 0.4 | 0.25 | +0.030 | +0.020 | fallback "mid" (age 9, 132,560 mi) |
| **utility** | | | | | **+0.060** | **+0.460** | |

## Probabilities

Only copart is eligible (excluded: acv), so the softmax is not used: P(ACV) = 0.0000, P(Copart) = 1.0000. The utilities above are shown for the explanation only.

Contributions to the recommended option (copart), largest first (this order drives `reasons`): title +0.350, drivable +0.090, market_fit +0.020, hidden_risk +0.000.

## Confidence

One eligible option: confidence is "clear" by rule (no threshold test). The insufficient override does not apply: the title is known.

## verify_first

No hidden-risk flag is `unknown` or `suspected`, so there are no verify_first candidates: **verify_first = none**.

## Cross-check

Matches the DESIGN.md hand-computed oracle values: Ex4 nonrepairable -> copart clear, P(Copart)=1. Computed independently from config/*.json and the DESIGN.md rules, not from the engine code.

```expected
as_of_year: 2026
recommendation: copart
confidence: clear
verify_first: none
p_acv: 0.0000
```

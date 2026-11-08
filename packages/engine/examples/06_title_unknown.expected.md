# Example 6: title unknown, otherwise like example 2

Same record as example 2 (2022 Ford F-150 XLT, 40,312 mi, TX, `run_and_drive`, all flags `no`, `codes: []`) except `title.brand: "unknown"`.

Market fit uses the offline fallback table (confidence 0.4, as_of_year 2026). Weights: title 0.35, drivable 0.15, hidden_risk 0.25, market_fit 0.25. Temperature 0.5, clear_threshold 0.70. Contribution = weight x score x confidence.

## Why

With an unknown brand, the combiner scores three runs, all reusing the one market-fit result (`late_low_miles`, computed once, so no extra API calls):

1. **Base run**: the record as-is, so the title scorer returns the `title.unknown` row (0.0 / 0.0, confidence 0.3).
2. **Clean branch**: the same record with the brand set to `clean`.
3. **Salvage branch**: the same record with the brand set to `salvage`.

If the clean and salvage branches recommend the same option, the base run is returned with its own probabilities, confidence and verify_first. If they disagree, the clean branch is returned with confidence "close_call" and verify_first "confirm title brand". Either way, the insufficient override (title unknown AND counted >= 3) applies to the returned decision. Here the branches disagree, so the clean branch is returned.

## Base run (title.unknown row; not returned here)

| category | ACV score | Copart score | confidence | weight | contrib ACV | contrib Copart | from |
|---|---|---|---|---|---|---|---|
| title | +0.00 | +0.00 | 0.3 | 0.35 | +0.000 | +0.000 | row title.unknown |
| drivable | +0.80 | +0.00 | 1.0 | 0.15 | +0.120 | +0.000 | row drivable.run_and_drive |
| hidden_risk | +0.60 | +0.00 | 1.0 | 0.25 | +0.150 | +0.000 | by_count["0"] |
| market_fit | +0.80 | +0.00 | 0.4 | 0.25 | +0.080 | +0.000 | fallback "late_low_miles" (age 4, 40,312 mi) |
| **utility** | | | | | **+0.350** | **+0.000** | |

P(ACV) = 1 / (1 + e^(-(0.350 - 0.000) / 0.5)) = 1 / (1 + e^(-0.70)) = 0.6682, which would be "close_call" with verify_first none. It would be returned only if the branches agreed.

## Clean branch (the returned Decision)

| category | ACV score | Copart score | confidence | weight | contrib ACV | contrib Copart | from |
|---|---|---|---|---|---|---|---|
| title | +1.00 | -0.30 | 1.0 | 0.35 | +0.350 | -0.105 | row title.clean |
| drivable | +0.80 | +0.00 | 1.0 | 0.15 | +0.120 | +0.000 | row drivable.run_and_drive |
| hidden_risk | +0.60 | +0.00 | 1.0 | 0.25 | +0.150 | +0.000 | by_count["0"] |
| market_fit | +0.80 | +0.00 | 0.4 | 0.25 | +0.080 | +0.000 | fallback "late_low_miles" (age 4, 40,312 mi) |
| **utility** | | | | | **+0.700** | **-0.105** | |

Softmax with temperature 0.5: P(ACV) = 1 / (1 + e^(-(U_ACV - U_Copart) / T)) = 1 / (1 + e^(-(0.700 - (-0.105)) / 0.5)) = 1 / (1 + e^(-1.61)) = **0.8334**, P(Copart) = 1 - P(ACV) = **0.1666**.

Contributions to the recommended option (acv), largest first (this order drives `reasons`): title +0.350, hidden_risk +0.150, drivable +0.120, market_fit +0.080.

No hidden-risk flag is `unknown` or `suspected`, so there are no verify_first candidates: **verify_first = none**.

## Salvage branch

| category | ACV score | Copart score | confidence | weight | contrib ACV | contrib Copart | from |
|---|---|---|---|---|---|---|---|
| title | excluded | +1.00 | 1.0 | 0.35 | +0.000 | +0.350 | row title.salvage |
| drivable | +0.80 | +0.00 | 1.0 | 0.15 | +0.120 | +0.000 | row drivable.run_and_drive |
| hidden_risk | +0.60 | +0.00 | 1.0 | 0.25 | +0.150 | +0.000 | by_count["0"] |
| market_fit | +0.80 | +0.00 | 0.4 | 0.25 | +0.080 | +0.000 | fallback "late_low_miles" (age 4, 40,312 mi) |
| **utility** | | | | | **+0.350** | **+0.350** | |

Only copart is eligible (excluded: acv), so the softmax is not used: P(ACV) = 0.0000, P(Copart) = 1.0000. The utilities above are shown for the explanation only.

No hidden-risk flag is `unknown` or `suspected`, so there are no verify_first candidates: **verify_first = none**.

## Confidence

The clean branch alone would be "clear" (0.8334 >= 0.70). The salvage branch recommends Copart (ACV excluded). **The branches disagree**, so the base run is not used: the returned Decision is the clean branch's (recommendation ACV, P(ACV) = 0.8334) with confidence = "close_call" and verify_first = "confirm title brand". Its title category shows the clean row with the extra first factor "Title brand unknown: clean branch -> acv, salvage branch -> copart; reported the clean branch". The insufficient override (title unknown AND counted >= 3) does not apply, because counted = 0.

## verify_first

The branches disagree, so verify_first = **confirm title brand**. The clean branch's own verify_first would be none.

## Cross-check

Matches the DESIGN.md hand-computed oracle values (unknown-title rule as revised in round 2): clean branch ACV 0.8334, salvage branch Copart -> disagree -> clean branch: acv, P(ACV)=0.8334, close_call, verify_first "confirm title brand". Same pattern as sample_vehicles.json v09 (branches disagree, clean branch reported). Computed independently from config/*.json and the DESIGN.md rules, not from the engine code.

```expected
as_of_year: 2026
recommendation: acv
confidence: close_call
verify_first: confirm title brand
p_acv: 0.8334
```

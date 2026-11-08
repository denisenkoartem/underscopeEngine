# Example 3: clean title, runs, 2021, 62k miles, misfire + catalyst confirmed, frame unknown

2021 Ram 1500 Big Horn, 62,000 mi, GA clean title, `run_and_drive`, confirmed P0301 (MISFIRE set) and P0420 (CATALYST set), frame `unknown`, the other four flags `no`.

Market fit uses the offline fallback table (confidence 0.4, as_of_year 2026). Weights: title 0.35, drivable 0.15, hidden_risk 0.25, market_fit 0.25. Temperature 0.5, clear_threshold 0.70. Contribution = weight x score x confidence.

## Why

MISFIRE+CATALYST is a `severe_when` entry and both sets have a confirmed code, so drivable gets `severe_code_modifier` once: ACV 0.8 - 0.4 = 0.4, Copart 0.0 + 0.1 = 0.1. One counted hidden-risk flag (frame: unknown) gives `by_count["1"]` = (0.0, 0.2). The fallback market row is `late_low_miles` (age 5, 62,000 mi).

## Category scores and contributions

| category | ACV score | Copart score | confidence | weight | contrib ACV | contrib Copart | from |
|---|---|---|---|---|---|---|---|
| title | +1.00 | -0.30 | 1.0 | 0.35 | +0.350 | -0.105 | row title.clean |
| drivable | +0.40 | +0.10 | 1.0 | 0.15 | +0.060 | +0.015 | row drivable.run_and_drive + severe_code_modifier (MISFIRE+CATALYST) |
| hidden_risk | +0.00 | +0.20 | 1.0 | 0.25 | +0.000 | +0.050 | by_count["1"] (frame: unknown) |
| market_fit | +0.80 | +0.00 | 0.4 | 0.25 | +0.080 | +0.000 | fallback "late_low_miles" (age 5, 62,000 mi) |
| **utility** | | | | | **+0.490** | **-0.040** | |

## Probabilities

Softmax with temperature 0.5: P(ACV) = 1 / (1 + e^(-(U_ACV - U_Copart) / T)) = 1 / (1 + e^(-(0.490 - (-0.040)) / 0.5)) = 1 / (1 + e^(-1.06)) = **0.7427**, P(Copart) = 1 - P(ACV) = **0.2573**.

Contributions to the recommended option (acv), largest first (this order drives `reasons`): title +0.350, market_fit +0.080, drivable +0.060, hidden_risk +0.000.

## Confidence

max P = P(ACV) = 0.7427 >= clear_threshold 0.70, so "clear".

**Note on the spec.** The spec text for this example says "close call". With the config as given the arithmetic above gives P(ACV) = 0.7427, which is at or above the 0.70 clear threshold, so the rule produces "clear". The user chose to keep the config and the record as written and accept "clear" (DESIGN.md, "User decision on example 3"). The numbers were not tuned to force a close call. verify_first is still frame, as the spec expects.

## verify_first

Candidates = counted hidden-risk flags. Recommended option = acv, base P(acv) = 0.7427.

| flag | P(acv) if "no" | P(acv) if "yes" | movement |
|---|---|---|---|
| frame | 0.8115 | 0.8115 | 0.0688 |

Frame is the only candidate. Setting it to "no" drops the hidden-risk count to 0 (`by_count["0"]` = 0.6/0.0), so U_ACV = 0.640, U_Copart = -0.090 and P(ACV) = 1 / (1 + e^(-1.46)) = 0.8115. Setting it to "yes" also drops the count to 0. It would add the severe modifier, but the codes already applied it and the modifier is applied once, so P(ACV) is again 0.8115. Movement = 0.8115 - 0.7427 = 0.0688 > 0, so **verify_first = frame**.

## Cross-check

Matches the DESIGN.md hand-computed oracle values: U_acv 0.490, U_copart -0.040, P(ACV)=0.7427 clear, verify_first frame; frame->no and frame->yes both give 0.8115. Computed independently from config/*.json and the DESIGN.md rules, not from the engine code.

```expected
as_of_year: 2026
recommendation: acv
confidence: clear
verify_first: frame
p_acv: 0.7427
```

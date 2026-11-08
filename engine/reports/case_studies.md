# Case studies

All vehicles are fixtures (fake VINs, makes); all values use PLACEHOLDER assumptions from config/assumptions.yaml. These illustrate engine behavior, not market outcomes.

## Case 1: the $600 dent

Dealer persona (no insurance claim). A door dent on a clean-title car, repair estimate around $650. (`data/fixtures/dent_600.json`)

```
2022 SynthA Alpha Base  VIN FIXDENT0000000001  (NY, 28,000 mi, clean)

RECOMMENDATION: sell as-is on ACV
Repair does not pay back: selling as-is nets $736 more than repairing on average; repair comes out ahead in only 1% of draws.

Path                          Expected       P10       P50       P90
sell as-is on ACV              $22,632   $20,290   $22,540   $25,035
repair then sell on ACV        $21,896   $19,513   $21,835   $24,353
part out                        $9,724    $6,917    $9,529   $12,833
sell as salvage on Copart       $3,624    $2,060    $3,579    $5,273

Best path: sell as-is on ACV, expected net $22,632 (P10 $20,290, P90 $25,035). Next best is repair then sell on ACV at $21,896, $736 behind; it wins in 1% of simulated outcomes. Expected repair cost is $656 (3% of a $25,000 clean value; total-loss threshold 75% in NY).

What would flip it:
  - No repair cost between $0 and 3x the estimate changes the winner.
  - For sell as-is on ACV: the sale price would have to fall by about $751 to flip the ranking.

(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)
```

**Takeaway:** Selling as-is wins narrowly under the untuned placeholders. The accident-history haircut scales with damage, so a 3%-of-value dent carries almost none; what sinks repair is the extra holding time and the hidden-damage reserve. Repair wins once buyers discount the visible damage by about 2.4x the repair cost (placeholder 1.3x; see reports/sensitivity.md). That one number, measurable from ACV sale data, answers the dealer's question.

## Case 2: a borderline write-off

Adjuster persona (insurance claim). Frame crush plus a door dent; repair cost is 72% of clean value against the 75% NY total-loss threshold. (`data/fixtures/borderline_writeoff.json`)

```
2019 SynthC Eps Base  VIN FIXBORDER00000001  (NY, 70,000 mi, clean, insurance claim)

RECOMMENDATION: part out
Borderline total loss: repair estimate is 72% of clean value, below the 75% threshold in NY; repair cost crosses it in 56% of draws. A firm repair estimate settles it. Best path on current numbers: part out.

Path                          Expected       P10       P50       P90
part out                        $1,873      $794    $1,831    $3,098
sell as-is on ACV                 $664      $121      $663    $1,183
sell as salvage on Copart         $226     -$362      $207      $844
repair then sell on ACV        -$3,457   -$7,234   -$3,887       $70

Best path: part out, expected net $1,873 (P10 $794, P90 $3,098). Next best is sell as-is on ACV at $664, $1,209 behind; it wins in 9% of simulated outcomes. Expected repair cost is $6,887 (72% of a $9,500 clean value; total-loss threshold 75% in NY).

What would flip it:
  - If expected repair cost fell from $6,887 to about $4,863 (-29%), sell as-is on ACV would win.
  - For part out: net parts revenue would have to fall by about $1,209 to flip the ranking.
  - For sell as-is on ACV: the sale price would have to rise by about $1,234 to flip the ranking.

(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)
```

**Takeaway:** The adjuster answer is 'borderline total loss': the expected repair is just under the threshold, but repair cost crosses it in about half the draws, so a firm repair estimate settles whether the car is totaled. It doesn't change the disposition: repair loses either way (it bears the hidden-damage reserve, haircut and holding), and parts vs as-is depends on the parts placeholders.

## Case 3: an obvious total loss

Adjuster persona (insurance claim). Severe frame, hood and bumper damage with undercarriage damage flagged. (`data/fixtures/total_loss.json`)

```
2020 SynthB Gamma Base  VIN FIXTOTAL000000001  (NY, 61,000 mi, clean, insurance claim)

RECOMMENDATION: part out
Total loss: repair estimate is 91% of clean value, above the 75% threshold in NY; repair cost crosses it in 87% of draws. Best path for the totaled car: part out.

Path                          Expected       P10       P50       P90
part out                        $4,628    $2,948    $4,536    $6,459
sell as-is on ACV               $2,071    $1,080    $2,063    $3,044
sell as salvage on Copart       $1,566      $604    $1,529    $2,580
repair then sell on ACV       -$12,156  -$19,356  -$12,178   -$3,575

Best path: part out, expected net $4,628 (P10 $2,948, P90 $6,459). Next best is sell as-is on ACV at $2,071, $2,558 behind; it wins in 3% of simulated outcomes. Expected repair cost is $16,368 (91% of a $18,000 clean value; total-loss threshold 75% in NY). Repair is past the total-loss threshold, so a repaired car would carry a brand.

What would flip it:
  - If expected repair cost fell from $16,368 to about $9,189 (-44%), sell as-is on ACV would win.
  - For part out: net parts revenue would have to fall by about $2,558 to flip the ranking.
  - For sell as-is on ACV: the sale price would have to rise by about $2,610 to flip the ranking.

(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)
```

**Takeaway:** Repair costs about 90% of the clean value and loses money in nearly every draw. Once the insurer totals the car, an as-is buyer gets a salvage title, so as-is is worth about the salvage value. Part-out leads both, by an amount the parts placeholders could erase (halving gross parts value or sell-through hands it to as-is).

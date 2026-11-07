# Underscope engine rules

Version 0.2 · owner: Pair A (engine) · changes by PR only, reviewed by the other pair

This file is the single source of truth for every rule the engine applies to a
ConditionRecord before and during pricing. `rules.ts` parses the fenced `yaml rule` blocks
below; the prose around them is for humans. Every number marked `PLACEHOLDER` must be
replaced with a calibrated value before anyone quotes a result outside the team.

## The two marketplace models these rules encode

Source: a conversation with an ACV employee, 7 Nov 2026. These are what the speaker said,
not verified facts; items marked (verify) need a second source before they become hard
rules.

| | ACV | Copart |
| --- | --- | --- |
| What it sells | A described condition. ACV inspects (photos, undercarriage scan, recorded and analyzed engine sound, scanner codes) and lists every problem it finds | The car as it sits. No detailed inspection; many units are insurance losses not worth fixing |
| What it guarantees | That the car is as described. If something significant was missed on the condition report, arbitration applies. Disclosed problems are not guaranteed away | Nothing about condition; as-is |
| Who buys | Licensed dealers only (B2B) | Much of the inventory is open to the public, including repair hobbyists and people buying a whole car for one part; some vehicles require a business license (which ones: verify) |
| Where buyers are | Domestic dealers | Domestic plus a large international buyer base; some markets reportedly allow repairs that are not accepted in the U.S. (South Africa and frame welding: verify) |
| Weak spot | "Red light" cars: serious disclosed issues, few bids | Buyers bid blind, so uncertainty lowers prices |
| Repairs | None | None |

Four consequences shape the rules below:

1. **On ACV, a disclosed defect is a price deduction, not a claim risk.** Claim risk comes
   only from what is unknown and could be missed by the condition report. A defect that
   the ConditionRecord states is treated as disclosed.
2. **On Copart, unknowns lower the price, because buyers price uncertainty themselves.**
   Attaching our evidence (codes, photos) to a listing is a way to reduce that discount.
3. **ACV red-light cars are the clearest routing opportunity.** Serious disclosed issues
   mean few dealer bids; Copart's parts, hobbyist and international buyers may pay more.
4. **The engine can save an inspection.** A consumer scanner read before ACV inspects
   can show that a car will be red light anyway, so the seller can skip ACV's inspection
   and go straight to Copart.

## How the engine uses this file

1. **Guards** (`G`): stop if the record cannot be priced at all.
2. **Title and legal** (`T`): may remove a channel or the fix path outright.
3. **Seller constraints** (`S`), eligibility part: may remove a channel.
4. **Mechanical** (`M`), **repair** (`R`), **market fit** (`F`): build or widen bands and add
   condition deductions.
5. **Hidden risk** (`H`): builds the ACV dispute cost from what is unknown.
6. **Seller constraints** (`S`), preference part: weights applied to the sampled nets.
7. **Decision** (`D`): close-call test, insufficient test, verify-first, reason ordering.

Rules inside a group run in ID order. A rule never undoes another rule's exclusion. Every
rule that fires is appended to `Decision.evidence.rules_fired` with its ID and reason.

Missing information never becomes zero. It becomes a cautious default, a wider band, a
line in `gaps`, and a candidate for `verify_first` (chosen only if resolving it would
change the answer).

## Rule schema

```yaml
id: T01                     # group letter + number, never reused
group: title                # guard | title | seller | mechanical | repair | market | risk | decision
summary: one line for humans
when:                       # all predicates must hold; use any: [...] for OR
  - {field: title.brand, op: eq, value: nonrepairable}
effects:                    # applied in order
  - {type: exclude, target: acv}
reason: "Nonrepairable title: cannot be rebuilt or retailed"
if_missing: describes what happens when a field in `when` is absent
```

Predicate operators: `eq`, `ne`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `exists`,
`missing`, `is_unknown` (value is the string `unknown`), `any_code` (code set + status
filter over `codes[]`), `count_gt` (count of array items matching a sub-predicate).

Effect types:

| Type | Fields | What it does |
| --- | --- | --- |
| `block` | `confidence` | Stop; return a Decision with that confidence and the reason as `verify_first` |
| `exclude` | `target` (`acv`, `copart`, `fix`) | Mark ineligible with the reason |
| `unlikely` | `target`, `deduct_pct` | Keep eligible but deduct a percentage of that channel's value |
| `deduct` | `target`, `amount` or `pct` | Subtract from that channel's price band |
| `add_repair` | `component`, `low`, `high` | Add a range to one repair component |
| `widen` | `target`, `p90_add` or `pct` | Widen the high end only (unknowns never move the typical value) |
| `dispute` | `weight`, `credit` | Add to ACV claim probability and expected credit (rule H01) |
| `days` | `target`, `add` | Add days to cash |
| `discount_resale` | `pct` | Apply to the fix path's after-repair value |
| `limit_buyers` | `target`, `segments` | Restrict which buyer segments price that channel |
| `branch` | `field`, `values` | Run the engine once per value; if decisions disagree, that field becomes `verify_first` |
| `gap` | `text` | Append to `ConditionRecord.gaps` and show in the result |
| `verify` | `text` | Add a verify-first candidate |
| `review` | `text` | Route to human review |
| `note` | `text` | Record in evidence only |

## Parameters

All values `PLACEHOLDER` until calibrated against fixtures and partner records.

```yaml params
status_weight: {confirmed: 1.0, pending: 0.5, history: 0.1}
rebuilt_discount_pct: 25            # PLACEHOLDER; public guidance says 20-40% typical
acv_rebuilt_extra_deduct_pct: 10    # PLACEHOLDER; dealers struggle to retail branded titles
flood_deduct_pct: 40                # PLACEHOLDER
odometer_issue_deduct_pct: 20       # PLACEHOLDER
lemon_deduct_pct: 10                # PLACEHOLDER
title_pending_days: 21              # PLACEHOLDER
lien_days: 10                       # PLACEHOLDER
high_mileage_mi: 150000             # PLACEHOLDER
high_mileage_acv_deduct_pct: 8      # PLACEHOLDER
non_runner_acv_deduct_pct: 15       # PLACEHOLDER
unknown_part_p90: replace_high      # unknown grade widens by that part's replace-high cost
frame_unknown_p90_add: 6000         # PLACEHOLDER
frame_suspected_low: 2500           # PLACEHOLDER
frame_suspected_high: 9000          # PLACEHOLDER
airbag_per_bag_low: 900             # PLACEHOLDER
airbag_per_bag_high: 1800           # PLACEHOLDER
airbag_module_and_belts_low: 600    # PLACEHOLDER
airbag_module_and_belts_high: 1500  # PLACEHOLDER
misfire_cat_low: 400                # PLACEHOLDER
misfire_cat_high: 3500              # PLACEHOLDER
module_no_comm_p90_add: 2500        # PLACEHOLDER
no_scan_mech_low_pct: 0             # PLACEHOLDER, of clean wholesale
no_scan_mech_high_pct: 8            # PLACEHOLDER, of clean wholesale
default_labor_rate: 95              # PLACEHOLDER, USD per hour
area_prior_p90_add: 1500            # PLACEHOLDER, per unphotographed area
dispute_base: 0.03                  # PLACEHOLDER, base ACV claim probability
dispute_cap: 0.80
dispute_unlikely_threshold: 0.35    # PLACEHOLDER
comps_min: 3
comps_widen_pct_per_step: 15        # PLACEHOLDER
upfit_widen_pct: 20                 # PLACEHOLDER
config_unknown_widen_pct: 10        # PLACEHOLDER
close_call_low: 0.30
close_call_high: 0.70
insufficient_unknowns: 2            # more than this many high-cost unknowns -> insufficient
high_cost_unknown_usd: 1000         # PLACEHOLDER
dispute_seller_share: 0.5           # PLACEHOLDER: share of an ACV arbitration credit that reaches the seller's net (verify who bears it)
acv_red_light_deduct_pct: 12        # PLACEHOLDER: thin bidding on red-light cars
acv_red_light_p_no_sale: 0.35       # PLACEHOLDER: chance a red-light car does not sell first time
acv_relist_days: 7                  # PLACEHOLDER
acv_inspection_cost: 0              # PLACEHOLDER: seller-side cost and time of an ACV inspection, if any (verify)
acv_inspection_days: 2              # PLACEHOLDER
copart_uncertainty_discount_pct: 3  # PLACEHOLDER: per unresolved high-cost unknown; buyers bid blind
copart_uncertainty_discount_cap_pct: 15
copart_evidence_recovery_pct: 50    # PLACEHOLDER: share of the uncertainty discount recovered when our evidence is attached
export_shipping_usd: 2500           # PLACEHOLDER
objective: seller_net               # seller_net | platform_revenue | blended
```

Code sets, resolved against `inputs/codes/dtc_standard.csv`:

```yaml codesets
MISFIRE: [P0300, P0301, P0302, P0303, P0304, P0305, P0306, P0307, P0308, P0309, P0310, P0311, P0312]
CATALYST: [P0420, P0430]
SRS_DEPLOYMENT: [B0001, B0002, B0003, B0004, B0005, B0010, B0011, B0012, B0013, B0014]  # PLACEHOLDER list; confirm against the code table
TRANSMISSION: [P0700, P0715, P0720, P0730, P0740, P0750]  # PLACEHOLDER list
```

## Required ConditionRecord fields

Fields this file reads that are beyond the original contract; add them to
`packages/contracts` before implementing:

- `title.in_hand` (bool | unknown), `title.lien` (none | open | unknown),
  `title.history_brands` (string[]), `title.odometer_status` (actual | not_actual | exempt | unknown),
  `title.owner_matches_seller` (bool | unknown)
- `scan_present` (bool), `monitors_incomplete` (bool | unknown),
  `modules[]` ({module, communicates})
- `damage[].area` (front | rear | left | right | roof | interior | engine_bay | underbody),
  `damage[].component` (body | glass_lights_tires | safety | mechanical | structural)
- `areas_photographed` (string[])
- `config` ({cab, bed, drive, chassis_cab, upfit}: each value or unknown)
- `seller.repair_capability` (own_shop | outsourced | none)
- `input_stage` (pre_inspection | post_inspection): pre_inspection means the codes come
  from a consumer scanner before any ACV inspection
- `evidence_attached_to_listing` (bool): whether our photos and codes will travel with a
  Copart listing
- Convention: anything stated in the ConditionRecord counts as disclosed; anything
  `unknown` or missing counts as undisclosed

New Decision fields: `acv_light` (green | yellow | red), `p_no_sale_acv`,
`skip_acv_inspection` (bool), `best_copart_segment` (rebuilder | dismantler | hobbyist |
parts_donor | exporter)
- computed by the engine before rules run: `repair.p10`, `repair.p50`, `repair.p90`,
  `clean_wholesale.p50`, `comps_count.acv`, `comps_count.copart`

## G: Guards

```yaml rule
id: G01
group: guard
summary: No usable VIN
when:
  - any:
    - {field: vin, op: missing}
    - {field: vin_check_digit_valid, op: eq, value: false}
effects:
  - {type: block, confidence: insufficient}
reason: "VIN missing or invalid; every price lookup depends on it"
if_missing: this rule is the missing case
```

```yaml rule
id: G02
group: guard
summary: VIN did not decode
when:
  - {field: decoded.model, op: missing}
effects:
  - {type: block, confidence: insufficient}
reason: "VIN did not decode to a make and model"
if_missing: this rule is the missing case
```

## T: Title and legal status

```yaml rule
id: T01
group: title
summary: Nonrepairable title
when:
  - {field: title.brand, op: eq, value: nonrepairable}
effects:
  - {type: exclude, target: fix}
  - {type: exclude, target: acv}
  - {type: limit_buyers, target: copart, segments: [dismantler]}
reason: "Nonrepairable title: cannot be rebuilt or registered; parts buyers only"
if_missing: see T11
```

```yaml rule
id: T02
group: title
summary: Salvage title
when:
  - {field: title.brand, op: eq, value: salvage}
effects:
  - {type: exclude, target: acv}
  - {type: discount_resale, pct: $rebuilt_discount_pct}
  - {type: note, text: "ACV excluded for salvage in v1; confirm ACV's policy on branded titles"}
reason: "Salvage title: dealers are not interested (repair time and effort); fixing yields a rebuilt title"
if_missing: see T11
```

```yaml rule
id: T03
group: title
summary: Salvage title in a state that does not allow rebuild
when:
  - {field: title.brand, op: eq, value: salvage}
  - {field: state_rules[title.state].salvage_rebuildable, op: eq, value: false}
effects:
  - {type: exclude, target: fix}
reason: "Salvage title in {title.state}: rebuild not permitted"
if_missing: if title.state is missing or not in state_rules, rule T12 fires instead
```

```yaml rule
id: T04
group: title
summary: Rebuilt title
when:
  - {field: title.brand, op: eq, value: rebuilt}
effects:
  - {type: deduct, target: acv, pct: $acv_rebuilt_extra_deduct_pct}
  - {type: deduct, target: copart, pct: 0}
  - {type: discount_resale, pct: $rebuilt_discount_pct}
reason: "Rebuilt title: dealers discount it heavily; resale after repair stays branded"
if_missing: see T11
```

```yaml rule
id: T05
group: title
summary: Flood brand or flood in history
when:
  - any:
    - {field: title.brand, op: eq, value: flood}
    - {field: title.history_brands, op: in, value: flood}
effects:
  - {type: unlikely, target: acv, deduct_pct: $flood_deduct_pct}
  - {type: discount_resale, pct: $flood_deduct_pct}
  - {type: note, text: "Disclosed on the title, so a deduction rather than claim risk; counts toward red light (M10)"}
reason: "Flood history: severe dealer discount"
if_missing: flood_suspected flag is handled by H01
```

```yaml rule
id: T06
group: title
summary: Lemon or manufacturer buyback
when:
  - {field: title.brand, op: eq, value: lemon}
effects:
  - {type: deduct, target: acv, pct: $lemon_deduct_pct}
reason: "Lemon/buyback brand: dealer discount"
if_missing: treated as not branded lemon
```

```yaml rule
id: T07
group: title
summary: Odometer not actual or exempt
when:
  - {field: title.odometer_status, op: in, value: [not_actual, exempt]}
effects:
  - {type: deduct, target: acv, pct: $odometer_issue_deduct_pct}
reason: "Odometer {title.odometer_status}: dealer discount"
if_missing: treated as actual; add gap "odometer status not confirmed"
```

```yaml rule
id: T08
group: title
summary: Possible title washing (clean now, branded in history)
when:
  - {field: title.brand, op: eq, value: clean}
  - {field: title.history_brands, op: count_gt, value: 0}
effects:
  - {type: gap, text: "Title is clean now but was branded {title.history_brands} before"}
  - {type: verify, text: "Confirm title history; price as the worst historical brand until confirmed"}
  - {type: review, text: "Possible title washing"}
reason: "Earlier brand in history: priced as {worst(title.history_brands)} until confirmed"
if_missing: if history was never checked, add gap "title history not checked"
```

```yaml rule
id: T09
group: title
summary: Title not in hand
when:
  - {field: title.in_hand, op: eq, value: false}
effects:
  - {type: days, target: acv, add: $title_pending_days}
  - {type: days, target: copart, add: $title_pending_days}
  - {type: note, text: "Some guaranteed-sale programs require the title in hand"}
reason: "Title not yet in hand: adds about {title_pending_days} days to cash"
if_missing: treated as in hand; add gap "title possession not confirmed"
```

```yaml rule
id: T10
group: title
summary: Open lien
when:
  - {field: title.lien, op: eq, value: open}
effects:
  - {type: days, target: acv, add: $lien_days}
  - {type: days, target: copart, add: $lien_days}
  - {type: gap, text: "Lien payoff required before transfer"}
reason: "Open lien: payoff adds time before funds arrive"
if_missing: treated as no lien; add gap "lien status not confirmed"
```

```yaml rule
id: T11
group: title
summary: Title brand unknown
when:
  - any:
    - {field: title.brand, op: missing}
    - {field: title.brand, op: is_unknown}
effects:
  - {type: branch, field: title.brand, values: [clean, salvage]}
  - {type: gap, text: "Title brand unknown"}
reason: "Title brand unknown: decision computed for clean and salvage"
if_missing: this rule is the missing case; if both branches agree the decision stands, otherwise verify_first is "Confirm title brand"
```

```yaml rule
id: T12
group: title
summary: No encoded rules for the title state
when:
  - {field: title.state, op: not_in, value: state_rules.keys}
effects:
  - {type: review, text: "No title rules encoded for {title.state}"}
  - {type: gap, text: "State title rules not encoded"}
reason: "Title rules for {title.state} not encoded; routed to review"
if_missing: if title.state is missing, same effect
```

```yaml rule
id: T13
group: title
summary: Owner on title does not match seller
when:
  - {field: title.owner_matches_seller, op: eq, value: false}
effects:
  - {type: review, text: "Seller authority to sell not established"}
  - {type: verify, text: "Confirm seller authority to sell (power of attorney or ownership)"}
reason: "Owner on title differs from seller"
if_missing: treated as matching; add gap "ownership not confirmed"
```

## S: Seller constraints, eligibility part

```yaml rule
id: S01
group: seller
summary: Channel not in the seller's allowed lanes
when:
  - {field: seller.lanes_allowed, op: exists}
  - {field: channel, op: not_in, value: seller.lanes_allowed}
effects:
  - {type: exclude, target: "{channel}"}
reason: "Seller's instructions exclude {channel}"
if_missing: all channels allowed
```

```yaml rule
id: S02
group: seller
summary: Seller will not repair
when:
  - {field: seller.repair_capability, op: eq, value: none}
effects:
  - {type: exclude, target: fix}
reason: "Seller does not repair vehicles"
if_missing: treated as outsourced (see S03)
```

```yaml rule
id: S03
group: seller
summary: Labor rate unknown
when:
  - {field: seller.labor_rate_per_hour, op: missing}
effects:
  - {type: gap, text: "Labor rate not given; regional default used"}
  - {type: note, text: "labor_rate = $default_labor_rate"}
reason: "Default labor rate used"
if_missing: this rule is the missing case
```

## M: Drivability and mechanical health

Code weighting: every code contributes in proportion to `status_weight` (confirmed 1.0,
pending 0.5, history 0.1). A code set "fires" only on confirmed codes unless a rule says
otherwise.

```yaml rule
id: M01
group: mechanical
summary: Does not run or drive
when:
  - {field: runs_drives, op: eq, value: "no"}
effects:
  - {type: unlikely, target: acv, deduct_pct: $non_runner_acv_deduct_pct}
  - {type: limit_buyers, target: copart, segments: [rebuilder, dismantler, exporter]}
reason: "Does not run: dealers discount non-runners; normal for Copart buyers"
if_missing: see M02
```

```yaml rule
id: M02
group: mechanical
summary: Run status unknown
when:
  - any:
    - {field: runs_drives, op: missing}
    - {field: runs_drives, op: is_unknown}
effects:
  - {type: dispute, weight: 0.08, credit: 2000}
  - {type: widen, target: repair.mechanical, p90_add: 2000}
  - {type: verify, text: "Confirm whether it starts and drives"}
reason: "Run status unknown"
if_missing: this rule is the missing case
```

```yaml rule
id: M03
group: mechanical
summary: Misfire and catalyst codes confirmed together
when:
  - {field: codes, op: any_code, value: {set: MISFIRE, status: [confirmed]}}
  - {field: codes, op: any_code, value: {set: CATALYST, status: [confirmed]}}
effects:
  - {type: unlikely, target: acv, deduct_pct: 10}
  - {type: add_repair, component: mechanical, low: $misfire_cat_low, high: $misfire_cat_high}
reason: "Confirmed misfire with catalyst efficiency fault: engine diagnosis needed; counts toward red light"
if_missing: no scan handled by M07
```

```yaml rule
id: M04
group: mechanical
summary: Airbag deployment codes confirmed
when:
  - {field: codes, op: any_code, value: {set: SRS_DEPLOYMENT, status: [confirmed]}}
effects:
  - {type: note, text: "Sets flags.airbag_deployed = true if it was unknown"}
  - {type: unlikely, target: acv, deduct_pct: 15}
reason: "Confirmed airbag deployment code"
if_missing: airbag status unknown is handled by R05 and H01
```

```yaml rule
id: M05
group: mechanical
summary: A control module does not communicate
when:
  - {field: modules, op: count_gt, value: {match: {communicates: false}, gt: 0}}
effects:
  - {type: unlikely, target: acv, deduct_pct: 10}
  - {type: widen, target: repair.mechanical, p90_add: $module_no_comm_p90_add}
  - {type: verify, text: "Find out why {module} does not communicate (wiring, power, or failed module)"}
reason: "{module} not communicating: cause unknown"
if_missing: if modules[] absent, treated as all communicating; add gap "module status not reported"
```

```yaml rule
id: M06
group: mechanical
summary: Readiness monitors incomplete
when:
  - {field: monitors_incomplete, op: eq, value: true}
effects:
  - {type: gap, text: "Readiness monitors incomplete; codes may have been cleared recently"}
  - {type: widen, target: repair.mechanical, p90_add: 1000}
  - {type: dispute, weight: 0.05, credit: 1500}
reason: "Monitors incomplete: hidden codes possible"
if_missing: treated as complete
```

```yaml rule
id: M07
group: mechanical
summary: No scan provided
when:
  - {field: scan_present, op: eq, value: false}
effects:
  - {type: add_repair, component: mechanical, low: "$no_scan_mech_low_pct% of clean_wholesale.p50", high: "$no_scan_mech_high_pct% of clean_wholesale.p50"}
  - {type: dispute, weight: 0.08, credit: 2000}
  - {type: gap, text: "No diagnostic scan"}
reason: "No scan: mechanical condition estimated from age and mileage only"
if_missing: missing scan_present is treated as false if codes[] is empty
```

```yaml rule
id: M08
group: mechanical
summary: High mileage
when:
  - {field: odometer, op: gt, value: $high_mileage_mi}
effects:
  - {type: deduct, target: acv, pct: $high_mileage_acv_deduct_pct}
reason: "Mileage above {high_mileage_mi}: lower dealer demand"
if_missing: odometer missing adds gap "odometer not given" and widens both channel bands by comps_widen_pct_per_step
```

```yaml rule
id: M09
group: mechanical
summary: Transmission codes confirmed
when:
  - {field: codes, op: any_code, value: {set: TRANSMISSION, status: [confirmed]}}
effects:
  - {type: unlikely, target: acv, deduct_pct: 12}
  - {type: add_repair, component: mechanical, low: 800, high: 5000}
reason: "Confirmed transmission fault; counts toward red light"
if_missing: no scan handled by M07
```

```yaml rule
id: M10
group: mechanical
summary: ACV red light (serious disclosed issues, thin bidding)
when:
  - any:
    - {field: rules_fired, op: in, value: [M03, M04, M09]}
    - {field: flags.frame_suspected, op: eq, value: true}
    - {field: title.brand, op: eq, value: flood}
    - {field: title.history_brands, op: in, value: flood}
effects:
  - {type: note, text: "Decision.acv_light = red; yellow if exactly one of M05, M08, R03 fired; green otherwise"}
  - {type: deduct, target: acv, pct: $acv_red_light_deduct_pct}
  - {type: note, text: "ACV samples include a no-sale outcome with probability $acv_red_light_p_no_sale; a no-sale adds $acv_relist_days days and is re-priced on Copart"}
reason: "Serious disclosed issues: likely a red-light listing on ACV with few dealer bids"
if_missing: unknowns do not make a car red light; they feed H01 instead
```

```yaml rule
id: M11
group: mechanical
summary: Skip the ACV inspection (pre-inspection triage)
when:
  - {field: input_stage, op: eq, value: pre_inspection}
  - any:
    - {field: rules_fired, op: in, value: [M10]}
    - {field: title.brand, op: in, value: [salvage, nonrepairable]}
effects:
  - {type: note, text: "Decision.skip_acv_inspection = true when the final recommendation is not ACV"}
  - {type: note, text: "Saves $acv_inspection_cost and about $acv_inspection_days days"}
reason: "Scanner codes already show this car would be red light or ineligible on ACV; send it to Copart without an ACV inspection"
if_missing: if input_stage is missing, treat as post_inspection and do not fire
```

## R: Repair cost

Repair is priced as five separate components, each a band with its own source:
`body`, `glass_lights_tires`, `safety`, `mechanical`, `structural`. Body and glass come
from damage grades × `parts_labor.csv` × labor rate (+ paint where flagged). Safety comes
from airbag flags and SRS codes. Mechanical comes from code rules (M). Structural comes
from frame flags. The total band is the sum; `repair.p50 / clean_wholesale.p50` is the
damage ratio used by R07.

```yaml rule
id: R01
group: repair
summary: Part graded unknown
when:
  - {field: damage, op: count_gt, value: {match: {grade: unknown}, gt: 0}}
effects:
  - {type: widen, target: "repair.{component}", p90_add: "replace_high of {part}"}
reason: "{n} parts could not be graded; high end widened"
if_missing: this rule is the missing case
```

```yaml rule
id: R02
group: repair
summary: Area not photographed
when:
  - {field: areas_photographed, op: not_in, value: "{area}"}
effects:
  - {type: widen, target: repair.body, p90_add: $area_prior_p90_add}
  - {type: gap, text: "No photos of {area}"}
reason: "No photos of {area}: repair estimated from a prior"
if_missing: if areas_photographed is absent, assume only areas with damage items were photographed
```

```yaml rule
id: R03
group: repair
summary: Frame suspected
when:
  - {field: flags.frame_suspected, op: eq, value: true}
effects:
  - {type: add_repair, component: structural, low: $frame_suspected_low, high: $frame_suspected_high}
  - {type: unlikely, target: acv, deduct_pct: 15}
reason: "Suspected frame damage"
if_missing: see R04
```

```yaml rule
id: R04
group: repair
summary: Frame status unknown
when:
  - any:
    - {field: flags.frame_suspected, op: is_unknown}
    - {field: flags.frame_suspected, op: missing}
effects:
  - {type: widen, target: repair.structural, p90_add: $frame_unknown_p90_add}
  - {type: verify, text: "Confirm frame: photo of both frame rails behind the front wheels"}
reason: "Frame status unknown"
if_missing: this rule is the missing case
```

```yaml rule
id: R05
group: repair
summary: Airbags deployed
when:
  - {field: flags.airbag_deployed, op: eq, value: true}
effects:
  - {type: add_repair, component: safety, low: "$airbag_per_bag_low * bags + $airbag_module_and_belts_low", high: "$airbag_per_bag_high * bags + $airbag_module_and_belts_high"}
reason: "Airbags deployed: bags, control module and seatbelt pretensioners"
if_missing: bags defaults to 2 when deployment is confirmed but count unknown; unknown deployment is handled by H01 and adds verify "Photo of the steering wheel and dash"
```

```yaml rule
id: R06
group: repair
summary: Repair exceeds the state's total-loss threshold
when:
  - {field: "repair.p10 / clean_wholesale.p50", op: gt, value: "state_rules[title.state].total_loss_threshold"}
effects:
  - {type: exclude, target: fix}
reason: "Even the low repair estimate exceeds the {title.state} total-loss threshold"
if_missing: if the state threshold is not encoded, use 0.75 (PLACEHOLDER) and add a note
```

```yaml rule
id: R07
group: repair
summary: Damage ratio band
when:
  - {field: "repair.p50 / clean_wholesale.p50", op: exists}
effects:
  - {type: note, text: "ratio < 0.20 usually favors ACV; ratio > 0.50 usually favors Copart (PLACEHOLDER cutoffs, informational only, the decision comes from sampling)"}
reason: "Repair is {ratio_pct}% of clean wholesale value"
if_missing: if clean_wholesale is missing, F rules widen the bands and R06 cannot fire
```

## H: Hidden risk (ACV only)

ACV guarantees the description, so claim risk comes only from what is undisclosed:
unknown or missing fields that ACV's own inspection could also miss. Disclosed defects
are deductions (T, M, R rules), never claim risk. Copart sells as-is, so dispute cost
applies to ACV only; Copart's equivalent is the uncertainty discount (F09). Structural
and safety unknowns feed dispute risk; cosmetic unknowns feed the repair band only. No
item is counted in both. Only `dispute_seller_share` of the expected credit reduces the
seller's net (verify who bears arbitration credits before calibrating).

```yaml rule
id: H01
group: risk
summary: Build the ACV dispute cost
when:
  - {field: channel, op: eq, value: acv}
effects:
  - {type: note, text: "P(claim) = min($dispute_cap, $dispute_base + sum(weights)); expected cost to seller = P(claim) * max(credit) of the contributing items * $dispute_seller_share; every weight below applies only to unknown or missing fields"}
  - {type: note, text: "post_inspection: ACV's inspection (undercarriage scan, engine audio, codes) has already resolved what it can, so drop the frame and run-status weights if ACV reported them"}
  - {type: dispute, weight: 0.12, credit: 3000, when: {field: flags.frame_suspected, op: in, value: [true, unknown]}}
  - {type: dispute, weight: 0.10, credit: 2500, when: {field: flags.airbag_deployed, op: is_unknown}}
  - {type: dispute, weight: 0.15, credit: 3000, when: {field: flags.flood_suspected, op: in, value: [true, unknown]}}
  - {type: dispute, weight: 0.08, credit: 2000, when: {field: flags.module_no_comm, op: eq, value: true}}
  - {type: dispute, weight: 0.04, credit: "replace_high of {part}", when: {field: damage, op: count_gt, value: {match: {grade: unknown, cost_gte: $high_cost_unknown_usd}, gt: 0}}}
reason: "Estimated chance of a dealer claim: {p_claim_pct}%"
if_missing: every weight above is triggered by a missing or unknown field; with nothing unknown, P(claim) is dispute_base
```

```yaml rule
id: H02
group: risk
summary: Claim risk too high for the dealer channel
when:
  - {field: acv.p_claim, op: gt, value: $dispute_unlikely_threshold}
effects:
  - {type: unlikely, target: acv, deduct_pct: 0}
reason: "Claim risk above {dispute_unlikely_threshold_pct}%: as-is sale is safer"
if_missing: not applicable
```

## F: Market fit

```yaml rule
id: F01
group: market
summary: Too few comparables
when:
  - {field: "comps_count.{channel}", op: lt, value: $comps_min}
effects:
  - {type: note, text: "Broaden match: exact > year +/-2 > model family > segment; stop at the first step with >= comps_min"}
  - {type: widen, target: "{channel}", pct: "$comps_widen_pct_per_step * steps"}
reason: "Only {n} close comparables on {channel}; widened to {match_level}"
if_missing: this rule is the missing case
```

```yaml rule
id: F02
group: market
summary: No comparables at any level
when:
  - {field: "comps_count.{channel}", op: eq, value: 0}
  - {field: match_level, op: eq, value: segment}
effects:
  - {type: exclude, target: "{channel}"}
  - {type: gap, text: "No price data for this vehicle on {channel}"}
reason: "No comparable sales found on {channel}"
if_missing: if both channels hit this rule, D02 returns insufficient
```

```yaml rule
id: F03
group: market
summary: Configuration unknown
when:
  - {field: config, op: count_gt, value: {match: {value: unknown}, gt: 0}}
effects:
  - {type: widen, target: acv, pct: $config_unknown_widen_pct}
  - {type: widen, target: copart, pct: $config_unknown_widen_pct}
  - {type: gap, text: "Configuration incomplete: {unknown_config_fields}"}
reason: "Priced as base configuration; bands widened"
if_missing: this rule is the missing case
```

```yaml rule
id: F04
group: market
summary: Upfit present (work truck body, racks, ambulance or service body)
when:
  - {field: config.upfit, op: ne, value: none}
effects:
  - {type: widen, target: acv, pct: $upfit_widen_pct}
  - {type: widen, target: copart, pct: $upfit_widen_pct}
  - {type: gap, text: "Upfit value not priced by standard comparables"}
reason: "Upfit present: value uncertain in both channels"
if_missing: treated as none
```

```yaml rule
id: F05
group: market
summary: Model has strong parts or export demand
when:
  - {field: decoded.model, op: in, value: parts_export_demand_list}
effects:
  - {type: note, text: "Copart band uses the higher of rebuilder, dismantler and exporter values"}
reason: "{decoded.model} has strong parts or export demand"
if_missing: list starts empty (PLACEHOLDER); populate only from comparables, never from opinion
```

```yaml rule
id: F06
group: market
summary: Copart buyer segments (who is the best buyer there)
when:
  - {field: channel, op: eq, value: copart}
effects:
  - {type: note, text: "Copart band = max over segments: rebuilder (value after repair - repair - rebuilt discount - margin), dismantler (parts value), hobbyist (like rebuilder with lower labor cost, public buyers only), parts_donor (value of one healthy major assembly, e.g. engine or transmission, to a buyer fixing their own car), exporter (F07)"}
  - {type: note, text: "Decision.best_copart_segment = the segment with the highest typical value"}
reason: "Best Copart buyer: {best_copart_segment}"
if_missing: segments without data are skipped, never guessed
```

```yaml rule
id: F07
group: market
summary: Exporter value
when:
  - {field: decoded.model, op: in, value: export_demand_list}
effects:
  - {type: note, text: "exporter value = foreign comparable price - $export_shipping_usd - margin; domestic rebuild and frame penalties do not apply to this segment where the destination market accepts the repair (verify per market; list starts empty)"}
reason: "International buyers may value this {decoded.model} above domestic buyers"
if_missing: export_demand_list starts empty (PLACEHOLDER); add a model only with foreign comparables
```

```yaml rule
id: F08
group: market
summary: Healthy powertrain in a badly damaged car (parts donor)
when:
  - {field: runs_drives, op: eq, value: "yes"}
  - {field: codes, op: any_code, value: {set: [MISFIRE, TRANSMISSION], status: [confirmed], negate: true}}
  - {field: "repair.p50 / clean_wholesale.p50", op: gt, value: 0.5}
effects:
  - {type: note, text: "parts_donor segment valued from used engine and transmission prices for this VIN"}
reason: "Body is badly damaged but the engine and transmission show no faults: valuable as a donor"
if_missing: if no scan, the donor segment is priced with a wide band and M07 applies
```

```yaml rule
id: F09
group: market
summary: Copart uncertainty discount (buyers bid blind)
when:
  - {field: channel, op: eq, value: copart}
  - {field: high_cost_unknowns, op: gt, value: 0}
effects:
  - {type: deduct, target: copart, pct: "min($copart_uncertainty_discount_cap_pct, $copart_uncertainty_discount_pct * high_cost_unknowns)"}
  - {type: note, text: "If evidence_attached_to_listing is true, recover $copart_evidence_recovery_pct% of this discount"}
reason: "{high_cost_unknowns} costly unknowns lower Copart bids; attaching our evidence recovers part of it"
if_missing: evidence_attached_to_listing defaults to false
```

```yaml rule
id: F10
group: market
summary: Copart buyer license restriction
when:
  - {field: copart_requires_business_license, op: eq, value: true}
effects:
  - {type: limit_buyers, target: copart, segments: [rebuilder, dismantler, exporter]}
reason: "This vehicle requires a business license on Copart: hobbyist and parts-donor buyers excluded"
if_missing: treated as open to the public; which vehicles require a license by title and state is not yet encoded (verify)
```

## S: Seller constraints, preference part

```yaml rule
id: S04
group: seller
summary: Speed preference
when:
  - {field: seller.speed_weight, op: exists}
effects:
  - {type: note, text: "utility = net - speed_weight * holding_cost_per_day * days, applied to every sample"}
reason: "Seller weighs speed at {speed_weight}"
if_missing: speed_weight = 0.3 (PLACEHOLDER), add gap "speed preference not given"
```

```yaml rule
id: S06
group: seller
summary: Optimization objective
when:
  - {field: objective, op: exists}
effects:
  - {type: note, text: "seller_net ranks by the seller's net; platform_revenue ranks by fees earned across ACV and Copart; blended weights both. Always report the seller's net, whatever the objective"}
reason: "Ranked by {objective}"
if_missing: objective = seller_net
```

```yaml rule
id: S05
group: seller
summary: Holding cost
when:
  - {field: seller.holding_cost_per_day, op: missing}
effects:
  - {type: note, text: "holding_cost_per_day = 25 (PLACEHOLDER)"}
  - {type: gap, text: "Holding cost not given; default used"}
reason: "Default holding cost used"
if_missing: this rule is the missing case
```

## D: Decision

These are implemented in `decide.ts`; they live here so the thresholds have one home.

```yaml rule
id: D01
group: decision
summary: Confidence from p_win
when:
  - {field: p_win, op: exists}
effects:
  - {type: note, text: "clear if p_win >= $close_call_high or <= $close_call_low; close_call otherwise"}
reason: "Recommendation wins in {p_win_pct}% of simulations"
if_missing: not applicable
```

```yaml rule
id: D02
group: decision
summary: Insufficient information
when:
  - any:
    - {field: high_cost_unknowns, op: gt, value: $insufficient_unknowns}
    - {field: eligible_channels_with_bands, op: eq, value: 0}
effects:
  - {type: note, text: "confidence = insufficient; still return the best guess and the verify list"}
reason: "Too many costly unknowns to decide"
if_missing: not applicable
```

```yaml rule
id: D03
group: decision
summary: Choose verify_first
when:
  - {field: verify_candidates, op: count_gt, value: 0}
effects:
  - {type: note, text: "For each candidate, rerun with its best and worst case; verify_first is the one that flips the most samples. Ties: structural > title > safety > mechanical > market"}
reason: "Resolving {verify_first} would most change the answer"
if_missing: if no candidates, verify_first = "None needed"
```

```yaml rule
id: D04
group: decision
summary: Order of reasons and risks
when:
  - {field: rules_fired, op: count_gt, value: 0}
effects:
  - {type: note, text: "reasons: exclusions first, then the two largest dollar effects; risks: the two largest unknowns by p90 widening or dispute cost. Every number shown must come from the Decision object"}
reason: "Explanation built from fired rules"
if_missing: if fewer than three rules fired, fill reasons from the comparison (net gap, days gap, comps count)
```

## Changelog

- 0.2: encoded the ACV and Copart business models from the 7 Nov 2026 conversation.
  Disclosed defects no longer add ACV claim risk (removed from T04, T05, T07); H01 now
  counts only undisclosed items and applies the seller's share of credits. Added red
  light (M10), inspection skip (M11), Copart buyer segments (F06), exporter value (F07),
  parts donor (F08), Copart uncertainty discount (F09), Copart license restriction
  (F10) and the objective switch (S06). New parameters, record fields and Decision
  fields listed above.

- 0.1: initial rules from the five criteria: title and legal status, drivability and
  mechanical health, repair cost relative to value, hidden risk, market fit; plus guards,
  seller constraints and decision thresholds.

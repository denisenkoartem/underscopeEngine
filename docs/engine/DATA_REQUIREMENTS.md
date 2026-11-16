# Data requirements (ACV and Copart)

What we would need to replace every PLACEHOLDER in `config/assumptions.yaml`. Volumes are
rough asks for a first calibration, not commitments from anyone.

## From ACV Auctions

| Data | Fields | Replaces | Volume ask |
|---|---|---|---|
| Condition reports | VIN, year/make/model/trim, odometer, region, title status, panel-level damage (panel, type, severity), photos, undercarriage and engine-audio flags | Detector labels, VehicleRecord inputs | 50k+ reports with photos |
| Sale outcomes | sale price, sale date, days to sell, seller fees, transport cost, arbitration/post-sale adjustments | As-is value, ACV fees, days to sell, transport | Same 50k, with outcomes |
| Repaired-and-resold units | pre-repair report, repair invoice by panel, post-repair sale price, title brand | Repair costs, repaired-value haircut, title discount, hidden-damage reserve | 5k+ linked pairs |
| Market values | wholesale value by VIN/trim/mileage/region and date | base_value | Rolling feed |

## From Copart

| Data | Fields | Replaces | Volume ask |
|---|---|---|---|
| Salvage lots | VIN, title brand, primary/secondary damage, photos, runs/drives, final bid, sale date, days to sell, seller fees, tow cost by lane | Salvage fraction, Copart fees, transport, days to sell | 50k+ lots |
| Total-loss context | insurer ACV at loss, repair estimate, total-loss decision | total_loss thresholds, decision labels | 10k+ claims |
| Parts out | dismantler recovery by category, sell-through, days, teardown cost | parts values, sell-through, teardown labor, storage | 2k+ vehicles |

## Labels we need

- Damage labels per photo (panel, type, severity) to train and score a real `DamageDetector`.
- The realized best disposition per vehicle (or realized net for the path taken) to backtest
  decisions. Observed outcomes only cover the chosen path, so counterfactual estimates need care.

## Terms

Access must be through a data partnership or licensed feed. The project never scrapes either site.

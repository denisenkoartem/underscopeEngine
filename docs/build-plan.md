# Build plan: steps, model training, codemap and architecture

This file turns the plan in plan.txt into an engineering sequence: what gets built in which order, how each model is trained and promoted, how the repository is laid out, and how the pieces deploy. The 24-hour build is a compressed version of Phase 1 below; the overnight brief decides how compressed.

## Build steps

Fourteen steps, in dependency order, take the project from an empty repository to a shadow-mode pilot across three 30-day phases. Steps 1 to 7 can run in parallel across three people; nothing after step 7 starts until the harness exists. Owners are roles: BE (backend), DE (data), ML (modeling), PO (product and operations), DR (domain reviewer, an appraiser or used-car manager).

| # | Phase | Step | Deliverable | Done when | Owner |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | Repository, CI, schemas v0 | Monorepo with the core types (codemap below), lint and test pipeline, fixture vehicles | A fixture vehicle passes through every stage as stubs | BE |
| 2 | 1 | Legal and partner outreach | Lawyer's read of Copart and ACV terms; three dealers or one fleet agree to share their own sales records | Written data-use terms for each partner | PO |
| 3 | 1 | Proxy data ingestion | Copart archive sample (tens of thousands of sold lots), vPIC decode, one licensed value API on trial, parts prices; loaders write to the lake with a data-version tag | Row counts and null rates reported per field of the data contract | DE |
| 4 | 1 | Adapter interface | One schema for comps, values, parts, fees, transport; proxy implementations; conformance tests any partner adapter must pass | A fake partner adapter passes with zero engine changes | BE |
| 5 | 1 | Eligibility rules engine | Title and state rules for the ten highest-volume states as YAML, contract and export constraints, unit test per rule | Every fixture vehicle gets an allowed-channel list with reasons | BE, DR |
| 6 | 1 | Condition normalizer v0 | Part taxonomy (about 40 parts), damage graph schema, zero-shot VLM baseline that fills it, invisible-risk flags | Baseline recall measured on 300 blind-labeled vehicles | ML, DR |
| 7 | 1 | Review UI v0 | Blind labeling flow (human sees no model output) and AI-first correction flow; label store with reviewer id and time per vehicle | 300 blind labels collected; labeling time per vehicle known | BE, DR |
| 8 | 1–2 | Channel estimators v0 | Copart lanes from archives, ACV from values plus condition adjustments, parts, direct; each returns P10, P50, P90, days, risks | Harness test 2 (80% band coverage on held-out lots) passes for Copart | ML |
| 9 | 1–2 | Simulator and policy v0 | Channel distributions fitted to proxies, 10,000 simulated vehicles, Monte Carlo ranking, close-call threshold, verification item, seller weights | Regret versus oracle reported; sensitivity table names the top five parameters | ML |
| 10 | 2 | Harness v1 | Tests 1 to 5 as CI jobs with promotion gates and a one-page report | A model that fails any gate cannot be tagged for release | ML, BE |
| 11 | 2 | Partner panel and calibration | Partner records ingested through the adapter interface; ACV-side bands recalibrated | Coverage on partner records within 5 points of target | DE, ML |
| 12 | 2 | Explanation, evidence pack, API | `POST /route` and `POST /outcome`, evidence pack with images and comparables, three-reasons-two-risks-one-step narrative | Every number in the narrative traces to the evidence pack | BE |
| 13 | 2 | Fine-tuned grader | Detector or VLM fine-tuned on collected labels, active learning on disagreements | Dollar-weighted recall beats the zero-shot baseline on the blind set | ML |
| 14 | 3 | Outcome capture, experiments, pilot kit | Mandatory outcome close, calibration job, randomized 10% slice, VIPER payload mapper, weekly lift report | Shadow mode running at one partner with a weekly readout | BE, PO |

Gate 1 needs steps 1 to 9 (bands cover 80% on Copart lots, contestable share measured from the simulator), Gate 2 needs steps 10 to 13 (ranking calibrated on partner data, pilot proposal accepted), Gate 3 needs step 14 (lift above target on contestable vehicles).

## Model training plan

Training proceeds in the order the data arrives: a zero-shot vision baseline first (no training, so measurement starts on day one), then channel price models on Copart archives, then the fine-tuned grader on labels the review flow has collected, then risk models once pilot outcomes exist. The decision policy is never trained on past decisions; it is tuned on simulation and checked on calibration.

| Model | Purpose | Data now | Data later | Approach | Gate (from the harness) | Retrain |
| --- | --- | --- | --- | --- | --- | --- |
| Damage grader | Part-level grade (fine, repairable, replace, unknown) and invisible-risk flags | Own scans and partner photos labeled in the review UI; public CarDD only as a benchmark (non-commercial license) | VIPER damage lists as a second labeler | Week 1: zero-shot VLM filling the damage graph. Phase 2: an Apache-2.0 detector (RF-DETR) for localization plus a LoRA fine-tune of an 8B vision-language model for per-part grading; active learning on model-human disagreements | Dollar-weighted recall above the zero-shot baseline on the blind set; per-part precision reported | Weekly in Phase 2, monthly after |
| Copart price bands | P10, P50, P90 by lane for a vehicle | Archived sold lots with damage, title, odometer, run status, yard, date | Copart contract data by lane and bidder segment | Gradient-boosted quantile regression on VIN decode, damage-graph features, title, odometer, region, month; conformal calibration of the band | 80% coverage on a time-held-out month; band width narrower than a fixed-width baseline | Weekly |
| ACV price bands | P10, P50, P90 for dealer wholesale | Licensed clean values with condition adjustments; partner panel records | ACV sale and bid data | Same model family with stronger shrinkage toward the value API while data is small | 80% coverage on partner records | Weekly |
| Parts value | Sum of part values times sell-through probability | Car-Part and eBay prices, Hollander mapping | Recycler partner invoices | Lookup tables plus a regression for sell-through time by part and model | Error on partner invoices within 20% | Monthly |
| Completion and dispute risk | Probability of completion, probability of dispute, expected credit | Fixed priors from lane rules and ACV policy bounds | Pilot outcomes by buyer segment | Logistic or gradient-boosted classifier once outcomes exceed 500 per channel; priors until then | Brier score and calibration plot per channel | Per pilot cycle |
| Decision policy | Ranking, close-call test, verification item | Simulator only | Randomized pilot slice | Monte Carlo over the estimators' bands; thresholds tuned on simulated regret; no supervised training | Probability-of-winning calibrated on realized outcomes; regret versus oracle | Per release |
| Explanation | Three reasons, two risks, one next step | Templates over the evidence pack, LLM for wording | Reviewer edits as preference data | Constrained generation: every number must appear in the evidence pack or the sentence is dropped | Zero unsupported numbers on a 100-vehicle audit; reviewer rating | Per release |

Training rules that apply to every model:

1. Blind labels measure, AI-first labels scale. Keep a random 3% of vehicles labeled without model output; use those only for measurement, never for training the same release.
2. Weight by dollars. A missed $2,000 part counts twenty times a $100 scratch in both the loss and the metric.
3. Split by time and by VIN. Train on months before the test month; a VIN appears in one split only.
4. Never train an end-to-end routing classifier on past channel choices; it learns what sellers did, not what paid best.
5. Version everything: data snapshots, labels, features, model weights and the harness report that promoted them live in the registry together.
6. Proxy-to-partner swaps re-run the whole harness; a swap is a release.
7. Monitor drift monthly: feature distribution shift, band coverage, and reviewer disagreement rate; coverage below 75% blocks the engine for that channel until recalibrated.

Label budget: 300 blind-labeled vehicles in Phase 1 and 2,000 to 3,000 labeled vehicles by the end of Phase 2 at about 5 minutes each, roughly 250 reviewer hours.

Note for the 24-hour build: none of the training above happens in the 24 hours. The 24-hour version uses the zero-shot hosted vision model (step 6, week 1 column), a spreadsheet for repair costs, and hand-entered comparables for 20 test vehicles.

## Codemap

One monorepo, one shared type package, and a package per stage of the engine, so a stage can be replaced (proxy adapter to partner adapter, zero-shot grader to fine-tuned grader) without touching its neighbors. Python for the engine and models, the existing Lovable front end kept as the seller app, a small reviewer UI beside it.

```text
underscope/
  apps/
    api/              FastAPI service: POST /route, POST /outcome, GET /evidence/:id
    seller-app/       the current Lovable front end, calling /route
    review-ui/        reviewer queue: blind labeling and AI-first correction flows
  packages/
    schema/           core types shared by every package (below); JSON Schema export
    rules/            eligibility: title brands, state rules as YAML per state, contracts, export
    condition/        vision inference, part taxonomy, damage graph builder, invisible-risk flags
    codes/            scanner (OBD-II) code decoding: standard table, make-specific tables, unknown path
    adapters/         one interface, many implementations: comps, values, parts, fees, transport
      proxy/          Copart archive, vPIC, value API, parts prices, distance-based transport
      partner/        Copart/ACV contract adapters, filled during the pilot
    estimators/       per-channel models: acv, copart_lanes, parts, direct; each returns a ChannelEstimate
    policy/           Monte Carlo ranking, close-call test, verification item, seller utility
    review/           routing rules for human review, blind-sample draw, task queue
    explain/          evidence pack assembly and constrained narrative generation
    feedback/         outcome capture, calibration jobs, randomized routing experiments
    sim/              simulator, regret versus oracle, parameter sensitivity
    harness/          tests 1 to 5, promotion gates, one-page report
  ml/
    datasets/         snapshot builders with data-version tags; time and VIN splits
    train/            grader, price-band and risk training pipelines; experiment tracking
    registry/         model versions with their harness reports
  data/
    contracts/        the data contract as JSON Schema
    fixtures/         fixture vehicles that run end to end in CI
  infra/              containers, CI pipelines, environment configs (proxy, pilot, hosted-at-partner)
```

The core types every package imports (field lists, not code):

| Type | Fields | Produced by | Consumed by |
| --- | --- | --- | --- |
| ScanPayload | vin, source (viper or underscope), images, undercarriage images, damages (part, type, severity, image ref, confidence), tire tread, captured at | VIPER mapper or seller app | condition |
| ScannerCodes | vin, codes (code, system, description, severity, source table, mapped yes/no) | codes | condition, estimators |
| Facts | odometer, title brand, title state, keys, runs and drives, engine clip ref, dash lights | seller app or partner feed | rules, condition, estimators |
| SellerProfile | seller type, location, lanes allowed, weights (price, speed, risk), repair capability, labor rate | seller app or partner feed | rules, policy |
| DamageGraph | part grades, invisible-risk flags, evidence refs, model version | condition | estimators, explain |
| ChannelEstimate | channel, p10, p50, p90, days to cash, p complete, p dispute, expected credit, fees, transport, comparables | estimators | policy, explain |
| Decision | ranked estimates, p win per channel, confidence, verification items, buyer segment, reason, model versions, evidence id | policy | api, review, feedback |
| Outcome | decision id, realized channel, price, days, dispute, unwind, relist | feedback | harness, ml/datasets |

Two conventions keep the plug-in promise honest: every adapter and estimator declares the contract fields it needs and fails loudly when one is missing, and every Decision records the data version and model versions that produced it, so a backtest can be rerun exactly.

## Abstract architecture

Five lanes, top to bottom; requests flow down, feeds flow up.

1. Clients: the seller app (Lovable; upload scan, read ranking), the reviewer UI (blind labels, corrections), and partner integration (VIPER mapper, bulk import). All three call the same API.
2. Services, stateless and containerized: the routing API (FastAPI: POST /route, POST /outcome, GET /evidence/:id, auth and audit log) in front of three services: condition (the only GPU workload; zero-shot VLM first, fine-tuned grader later), rules + estimators + policy (eligibility, channel bands, Monte Carlo ranking; one service because a recommendation is one transaction), and review + explain (review queue, blind draw, evidence pack, narrative).
3. Data, versioned: Postgres (decisions, outcomes, labels, reviewer time), object store + lake (images, evidence packs, snapshots, training sets), model registry (weights, versions, harness reports; a model is stored only with the report that promoted it).
4. Scheduled jobs: nightly adapter refresh, weekly retraining, monthly calibration and drift checks, routing experiments. The online path never calls an external API; a feed outage degrades freshness, not availability.
5. External systems: VIPER / ACV (scan payload and lanes, under NDA in a pilot), Copart data (archives, members' CSV, contract feed later), market APIs and partners (values, parts, transport; dealers' and fleets' own records).

The same containers run in three environments: proxy (our data), pilot (partner data through adapters), hosted-at-partner (inside Copart/ACV, their data never leaving).

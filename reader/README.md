# Underscope reader

`reader/` does one job: a seller's free-text description of a damaged vehicle goes in, one JSON of
assessment parameters comes out. The engine (`engine/`, `/api/route`, `/api/decide`) analyzes that JSON
later. The reader itself decides nothing about where to sell or whether to repair.

## Input

The text of the page's description box (up to 20,000 characters), as the seller types it. The box asks for:

- the title (brand, in hand or not, any lien), the mileage and whether it is actual, the state, who is selling
- whether it runs and drives, keys, engine and transmission condition
- where it was hit, what is damaged part by part, whether the rest is fine
- airbags, frame, leaks, flood and fire signs, the catalytic converter
- the clean wholesale value, at least 3 sold prices of similar damaged vehicles, a repair quote, the
  lowest price accepted, deadlines and storage fees
- anything else: warning lights, fault codes, complaints, repairs already done

## Output: the contract (`src/contract.ts`)

| Group | Fields |
|---|---|
| Vehicle | `vin`, `vehicle.{year, make, model, trim}`, `drivetrain`, `fuel_type` |
| Title | `title_status`, `title_state`, `title_in_hand`, `lien` |
| Mileage, place, seller | `mileage`, `odometer_status`, `region`, `zip`, `seller_type`, `lanes_allowed` |
| Running | `run_status`, `keys`, `engine_condition`, `transmission_condition` |
| Damage | `primary_damage`, `secondary_damage`, `grades` (25 parts), `flags.{airbags_deployed, frame_suspected, fluid_leak, flood_suspected, fire_damage}`, `catalytic_converter`, `parts_missing`, `already_repaired` |
| Complaints | `warning_lights`, `codes`, `symptoms` |
| Money and timing | `values.{clean_wholesale, salvage_comps, purchase_price, repair_estimate, reserve_price}`, `storage_cost_per_day`, `sell_by_days` |
| About the reading | `reader`, `evidence`, `missing`, `could_add`, `questions`, `additional`, `conflicts` |

- What the text does not say is `"unknown"`, `null` or an empty list. Nothing is guessed.
- `evidence` maps each filled field to the exact words it was read from.
- `missing` is what the decision cannot run without; `could_add` is what would sharpen it.
- Left and right are the vehicle's own sides: driver = left, passenger = right.

### Criteria: why these fields

Seller's margin in a lane = expected price x chance it sells - seller fees - transport - holding cost -
post-sale clawback. The fields added on 2026-11-16 each move one of those terms:

| Field | What it changes |
|---|---|
| `seller_type` | Only eligible wholesale sellers (dealers) can list on ACV; Copart's fee schedule depends on the seller |
| `title_in_hand`, `lien` | ACV pays the seller only after a negotiable title arrives; a missing title cuts conversion |
| `odometer_status` | ACV red light for a 5-digit or not-actual odometer; a Copart listing attribute |
| `keys`, `run_status` | Copart lists both; buyers price on them |
| `primary_damage`, `secondary_damage` | Copart's own listing categories; they decide which buyers bid |
| `engine_condition`, `transmission_condition` | The largest mechanical costs; on ACV a disclosed defect cannot be claimed back |
| `flags.fire_damage`, `flags.flood_suspected` | Salvage-lane signals |
| `catalytic_converter` | ACV mandatory disclosure (to 125,000 miles); scrap value |
| `values.repair_estimate`, `already_repaired` | The repair band |
| `values.reserve_price` | Chance of a sale |
| `warning_lights`, `codes`, `symptoms` | Disclosures: on ACV, anything disclosed is not arbitrable; undisclosed defects are repaid by the seller |
| `zip`, `storage_cost_per_day`, `sell_by_days` | Transport and holding cost |
| `drivetrain`, `fuel_type`, `parts_missing` | Buyer pool and demand |

Sources: [ACV arbitration policy](https://www.acvauctions.com/legal/arbitration), [ACV terms of service](https://www.acvauctions.com/legal/terms-of-service),
[ACV 10-K FY2025](https://www.sec.gov/Archives/edgar/data/1637873/000163787326000011/acva-20251231.htm),
[Copart 10-K FY2015](https://www.sec.gov/Archives/edgar/data/0000900075/000162828015007286/cprt07312015-10k.htm),
[Manheim title study](https://press.manheim.com/2014-07-10-Manheim-Study-Reveals-Presence-Of-Physical-Title-At-Sale-Greatly-Increases-Vehicle-Conversion-Rate).
Not confirmed: either company's fee schedule (behind a login), and any published price premium for keys
or run-and-drive. Still needed for the decision but not from text: fee schedules, transport by distance,
days to sell, comps per lane, parts and export demand by model (engine tables).

## One entry point, one decision maker

```ts
import { read } from "./src/read.js";
const { assessment, issues, model_error } = await read(text);
```

Two things can read a description. They never answer side by side: `merge()` in `src/read.ts` is the only
place that decides what the output says.

| | Rules (`src/rules.ts`) | Model (`src/model.ts`) |
|---|---|---|
| What | keyword rules | the fine-tuned model at `PARSER_BASE_URL` |
| Cost | free, instant | a few seconds on a GPU |
| Runs | always | when a model server is configured |
| Guard | each value keeps the words it matched | each value needs a quote that is in the text and shows it; the rest is dropped and listed in `issues` |

How `merge()` decides:

1. A field only one of them read: that value.
2. Both read it the same: that value.
3. They differ on a risk flag: the worse value (`true`).
4. They differ on a part grade: the costlier grade (replace > repairable > fine).
5. They differ on anything else: `PRIMARY`'s value. `PRIMARY` is `"rules"` until the model comparison
   shows a trained model reads better; it is one constant in `src/read.ts`.

Lists (codes, warning lights, symptoms) are joined. Every difference in 3 to 5 is recorded in `conflicts`
and asked back in `questions`. If the model server gives no answer, the output is the rules' reading and
`model_error` says why.

## Use

```
pnpm install
pnpm -s engine read "Clean title in hand, 84k miles, no keys. Front hit: front bumper and hood need replacing, rest is fine. Runs and drives. Shop quoted $3,200."
pnpm -s engine read --file notes.txt --out assessment.json
pnpm -s engine read "..." --rules-only     # never call the model
pnpm -s engine read "..." --model          # fail if the model gives no answer
```

- `POST /api/parse-notes { text }`: the rules alone, as the seller types (what the page uses).
- `POST /api/engine { text }` (off unless `ENGINE_ENABLED=1`): rules and model merged.

Settings (`.env` at the repo root or in `reader/`; none are needed for the rules):

| Variable | Meaning |
|---|---|
| `PARSER_BASE_URL` | The model server, OpenAI-compatible (`http://127.0.0.1:8000/v1` for `reader/model/serve.py`) |
| `PARSER_MODEL` | Model name on that server (default `underscope-reader`) |
| `PARSER_SPARSE=1` | The adapter was trained on sparse answers (only the fields the notes mention) |
| `PARSER_PROMPT` | A prompt file other than `prompts/read.md` (for an adapter trained with one) |
| `PARSER_API_KEY`, `PARSER_TIMEOUT_MS` | Key for the server if it wants one; request timeout (default 180000) |

No paid service is called anywhere in `reader/`.

## Files

| Path | What |
|---|---|
| `src/contract.ts` | The output JSON |
| `src/rules.ts` | The keyword reader |
| `src/model.ts` | The model reader: answer shape, request, checks (`verifyAnswer`) |
| `src/read.ts` | `read()` and `merge()` |
| `src/cli.ts` | `pnpm engine read` |
| `src/chatAdapter.ts`, `src/openaiParse.ts` | Transport to an OpenAI-compatible server |
| `prompts/read.md` | The model's instructions. `read_short.md`: a short variant for one comparison run. `read_v1.md`: what run1 was trained with |
| `scripts/reader/` | Training data: `synth.ts` (template notes), `upgrade.ts` (old notes to the new contract), `export.ts` (training files), `eval.ts` (scoring), `gold.ts` (the test set) |
| `fixtures/reader/gold.jsonl` | 191 hand-written test notes with expected assessments. Never trained on |
| `fixtures/website/` | Page request bodies used by `engine/tests/test_bridge.py` |
| `model/` | `train.py`, `serve.py`; see `model/README.md` |
| `data/reader/` | Training files, gitignored |

## Tests and the baseline

```
pnpm test          # 49 tests, no network
pnpm typecheck
pnpm reader:eval -- --gold fixtures/reader/gold.jsonl --reader rules
```

Rules reader on the 191 test notes (2026-11-16): 98.2% of all fields right, 82.3% of the fields the notes
state, 0.18 invented and 0.97 missed values per note. The rules were adjusted after looking at their
misses on this set, so this number flatters them a little. A trained model has to beat it to be worth
running; see `model/README.md`.

The earlier lane-scoring code (category scores, market fit, the ACV-vs-Copart combine) was removed on
2026-11-16 and is kept on the local branch `archive/reader-scoring`.

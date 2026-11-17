# Sample user inputs: sources, licenses and what they are good for

Two files, both collected for training and testing the reader:

- `sample_user_inputs.jsonl`: 547 real texts about vehicles. One JSON object per line: `id`, `notes`,
  `origin`, `source`, `license`, `url`, `meta` (NHTSA lines also have `notes_original` and `vin`).
- `sample_user_assessments.jsonl`: the rules reader's JSON for each of those texts.

The line shape was confirmed with the reader session on 2026-11-16. Nothing here comes from the
reader's test set (`reader/fixtures/reader/gold.jsonl`).

## What the reader needs, and what real data can give it

The reader is trained on pairs: a description and the correct JSON for it. So far every training pair
is a template sentence written by a script. Real text helps in three ways, in this order of value:

1. **Real text that comes with real recorded facts.** The record's own fields are free, correct
   labels for some of the reader's fields. No paid labeling is needed.
2. **Real text with no labels.** Shows the wording the templates miss; useful for testing and for
   measuring how often people state each fact. Not trainable until someone labels it.
3. **Real structured records with no text.** Give real distributions (which damage goes with which
   title, real mileages) for the synthetic note generator.

| Source | Kind | Reader fields it can label for free | Size | License | Status |
|---|---|---|---|---|---|
| **GSA Auctions** (federal surplus vehicle lots, `api.gsa.gov`) | 1: a real seller's description plus the lot's fields | mileage, state, fuel type, body style; real wording for run status and part damage; also a real high bid per lot | about 50 road vehicles per daily snapshot; grows if collected daily | US federal government data through GSA's open API | **47 lots added** (`gsa_auction_listing`) |
| **NHTSA complaints bulk file** (`static.nhtsa.gov/odi/ffdd/cmpl/FLAT_CMPL.zip`, 377 MB) | 1: narrative plus 51 recorded fields | mileage, state, drivetrain, fuel type, fire, crash, towed, the failed component (symptom system) | about 2 million complaints since 1995 | data.gov: "Access Level: public", no license named; published by a US federal agency | **500 added, each with `meta.recorded`** |
| **Mechanics Stack Exchange** (`api.stackexchange.com`, site `mechanics`) | 2: owners describing faults, with tags | symptom system (from tags), fault codes | 28,545 questions | CC BY-SA (3.0 or 4.0 per post): needs attribution to each author and share-alike | Not added: decide first whether share-alike text may be used for training |
| **Craigslist used-car listings** (Kaggle, Austin Reese) | 1: private sellers' own descriptions plus title status, odometer, condition, state, drivetrain, fuel | title, mileage, state, drivetrain, fuel type | about 426,000 listings | Scraped from Craigslist; the text belongs to the people who posted it; Kaggle login needed | Not added: the closest fit of all, but needs a decision from the team |
| **NHTSA CISS crash investigations** (bulk CSV) | 3: coded damage per vehicle | none directly (no text in the download) | 3,997 crashes in 2023 | US federal data | Not added: the written summaries are only in a web viewer |
| Salvage auction sets (IAAI, Copart) on GitHub and Hugging Face | 3: damage codes, title brands, run status | none directly | large | Scraped; no license, or non-commercial | Not added |

No public source pairs a description with what the car netted on ACV and on Copart. Fee schedules
are not public either: ACV's is behind its dealer login and Copart's US seller fees are set per contract.

## How the rules reader does against the real recorded facts

Measured on the 547 texts as collected, before any edit (2026-11-16):

| Fact | Right | Wrong | Not read | Out of |
|---|---|---|---|---|
| GSA listing: mileage | 46 | 0 | 0 | 46 |
| GSA listing: fuel type | 46 | 0 | 0 | 46 |
| GSA listing: state | 0 | 0 | 47 | 47 |
| GSA listing: run status read at all | 12 | 0 | 35 | 47 |
| GSA listing: any part graded | 19 | 0 | 28 | 47 |
| NHTSA: fire flag, when NHTSA recorded a fire | 43 | 1 | 12 | 56 |
| NHTSA: mileage | 15 | 26 | 214 | 255 |
| NHTSA: fuel type | 6 | 0 | 48 | 54 |
| NHTSA: drivetrain | 1 | 0 | 36 | 37 |

Reading these: the GSA state is never in the description text (it is a separate field of the lot), so
"not read" there is expected. Run status on GSA lots is usually worded as "Vehicle may or may not
start" or "not running and has been parked", which the rules do not cover. For NHTSA mileage, "wrong"
mostly means the narrative gives a different mileage than the one recorded at the failure, and most
narratives give none.

## The NHTSA lines were edited so the engine can route them

`scripts/prepare-sample-inputs.ts` rewrote the 500 NHTSA lines. The real narrative is kept word for
word in `notes_original`. `notes` is that narrative with the facts it never states added on their
own lines: vehicle, title, mileage, state, clean wholesale value and at least 3 comps. Each line also
has a `vin` beside the text, as the page takes the VIN in its own field.

- **Real:** mileage and state come from NHTSA's record (`meta.recorded`) when it has them.
- **Made up:** the title, the clean value, the comps, the VIN, and the mileage or state when NHTSA has
  none. Everything made up is listed per line in `meta.synthetic`. The VINs have valid check digits
  but are not real cars. The prices come from a rough depreciation curve, not market data.

Checked on all 500: the rules reader read the added title, value and comps back exactly
(`meta.reader_ok`), and the engine routed every one with no error. Because the values are invented,
the engine's answers on these lines show that the pipeline runs; they are not labels to train on.

The GSA lines are not edited. They are real sale descriptions already.

## What is in `sample_user_assessments.jsonl`

1,047 lines in the shape of the engine's reader fixture, `{id, kind, vehicle, recorded, a}`:
- `real_text` (500): the reader's JSON for each untouched NHTSA narrative. Nothing is added to the text.
- `real_text_plus_values` (500): the same for the edited text; carries a `vin` and can be routed.
- `real_listing` (47): the reader's JSON for each GSA lot.

How often the 500 NHTSA narratives state each fact: who is writing 43%, a symptom 33%, where the
damage is 26%, airbags 19%, mileage 17%, any part's damage 13%, fire 13%, a warning light 11%, engine
condition 8%, run status 7%, leak 5%, transmission 2%, a fault code 2%, frame 1%, flood 1%, title 0%.

**These are owners' complaints about defects, not sellers describing a damaged car for sale.**
Symptoms are over-represented; damage, title and values are under-represented. A profile built from
`real_text` should be labelled that way and kept a small share of any training mix.

Neither file has outcomes (what a car netted on each marketplace), so neither is a training label
for the engine.

## How the lines were chosen and cleaned

- **NHTSA:** 25 common models, 2010 to 2023; 150 to 4,000 characters; mentioning a condition a seller
  would describe; at most 6 per model and year; 200 taken only from complaints marked crash or fire.
  Lines with an email address or phone number are skipped. NHTSA's partial VIN is not kept.
- **GSA:** active lots whose name starts with a model year and that list a mileage, excluding
  tractors, trailers, buses and similar. VINs, phone numbers and email addresses are removed from the
  text; the contracting officer's name and contact are not stored.

Limits: many NHTSA texts are written by NHTSA call-takers ("The contact owns..."). The GSA texts are
written by government fleet staff and follow a house style, so they are closer to a dealer's listing
than to a private seller's note.

## Looked at and not included

| Candidate | Why not |
|---|---|
| CarGurus listings on Hugging Face (`rebrowser/carguruscom-dataset`) | CC BY-NC 4.0 (no commercial use); scraped listings. |
| IAAI and Autotrader datasets on GitHub (`rebrowser/...`) | Scraped auction and listing data; no license found. |
| `Yoad22/craigslist-used-cars-eda` on Hugging Face (CC BY 4.0) | A cleaned copy of the Kaggle Craigslist set with the description column removed. |
| `KTHESAT/european-used-car-market-2m-listings` (CC BY-NC-SA 4.0) | Non-commercial; scraped listings. |
| Repackaged NHTSA complaints on Hugging Face (`williamTLmiller/...`, `iqbaltaher/...`, `ItsMayur/...`) | The same text comes straight from NHTSA, without a third party's license on top. |
| Hatla2ee listing sets on Hugging Face | License "unknown"; scraped; not US listings. |
| GitHub repositories (car damage descriptions, listing text, insurance claim text) | Nothing with both free text and a license. |

## Adding more

The collectors are outside the repo, in `~/tools/browser/`:
- `nhtsa_collect.py SAMPLE.jsonl <max_new> <seed>` appends complaint narratives from the API.
- `enrich_and_gsa.py SAMPLE.jsonl FLAT_CMPL.zip active-auctions.json` adds NHTSA's recorded facts and
  appends the day's GSA vehicle lots. Running it daily is the cheapest way to grow the real seller text.

After either, run `npx tsx scripts/prepare-sample-inputs.ts`.

# Sample user inputs: sources and licenses

`sample_user_inputs.jsonl` holds real free text about vehicles, collected for later training of the
reader. One JSON object per line: `id`, `notes` (the text, up to 20,000 characters), `origin`,
`source`, `license`, `url`, `meta`. The shape was confirmed with the reader session on 2026-11-16.

These are unlabeled inputs. A training item also needs a `target` (the reader's answer); there is no
free labeling step yet, so this file is raw material. Nothing here comes from the reader's test set.

## Included

| Origin | Lines | What it is | License check |
|---|---|---|---|
| `nhtsa_odi_complaint` | 500 | Complaint narratives filed with NHTSA's Office of Defects Investigation, fetched from the public API `api.nhtsa.gov/complaints/complaintsByVehicle` for 25 common models, 2010 to 2023. | data.gov lists the dataset as "Access Level: public" and states no license. NHTSA is a US federal agency. The narratives are written by consumers or by NHTSA call-takers ("The contact owns..."). Confirm the terms before any commercial use. |

How the NHTSA lines were chosen: 150 to 4,000 characters, mentioning a condition a seller would
describe (airbags, crash, damage, leak, fire, won't start, transmission, codes, towing, rust), at most
6 per model and year. 200 of the 500 were taken only from complaints NHTSA marks as a crash or a fire. Lines with an email address or phone number are skipped. The partial VIN that
NHTSA publishes is not kept.

Fit for the reader: good for symptoms, warning lights, fault codes, run status, airbags, fire and
crash wording. They are not sale descriptions: they say nothing about title, market values, part by
part damage or the seller.

## Looked at and not included

| Candidate | Why not |
|---|---|
| CarGurus listings on Hugging Face (`rebrowser/carguruscom-dataset`) | License is CC BY-NC 4.0 (no commercial use); scraped listings. |
| IAAI and Autotrader datasets on GitHub (`rebrowser/...`) | Scraped auction and listing data; no license found. |
| Craigslist used-car listings on Kaggle (Austin Reese) | Scraped from Craigslist. It has the sellers' own descriptions, which is the closest fit, but the text belongs to the people who posted it and Kaggle needs a login to download. Not taken without a decision from the team. |
| `Yoad22/craigslist-used-cars-eda` on Hugging Face (CC BY 4.0) | A cleaned copy of the Kaggle set with the description column removed, so it has no text. |
| `KTHESAT/european-used-car-market-2m-listings` (CC BY-NC-SA 4.0) | Non-commercial; scraped listings. |
| `williamTLmiller/nhtsa-vehicle-recalls-complaints-defects` (CC BY-NC 4.0), `iqbaltaher/us-vehicle-owner-complaints-by-model-2010-2025` (CC BY 4.0), `ItsMayur/Vehicle_Complaints_NHSTA` (MIT) | Repackaged NHTSA complaints. The same text comes straight from NHTSA above, without a third party's license on top. |
| Hatla2ee listing sets on Hugging Face | License "unknown"; scraped; not US listings. |
| NHTSA Crash Investigation Sampling System (CISS) 2023 bulk CSV files | Public federal data, but the 39 tables are coded fields only. The investigators' written crash summaries are not in the download; they are shown only in NHTSA's CrashViewer web tool, which would mean scraping. |
| GitHub repositories (searched for car damage descriptions, listing text, insurance claim text) | Nothing with both free text and a license. The one hit, `kiranknm/Car_damage_dataset`, is images with captions and has no license. |

## Adding more

The collector is outside the repo: `python3 -I ~/tools/browser/nhtsa_collect.py data/sample_user_inputs.jsonl <max_new> <seed>`.
It appends and skips ids already in the file.

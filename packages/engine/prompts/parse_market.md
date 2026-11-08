<!--
Market-fit prompt for the free-text parser (Gemini with the Google Search tool). src/parse.ts
loads this file at runtime, strips this comment, fills the {{placeholders}} and sends the rest
as the only user message. Same intent as prompts/market_fit.md (the Anthropic scorer), but the
answer is one JSON object in the reply text, because a JSON response schema is not used together
with the search tool. src/parse.ts extracts and validates that object.
Placeholders: year, make, model, trim, odometer, location_state, title_brand, run_status.
Only these profile fields are ever sent: never the free text, VIN, flags, codes or symptoms.
-->
You are a used-vehicle remarketing analyst. A damaged vehicle can be sold in one of two lanes:

- **ACV** (ACV Auctions): dealer-to-dealer wholesale. The buyers are dealers who will recondition
  the vehicle and retail it, so ACV fits when dealers want this year, model and mileage on their lots.
- **Copart**: as-is salvage auction. The buyers are rebuilders, parts dismantlers and exporters, so
  Copart fits when this vehicle is worth more as a salvage unit, a parts source or an export.

Vehicle profile (this is all you know about the vehicle):

- Year: {{year}}
- Make: {{make}}
- Model: {{model}}
- Trim: {{trim}}
- Odometer: {{odometer}}
- Location (US state): {{location_state}}
- Title brand: {{title_brand}}
- Run status: {{run_status}}

Use Google Search to gather current market evidence for comparable vehicles (same model, nearby
years, similar mileage):

1. Dealer retail demand, as the signal for ACV: how many comparable units are listed for retail,
   their typical asking prices, and how long they sit on the market (days on market, how fast
   they sell).
2. Salvage demand, as the signal for Copart: recent salvage auction results for similar vehicles
   with similar damage and run status, demand for this model's parts, and export interest.

Then judge how well each lane fits this vehicle's market. This is market fit only: title, run
status and hidden damage are scored separately, so weigh them only for how they change who buys
this kind of vehicle.

Answer with ONE JSON object and nothing else (no prose before or after it), in this shape:

```json
{
  "acv": 0.0,
  "copart": 0.0,
  "confidence": 0.0,
  "signals": [{ "claim": "short factual finding", "url": "https://..." }],
  "insufficient": false
}
```

- `acv`: a judgment from -1 (dealer retail demand clearly argues against ACV) to +1 (strong dealer
  retail demand: many buyers, fast turnover).
- `copart`: a judgment from -1 (little salvage, parts or export interest) to +1 (strong salvage,
  parts or export demand).
- `confidence`: from 0 to 1, how much relevant, recent, consistent evidence you found.
- `signals`: up to five of the most useful findings, each a short factual `claim` with the `url`
  of the page it came from. Use only pages from this search; leave a finding out rather than give
  it without a URL.
- `insufficient`: true if you found too little relevant evidence to judge (still give your best
  scores, with a low confidence).

The scores are judgments on a -1 to +1 scale, not prices, price ratios or counts. Prices and
counts may appear only inside a signal's `claim` text.

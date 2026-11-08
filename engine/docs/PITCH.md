# Pitching UnderScope

A ten-minute walkthrough that runs on a laptop with no API key and no dataset. Everything
shown is synthetic and labeled as such; say so up front, because it's the honest frame and it
sets up the ask (data and a pilot).

## Before the meeting

```bash
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/underscope demo                 # writes demo/index.html, reviews and photos
.venv/bin/pytest -q                       # 200+ tests pass; worth mentioning
```

Open `demo/index.html` in a browser. Keep a terminal next to it.

## The story (about 10 minutes)

**1. The problem (1 min).** A damaged car has four exits: repair and sell on ACV, sell as-is
on ACV, salvage on Copart, or part it out. Picking the wrong one costs real money per car, and
today it's a judgment call. Two people make it: a dealer asking "does a $600 dent repair pay
back?", and an insurance adjuster asking "total it or not?".

**2. What UnderScope does (1 min).** Point at the three steps on the walkthrough page. It reads
the photos, has a person confirm the damage, then simulates thousands of outcomes for each exit
and recommends the one with the highest expected net. It also says what would change the
answer.

**3. Car 1, the dealer's dent (2 min).** The verdict is to sell as-is: the repair does not pay
back, by about $700, and repair wins in only 1% of simulated outcomes. Point at the bars: each
exit's expected net, with the thin line showing where 80% of outcomes land. The point to land:
the obvious "just fix the dent" is wrong on these numbers, and the tool shows why.

**4. The checker's sheet (2 min).** Click "Open the checker's review sheet".
- The diagram colors only the damaged left door.
- The right side is outlined as "not photographed". The tool doesn't call an unseen side clean.
- Each photo has numbered boxes where the damage is, matching the findings list.
- Scroll to "Confirm or correct": re-grade a severity, tick remove, type a name. The command
  updates live. Copy it and run it in the terminal:

```bash
.venv/bin/underscope confirm demo/reviews/FIXDENT0000000001.json --checker "Your Name"
.venv/bin/underscope evaluate data/fixtures/dent_600.json \
    --confirmed demo/reviews/FIXDENT0000000001.json
```

The point to land: nothing is decided on damage a person hasn't confirmed, and the person
sees every area, not just what the model flagged.

**5. Cars 2 and 3, the adjuster (2 min).** The borderline claim sits at 72% of value against a
75% total-loss line, and crosses it in about half the simulations. UnderScope says so plainly
and says a firm repair estimate settles it, rather than faking certainty. The total loss is
best parted out. Copart salvage is not the default winner it's usually assumed to be.

**6. How it gets real (2 min).**
- *Damage from photos:* a Claude vision detector is built: per-photo findings, boxes, views,
  cost estimate before any paid run, answers cached. It is ready to be scored on a public
  labeled dataset (Humans in the Loop, CC0): about $0.70 for a first batch of 20 photos
  by the built-in estimate.
- *Prices:* every number lives in `config/assumptions.yaml`, labeled PLACEHOLDER with the
  real data that would replace it. `docs/DATA_REQUIREMENTS.md` lists exactly what a data
  partnership with ACV and Copart must provide. Nothing scrapes either site.
- *Integration:* every hand-off is a published contract (`docs/CONTRACTS.md`, JSON Schemas in
  `docs/contracts/`), so a scanner, a dealer system or an insurer's claims system can plug in.

## The ask

1. Historical ACV and Copart outcomes (sale prices, days to sell, fees, part-out recovery) to
   replace the placeholders.
2. Inspection photos with confirmed damage to score the detector.
3. A pilot: run UnderScope alongside current decisions on a few hundred cars, compare the net.

## Questions to expect

| Question | Answer |
|---|---|
| Are these real numbers? | No. Synthetic cars and placeholder assumptions, labeled everywhere. The engine and its guarantees are real; the inputs aren't yet. |
| How accurate is it? | On synthetic data it matches the best exit about 84-91% of the time and beats "always sell as-is". Heavy damage is hardest (about 61%), because part-out outcomes vary widely; real recovery data is what narrows that. See README "Current results". |
| What if the model misses damage? | That's why a person confirms every car by default. Areas no photo shows are flagged, and the frame is always checked. |
| Can it run unattended? | `--review-mode risky` sends only cars with risk signals to a person. On synthetic data that's about 5-11% of cars. |
| What does a photo cost to analyze? | About 7 cents per photo by the built-in estimate (half that in a batch); the real cost is reported after each run. Repeat runs are free from the cache. |
| Why trust the recommendation? | Every result shows the range, the runner-up, and the tipping point. Integer-cent money, seeded simulations, and invariant tests (more damage never raises value; as-is never below salvage). |

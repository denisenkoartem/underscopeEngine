You are working unattended on UnderScope; no human will answer questions. Read CLAUDE.md
first. When you would normally ask something, pick the most reversible option, note the
choice under "Decisions for humans" in PROGRESS.md, and continue.

This session can end at any moment (time or usage limit), so:
- Commit after every working step, with tests passing.
- Update PROGRESS.md at every commit: checklist, decisions, blockers, and one "Next step" line.
- Read only what you need; start from "Next step" instead of re-reading the whole repo.
- Keep command output short (pytest -q, head, targeted grep).

## Start of every session
1. Read CLAUDE.md and PROGRESS.md. If PROGRESS.md doesn't exist, create it with the
   milestones below as a checklist.
2. `git status` and `git log --oneline -5`. If the last session left uncommitted work,
   commit it if tests pass; otherwise restore just those files and note it.
3. `pytest -q` if tests exist; fix failures first.
4. Continue from "Next step".

## Milestones, in priority order
If the repo already has code, build on it instead of starting over.

M1 Scaffold: pyproject.toml, src/underscope/, tests/, ruff, .gitignore (.venv, .cache,
   .agent-logs), Makefile with `test` and `lint`.

M2 Domain model (pydantic): VehicleRecord (VIN, year, make, model, trim, mileage, region,
   title status, photo refs, optional undercarriage/engine-audio flags), DamageFinding
   (panel, damage type, severity 0-1, confidence), DispositionOption, Recommendation.
   DamageDetector protocol with a MockDetector that reads labels from fixtures.

M3 config/assumptions.yaml: repair cost ranges per panel and damage type, ACV and Copart
   fees, transport, holding cost per day, days to sell, title-brand discount, parts
   sell-through, hidden-damage reserve, total-loss threshold table. All PLACEHOLDER.

M4 Valuation: as-is value, repaired value, repair cost low/expected/high, salvage value,
   parts-out value, title-brand discount for repaired salvage vehicles.

M5 Decision engine (most important; take care). Net proceeds per path:
   - Repair then ACV: repaired value x title factor - repair cost - ACV fees - transport
     - holding cost x days to sell - hidden-damage reserve
   - As-is on ACV: as-is value - ACV fees - transport
   - Salvage on Copart: salvage value - Copart fees - transport
   - Part out: parts value x sell-through - teardown labor - storage
   Seeded Monte Carlo (~1,000 draws) for P10/P50/P90; rank by expected margin;
   needs_human_review when the top two overlap heavily or confidence is low; flag when the
   total-loss threshold decides the outcome; plain-English explanation of why the winner
   won and what would flip it. Before committing, have one subagent review the diff for
   math, unit (cents vs dollars) and sign errors.

M6 Data: FixtureSource for data/fixtures/; ACVSource and CopartSource stubs listing the
   fields we need (no network); seeded generator for ~500 SYNTHETIC vehicles with ground
   truth, written to data/synthetic/.

M7 CLI (typer): `underscope evaluate vehicle.json`, readable output plus --json.

M8 Proof: backtest vs an oracle on the synthetic set (accuracy, average regret in dollars,
   human-review rate) -> reports/backtest.md. Three case studies (the $600 dent, a
   borderline write-off, an obvious total loss) -> reports/case_studies.md.

M9 Docs: README (setup, usage, Mermaid diagram) and docs/DATA_REQUIREMENTS.md (fields,
   volumes and labels we would need from ACV and Copart).

When M1-M9 are done, add a "Morning summary" section to PROGRESS.md (what was built, how to
run it, results, decisions to review, next three steps), put `STATUS: DONE` on its first
line, and commit.

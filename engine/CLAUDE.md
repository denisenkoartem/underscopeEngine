# UnderScope: Vehicle Intelligence Platform

## What we are building
A decision engine for damaged vehicles. Given images (eventually from ACV's inspection
scanners) plus vehicle data, it estimates the net proceeds of each disposition path and
recommends the one with the highest expected margin:

1. Repair, then sell on ACV Auctions
2. Sell as-is on ACV Auctions
3. Sell as salvage on Copart
4. Part out the vehicle

Personas: the dealer ("does a $600 dent repair pay back on ACV?") and the insurance
adjuster ("total it and send it to Copart, or not?").

Pipeline: perception (images -> damage findings) -> valuation -> decision -> CLI.
Real ACV and Copart data adapters are stubs until we have a data partnership; development
uses fixtures and clearly labeled synthetic data.

## Hard rules
- Never push, change git remotes, or open PRs. Work stays on the local branch.
- Never scrape or call ACV, Copart, or any site whose terms forbid automated access.
- Never read, print, or commit secrets (.env, keys, tokens).
- Never delete or rewrite files you didn't create in this session, unless the user approves. If approval isn't given, skip that change, note it in PROGRESS.md and move on
- Stay inside this repo. Use a project-local .venv; don't install anything globally.
- Never invent real-world market numbers. Every numeric assumption lives in
  config/assumptions.yaml labeled PLACEHOLDER with a note on what real data would replace it.
- If an action is denied, don't look for a workaround. Note it in PROGRESS.md and move on.

## Conventions
- Python 3.11+, src/ layout, pyproject.toml, pytest, ruff, type hints.
- Few dependencies: pydantic, numpy, pandas, pyyaml, typer, pytest.
- Tests pass before every commit. Small commits: feat:, fix:, test:, docs:, chore:.
- Money as integer cents in the decision layer, never float.

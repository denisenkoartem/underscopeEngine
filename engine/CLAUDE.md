# UnderScope: Vehicle Intelligence Platform

## What we are building
The routing engine for damaged vehicles. Given the reader's assessment of a seller's description
(`reader/src/contract.ts`) and the app's repair estimate, it says which marketplace to send the
car to, ACV or Copart, whether repairing first pays, and the net-proceeds range of every exit the
title allows.

Pipeline: assessment -> intake -> valuation -> simulation, with the router model deciding the
marketplace when both are allowed. `README.md` has the code map and the commands.

There is no ACV or Copart data here. Development uses made-up cars labelled by the simulation,
clearly marked as such.

## Hard rules
- Never push, change git remotes, or open PRs. Work stays on the local branch.
- Never scrape or call ACV, Copart, or any site whose terms forbid automated access.
- Never read, print, or commit secrets (.env, keys, tokens).
- Never delete or rewrite files you didn't create in this session, unless the user approves. If approval isn't given, skip that change, say so and move on
- Stay inside this repo. Use a project-local .venv; don't install anything globally.
- Never invent real-world market numbers. Every numeric assumption lives in
  config/assumptions.yaml labeled PLACEHOLDER with a note on what real data would replace it.
- If an action is denied, don't look for a workaround. Say so and move on.

## Conventions
- Python 3.11+, src/ layout, pyproject.toml, pytest, ruff, type hints.
- Few dependencies: pydantic, numpy, pyyaml, typer, pytest, and scikit-learn (approved 2026-11-16, only for the router model in `router.py`).
- Tests pass before every commit. Small commits: feat:, fix:, test:, docs:, chore:.
- Money as integer cents in the decision layer, never float.

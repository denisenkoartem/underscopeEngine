"""Machine-readable contracts: JSON Schemas for the two files that cross into the engine.

Generated from the pydantic models, written to contracts/, and checked by a test so the
published contracts can't drift from what the code accepts.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path as FsPath
from typing import Any

from underscope.assessment import Assessment
from underscope.config import ROOT

CONTRACTS_DIR = ROOT / "contracts"
DRAFT = "https://json-schema.org/draft/2020-12/schema"


def _titled(schema: dict[str, Any], title: str, description: str) -> dict[str, Any]:
    return {"$schema": DRAFT, **schema, "title": title, "description": description}


def _assessment() -> dict[str, Any]:
    return _titled(Assessment.model_json_schema(), "Assessment",
                   "Body of POST /api/route: the reader's JSON for one seller description "
                   "(mirror of reader/src/contract.ts) plus the app's repair estimate. Dollars, "
                   "not cents. Every key is optional; an unstated fact is \"unknown\", null or "
                   "an empty list, and keys the engine does not know are ignored.")  # fmt: skip


def _router_row() -> dict[str, Any]:
    from underscope.router import TrainingRow

    return _titled(TrainingRow.model_json_schema(), "Router training row",
                   "One line of the .jsonl file train-router --data reads: the reader's "
                   "Assessment for a car and what it netted on each marketplace, in dollars "
                   "after fees, transport and holding. source is \"recorded\" for a real car "
                   "and \"simulation\" for a made-up one labelled by the engine.")  # fmt: skip


SCHEMAS: dict[str, Callable[[], dict[str, Any]]] = {
    "assessment": _assessment,
    "router-training-row": _router_row,
}


def _text(schema: dict[str, Any]) -> str:
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def write(directory: str | FsPath = CONTRACTS_DIR) -> list[FsPath]:
    d = FsPath(directory)
    d.mkdir(parents=True, exist_ok=True)
    out = []
    for name, make in SCHEMAS.items():
        path = d / f"{name}.schema.json"
        path.write_text(_text(make()))
        out.append(path)
    return out


def stale(directory: str | FsPath = CONTRACTS_DIR) -> list[str]:
    """Contracts whose file is missing or no longer matches the code."""
    d = FsPath(directory)
    out = []
    for name, make in SCHEMAS.items():
        p = d / f"{name}.schema.json"
        if not p.is_file() or p.read_text() != _text(make()):
            out.append(name)
    return out

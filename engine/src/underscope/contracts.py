"""Machine-readable contracts: JSON Schemas for every file that crosses a stage boundary.

Generated from the code (pydantic models and the detector's answer schema), written to
docs/contracts/, and checked by a test so the published contracts can't drift from what the
code accepts and produces. docs/CONTRACTS.md explains the guarantees behind each one.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path as FsPath
from typing import Any

from pydantic import TypeAdapter

from underscope.data import ROOT
from underscope.models import DamageFinding, Recommendation, VehicleRecord
from underscope.review import ReviewRequest

CONTRACTS_DIR = ROOT / "docs" / "contracts"
DRAFT = "https://json-schema.org/draft/2020-12/schema"


def _titled(schema: dict[str, Any], title: str, description: str) -> dict[str, Any]:
    return {"$schema": DRAFT, **schema, "title": title, "description": description}


def _vehicle() -> dict[str, Any]:
    return _titled(VehicleRecord.model_json_schema(), "Vehicle",
                   "Input to evaluate and batch: one vehicle. Money in integer cents; photo "
                   "refs are paths relative to --photo-root.")  # fmt: skip


def _labels() -> dict[str, Any]:
    return _titled(TypeAdapter(dict[str, list[DamageFinding]]).json_schema(), "Labels",
                   "Photo ref -> damage findings in that photo. Used for ground truth "
                   "(detect-eval, calibrate), saved predictions, and the mock detector "
                   "(--labels).")  # fmt: skip


def _review() -> dict[str, Any]:
    return _titled(ReviewRequest.model_json_schema(), "Review request",
                   "The human-checker handoff, reviews/<VIN>.json. Written when a vehicle "
                   "needs confirmation (exit code 3); confirm sets status to "
                   "confirmed.")  # fmt: skip


def _recommendation() -> dict[str, Any]:
    schema = Recommendation.model_json_schema()
    schema["properties"]["findings_status"] = {
        "type": "string", "description": "Whether a human checker confirmed the findings.",
    }  # fmt: skip
    schema["required"] = [*schema.get("required", []), "findings_status"]
    return _titled(schema, "Recommendation",
                   "Output of evaluate --json (one object) and batch --out (one per line). "
                   "Options are ranked best first; all money is integer cents.")  # fmt: skip


def _detector_answer() -> dict[str, Any]:
    from underscope.vision import SCHEMA

    return _titled(SCHEMA, "Detector answer",
                   "What Claude must return for one photo (enforced as structured output). "
                   "Boxes are fractions of the photo: x0, y0 top-left to x1, y1 "
                   "bottom-right.")  # fmt: skip


def _calibration() -> dict[str, Any]:
    band = {
        "type": "object",
        "properties": {
            "low": {"type": "number"}, "high": {"type": "number"},
            "predictions": {"type": "integer", "minimum": 0},
            "matched": {"type": "integer", "minimum": 0},
            "calibrated": {"type": ["number", "null"], "minimum": 0, "maximum": 1,
                           "description": "null: too few predictions, confidence unchanged"},
        },
        "required": ["low", "high", "predictions", "matched", "calibrated"],
    }  # fmt: skip
    return _titled({
        "type": "object",
        "properties": {"by": {"enum": ["panel", "type"]},
                       "min_count": {"type": "integer", "minimum": 1},
                       "bins": {"type": "array", "items": band}},
        "required": ["by", "min_count", "bins"],
    }, "Calibration", "Written by calibrate, read by --calibration. Maps stated confidence "
       "bands to how often they were right.")  # fmt: skip


SCHEMAS: dict[str, Callable[[], dict[str, Any]]] = {
    "vehicle": _vehicle,
    "labels": _labels,
    "review-request": _review,
    "recommendation": _recommendation,
    "detector-answer": _detector_answer,
    "calibration": _calibration,
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

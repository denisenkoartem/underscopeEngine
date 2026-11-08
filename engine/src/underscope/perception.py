"""Perception layer: images -> damage findings."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Protocol

from underscope.models import DamageFinding, VehicleRecord


def merge_findings(findings: list[DamageFinding]) -> list[DamageFinding]:
    """One finding per (panel, side, damage type): the same damage seen in several photos
    counts once, at its worst severity and the most confident view. Order of first sighting
    is kept."""
    merged: dict[tuple, DamageFinding] = {}
    for f in findings:
        key = (f.panel, f.side, f.damage_type)
        prev = merged.get(key)
        if prev is None:
            merged[key] = f
            continue
        worst = f if f.severity > prev.severity else prev
        merged[key] = worst.model_copy(update={"confidence": max(f.confidence, prev.confidence)})
    return list(merged.values())


class DamageDetector(Protocol):
    def detect(self, vehicle: VehicleRecord) -> list[DamageFinding]: ...


class MockDetector:
    """Reads labels from a fixture file instead of looking at pixels.

    Labels file: JSON mapping photo ref -> list of finding dicts. Findings embedded in the
    vehicle record are included too.
    """

    def __init__(self, labels: dict[str, list[dict]] | None = None):
        self.labels = labels or {}

    @classmethod
    def from_file(cls, path: str | Path) -> MockDetector:
        return cls(json.loads(Path(path).read_text()))

    def detect(self, vehicle: VehicleRecord) -> list[DamageFinding]:
        found = list(vehicle.findings)
        for ref in vehicle.photo_refs:
            found.extend(
                DamageFinding(**{"photo_ref": ref, **f}) for f in self.labels.get(ref, [])
            )
        return found

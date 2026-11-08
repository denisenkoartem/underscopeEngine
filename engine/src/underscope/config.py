"""Loads config/assumptions.yaml. Values are PLACEHOLDERs, money is integer cents."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from underscope.models import DamageType, Panel, TitleStatus
from underscope.models import Path as DispPath

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "config" / "assumptions.yaml"
REQUIRED_SECTIONS = (
    "base_value", "repair_cost", "market", "fees", "transport", "timing", "title",
    "total_loss", "parts", "hidden_damage", "simulation",
)  # fmt: skip


class Assumptions:
    """Thin validated wrapper over the YAML dict."""

    def __init__(self, data: dict[str, Any]):
        for s in REQUIRED_SECTIONS:
            if s not in data:
                raise ValueError(f"assumptions missing section: {s}")
            if data[s].get("status") != "PLACEHOLDER":
                raise ValueError(f"section {s} must be labeled status: PLACEHOLDER")
            if "replace_with" not in data[s]:
                raise ValueError(f"section {s} needs a replace_with note")
        problems = _schema_problems(data)
        if problems:
            raise ValueError("invalid assumptions:\n  " + "\n  ".join(problems))
        self.data = data

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def total_loss_threshold_pct(self, region: str) -> float:
        tl = self.data["total_loss"]
        return float(tl["threshold_pct_by_region"].get(region, tl["default_threshold_pct"]))


# Tables that must have an entry for every value of an enum.
_COVERAGE = (
    (("repair_cost", "panel_base_cents"), Panel),
    (("repair_cost", "damage_type_multiplier"), DamageType),
    (("parts", "panel_share_of_parts_value"), Panel),
    (("parts", "damage_type_loss_factor"), DamageType),
    (("timing", "days_to_sell"), DispPath),
    (("title", "factor"), TitleStatus),
)


def _schema_problems(data: dict[str, Any]) -> list[str]:
    """Generic checks: [low, expected, high] ranges are ordered, *pct* values are 0-100,
    *cents* values are non-negative, and enum-keyed tables are complete."""
    out: list[str] = []

    def walk(node: Any, path: str, key: str) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                inherit = "pct" in key or "cents" in key
                walk(v, f"{path}.{k}" if path else str(k), key if inherit else str(k))
            return
        nums = node if isinstance(node, list) else [node]
        if not all(isinstance(x, int | float) and not isinstance(x, bool) for x in nums):
            return
        if isinstance(node, list) and len(node) == 3 and not node[0] <= node[1] <= node[2]:
            out.append(f"{path}: range must be [low, expected, high], got {node}")
        if "pct" in key and not all(0 <= x <= 100 for x in nums):
            out.append(f"{path}: percent must be 0-100, got {node}")
        if "cents" in key and any(x < 0 for x in nums):
            out.append(f"{path}: money must be non-negative, got {node}")

    walk(data, "", "")
    for (section, table), enum in _COVERAGE:
        missing = [e.value for e in enum if e.value not in data.get(section, {}).get(table, {})]
        if missing:
            out.append(f"{section}.{table}: missing {', '.join(missing)}")
    if data.get("simulation", {}).get("draws", 0) <= 0:
        out.append("simulation.draws: must be positive")
    return out


def load_assumptions(path: str | Path | None = None) -> Assumptions:
    return Assumptions(yaml.safe_load(Path(path or DEFAULT_PATH).read_text()))


@lru_cache(maxsize=1)
def default_assumptions() -> Assumptions:
    return load_assumptions()

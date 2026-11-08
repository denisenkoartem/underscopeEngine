"""Sensitivity of each fixture's recommendation to the key PLACEHOLDER assumptions.

Placeholders are not calibrated, so the honest question is not "what does the engine say"
but "which unknowns would change what it says". This sweeps each one and reports where the
winner flips. Writes reports/sensitivity.md.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path as FsPath

from underscope.config import Assumptions, default_assumptions
from underscope.data import FIXTURE_DIR, ROOT
from underscope.decision import evaluate
from underscope.models import Path, VehicleRecord
from underscope.perception import MockDetector

SCALES = (0.5, 0.75, 1.0, 1.25, 1.5)
PARAMS = (
    ("market", "as_is_discount_multiple_of_repair"),
    ("market", "repaired_value_haircut_pct_at_total_damage"),
    ("market", "salvage_fraction_of_clean"),
    ("timing", "holding_cost_per_day_cents"),
    ("hidden_damage", "reserve_pct_of_repair"),
    ("parts", "gross_value_fraction_of_clean"),
    ("parts", "sell_through"),
    ("fees", "acv"),
    ("fees", "copart"),
)
SHORT = {
    Path.REPAIR_THEN_ACV: "repair",
    Path.ACV_AS_IS: "as-is",
    Path.COPART_SALVAGE: "salvage",
    Path.PART_OUT: "parts",
}
FIXTURES = ("dent_600.json", "borderline_writeoff.json", "total_loss.json")


def _scale(value, k: float):
    if isinstance(value, dict):
        return {key: _scale(v, k) for key, v in value.items()}
    if isinstance(value, list):
        return [_scale(v, k) for v in value]
    return type(value)(round(value * k, 6)) if isinstance(value, float) else round(value * k)


def scaled(a: Assumptions, section: str, key: str, k: float) -> Assumptions:
    data = copy.deepcopy(a.data)
    data[section][key] = _scale(data[section][key], k)
    return Assumptions(data)


def _fixture(name: str) -> tuple[VehicleRecord, list]:
    v = VehicleRecord(**json.loads((FIXTURE_DIR / name).read_text()))
    return v, MockDetector().detect(v)


def sweep(a: Assumptions | None = None) -> dict[str, dict[str, list[Path]]]:
    """{fixture: {"section.key": [winner at each scale]}}"""
    a = a or default_assumptions()
    out: dict[str, dict[str, list[Path]]] = {}
    for name in FIXTURES:
        v, findings = _fixture(name)
        out[name] = {
            f"{s}.{k}": [evaluate(v, findings, scaled(a, s, k, x)).winner for x in SCALES]
            for s, k in PARAMS
        }
    return out


def breakeven_discount_multiple(
    vehicle: VehicleRecord, findings: list, a: Assumptions, hi: float = 6.0, iters: int = 14
) -> float | None:
    """Smallest as-is discount multiple of repair cost at which repair wins, or None."""

    def repair_wins(m: float) -> bool:
        data = copy.deepcopy(a.data)
        data["market"]["as_is_discount_multiple_of_repair"] = m
        return evaluate(vehicle, findings, Assumptions(data)).winner == Path.REPAIR_THEN_ACV

    if not repair_wins(hi):
        return None
    lo = 0.0
    if repair_wins(lo):
        return lo
    for _ in range(iters):
        mid = (lo + hi) / 2
        lo, hi = (lo, mid) if repair_wins(mid) else (mid, hi)
    return hi


def build(a: Assumptions | None = None) -> str:
    a = a or default_assumptions()
    res = sweep(a)
    head = "| Placeholder | " + " | ".join(f"{x:g}x" for x in SCALES) + " |"
    sep = "|---|" + "---|" * len(SCALES)
    lines = [
        "# Sensitivity to PLACEHOLDER assumptions",
        "",
        "Each row scales one placeholder (every number in it) and re-runs the fixture. Cells",
        "show the recommended path; **bold** marks a change from the 1x result. A row that",
        "changes means the recommendation depends on that unknown and real data should come",
        "first for it. Fixtures and values are synthetic.",
        "",
    ]
    for name in FIXTURES:
        lines += [f"## {name}", "", head, sep]
        for param, winners in res[name].items():
            base = winners[SCALES.index(1.0)]
            cells = [SHORT[w] if w == base else f"**{SHORT[w]}**" for w in winners]
            lines.append(f"| `{param}` | " + " | ".join(cells) + " |")
        v, findings = _fixture(name)
        m = breakeven_discount_multiple(v, findings, a)
        current = a["market"]["as_is_discount_multiple_of_repair"]
        be = (
            f"repair wins once buyers discount the as-is car by **{m:.2f}x** the repair cost "
            f"(placeholder: {current}x)."
            if m is not None
            else "repair does not win at any as-is discount multiple up to 6x."
        )
        lines += ["", f"Break-even: {be}", ""]
    lines.append("Regenerate with `.venv/bin/python -m underscope.sensitivity`.")
    return "\n".join(lines) + "\n"


def write(path: str | FsPath = ROOT / "reports" / "sensitivity.md") -> FsPath:
    p = FsPath(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(build())
    return p


if __name__ == "__main__":
    print(write())

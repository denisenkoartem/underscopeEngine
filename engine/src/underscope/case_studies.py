"""Generates reports/case_studies.md from the three fixture vehicles."""

from __future__ import annotations

import json
from pathlib import Path as FsPath

from underscope.cli import render
from underscope.data import FIXTURE_DIR, ROOT
from underscope.decision import evaluate
from underscope.models import VehicleRecord
from underscope.perception import MockDetector

CASES = [
    (
        "dent_600.json",
        "Case 1: the $600 dent",
        "Dealer persona (no insurance claim). A door dent on a clean-title car, repair estimate "
        "around $650.",
        "Selling as-is wins narrowly under the untuned placeholders. The accident-history "
        "haircut scales with damage, so a 3%-of-value dent carries almost none; what sinks "
        "repair is the extra holding time and the hidden-damage reserve. Repair wins once "
        "buyers discount the visible damage by about 2.4x the repair cost (placeholder 1.3x; "
        "see reports/sensitivity.md). That one number, measurable from ACV sale data, answers "
        "the dealer's question.",
    ),
    (
        "borderline_writeoff.json",
        "Case 2: a borderline write-off",
        "Adjuster persona (insurance claim). Frame crush plus a door dent; repair cost is 72% "
        "of clean value against the 75% NY total-loss threshold.",
        "The adjuster answer is 'borderline total loss': the expected repair is just under the "
        "threshold, but repair cost crosses it in about half the draws, so a firm repair "
        "estimate settles whether the car is totaled. It doesn't change the disposition: "
        "repair loses either way (it bears the hidden-damage reserve, haircut and holding), and "
        "parts vs as-is depends on the parts placeholders.",
    ),
    (
        "total_loss.json",
        "Case 3: an obvious total loss",
        "Adjuster persona (insurance claim). Severe frame, hood and bumper damage with "
        "undercarriage damage flagged.",
        "Repair costs about 90% of the clean value and loses money in nearly every draw. Once the "
        "insurer totals the car, an as-is buyer gets a salvage title, so as-is is worth about "
        "the salvage value. Part-out leads both, by an amount the parts placeholders could erase "
        "(halving gross parts value or sell-through hands it to as-is).",
    ),
]


def build() -> str:
    out = [
        "# Case studies",
        "",
        "All vehicles are fixtures (fake VINs, makes); all values use PLACEHOLDER assumptions "
        "from config/assumptions.yaml. These illustrate engine behavior, not market outcomes.",
        "",
    ]
    for fname, title, setup, takeaway in CASES:
        v = VehicleRecord(**json.loads((FIXTURE_DIR / fname).read_text()))
        rec = evaluate(v, MockDetector().detect(v))
        out += [
            f"## {title}",
            "",
            f"{setup} (`data/fixtures/{fname}`)",
            "",
            "```",
            render(v, rec),
            "```",
            "",
            f"**Takeaway:** {takeaway}",
            "",
        ]
    return "\n".join(out)


def write(path: str | FsPath = ROOT / "reports" / "case_studies.md") -> FsPath:
    p = FsPath(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(build())
    return p


if __name__ == "__main__":
    print(write())

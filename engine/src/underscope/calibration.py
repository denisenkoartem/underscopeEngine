"""Confidence calibration: make a detector's stated confidence mean what it says.

Fit on labeled photos: for each confidence band, how often predictions in that band matched
real damage. Rates are smoothed ((hits + 1) / (n + 2)), bands with too few predictions are
left alone, and rates are made non-decreasing so a higher stated confidence never maps lower.
Fit on one set of photos and evaluate on another; scoring on the fitting photos is circular.
"""

from __future__ import annotations

import json
import random
from pathlib import Path as FsPath
from typing import Any

from underscope.detector_eval import CONF_BINS, Findings, match, score


def fit(truth: Findings, pred: Findings, by: str = "panel", min_count: int = 20) -> dict[str, Any]:
    counts = [[0, 0] for _ in CONF_BINS]  # [predictions, matched]
    for ref, true_items in truth.items():
        pairs, _, false_alarms = match(true_items, pred.get(ref, []), by)
        for p, hit in [(p, 1) for _, p in pairs] + [(p, 0) for p in false_alarms]:
            i = next(i for i, (_, hi) in enumerate(CONF_BINS) if p.confidence <= hi)
            counts[i][0] += 1
            counts[i][1] += hit
    # Pool adjacent bands whose rates go down (weighted by count) so the map is monotone.
    blocks = [[n, hit, [i]] for i, (n, hit) in enumerate(counts) if n >= min_count]
    merged: list[list] = []
    for b in blocks:
        merged.append(b)
        while len(merged) > 1 and _rate(merged[-2]) > _rate(merged[-1]):
            last = merged.pop()
            merged[-1] = [merged[-1][0] + last[0], merged[-1][1] + last[1],
                          merged[-1][2] + last[2]]  # fmt: skip
    rates: dict[int, float] = {i: _rate(b) for b in merged for i in b[2]}
    return {
        "by": by,
        "min_count": min_count,
        "bins": [
            {"low": lo, "high": hi, "predictions": n, "matched": hit,
             "calibrated": round(rates[i], 4) if i in rates else None}
            for i, ((lo, hi), (n, hit)) in enumerate(zip(CONF_BINS, counts, strict=True))
        ],
    }  # fmt: skip


def _rate(block: list) -> float:
    n, hit = block[0], block[1]
    return (hit + 1) / (n + 2)


def apply(confidence: float, calibration: dict[str, Any] | None) -> float:
    """Calibrated confidence; unchanged when there's no table or the band had too little data."""
    if not calibration:
        return confidence
    for b in calibration["bins"]:
        if confidence <= b["high"]:
            return confidence if b["calibrated"] is None else b["calibrated"]
    return confidence


def split(refs: list[str], holdout: float, seed: int = 0) -> tuple[list[str], list[str]]:
    """Shuffle photo refs (seeded) into (fit, held-out); held-out gets round(holdout * n)."""
    if not 0 <= holdout < 1:
        raise ValueError("holdout must be at least 0 and below 1")
    refs = sorted(refs)
    random.Random(seed).shuffle(refs)
    n_out = round(holdout * len(refs))
    return sorted(refs[n_out:]), sorted(refs[:n_out])


def calibrated(pred: Findings, calibration: dict[str, Any] | None) -> Findings:
    return {ref: [f.model_copy(update={"confidence": apply(f.confidence, calibration)})
                  for f in items]
            for ref, items in pred.items()}  # fmt: skip


def holdout_check(
    truth: Findings, pred: Findings, calibration: dict[str, Any], by: str = "panel"
) -> tuple[float, float]:
    """Brier score (lower is better) on photos the table wasn't fitted on: (raw, calibrated)."""
    raw = score(truth, pred, by=by).brier
    return raw, score(truth, calibrated(pred, calibration), by=by).brier


def save(calibration: dict[str, Any], path: str | FsPath) -> FsPath:
    p = FsPath(path)
    p.write_text(json.dumps(calibration, indent=2))
    return p


def load(path: str | FsPath) -> dict[str, Any]:
    return json.loads(FsPath(path).read_text())


def render(calibration: dict[str, Any]) -> str:
    lines = ["| Stated confidence | Predictions | Matched | Calibrated to |", "|---|---|---|---|"]
    for b in calibration["bins"]:
        to = "unchanged (too few)" if b["calibrated"] is None else f"{b['calibrated']:.2f}"
        lines.append(f"| {b['low']:.1f}-{b['high']:.1f} | {b['predictions']} | {b['matched']} "
                     f"| {to} |")  # fmt: skip
    return "\n".join(lines)

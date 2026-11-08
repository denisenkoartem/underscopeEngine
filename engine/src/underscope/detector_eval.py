"""Score a DamageDetector against labeled photos.

Labels and predictions share MockDetector's format: {photo_ref: [finding, ...]}. Within each
photo, predictions are matched one-to-one to true findings on the same panel, preferring the
same damage type. Everything else is a miss (false negative) or a false alarm (false positive).

by="type" matches on damage type alone, for datasets whose damage photos carry no panel
labels; precision and recall then say nothing about panel placement.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path as FsPath

from underscope.models import DamageFinding, Panel

Findings = dict[str, list[DamageFinding]]
# Confidence bins for the calibration table: (low, high], with 0 in the first bin.
CONF_BINS = ((0.0, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 1.0))


def load_findings(path: str | FsPath) -> Findings:
    raw = json.loads(FsPath(path).read_text())
    return {ref: [DamageFinding(**f) for f in items] for ref, items in raw.items()}


def save_findings(findings: Findings, path: str | FsPath) -> FsPath:
    p = FsPath(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(
        {ref: [f.model_dump(mode="json", exclude={"verified"}) for f in items]
         for ref, items in findings.items()},
        indent=2,
    ))  # fmt: skip
    return p


def match(
    truth: list[DamageFinding], pred: list[DamageFinding], by: str = "panel"
) -> tuple[list[tuple[DamageFinding, DamageFinding]], list[DamageFinding], list[DamageFinding]]:
    """(matched (true, pred) pairs, missed true findings, false-alarm predictions)."""
    left = list(truth)
    pairs, false_alarms = [], []
    # Most confident predictions claim their match first.
    for p in sorted(pred, key=lambda f: -f.confidence):
        if by == "type":
            same_panel = [t for t in left if t.damage_type == p.damage_type]
        else:
            same_panel = [t for t in left if t.panel == p.panel]
        if not same_panel:
            false_alarms.append(p)
            continue
        # Prefer the same damage type, then the same side (when both sides are known).
        best = max(same_panel, key=lambda t: (
            t.damage_type == p.damage_type,
            t.side is not None and t.side == p.side,
        ))  # fmt: skip
        left.remove(best)
        pairs.append((best, p))
    return pairs, left, false_alarms


# A box overlapping the labeled one at least this much points the checker at the right spot.
# 0.5 is the usual object-detection bar; damage outlines are vague, so it's a lenient reading.
ON_TARGET_IOU = 0.5


def iou(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    """Intersection over union of two (left, top, right, bottom) boxes."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    inter = max(0.0, w) * max(0.0, h)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


@dataclass
class Score:
    photos: int = 0
    true_findings: int = 0
    predicted: int = 0
    matched: int = 0
    type_correct: int = 0
    severity_abs_error: float = 0.0
    brier_sum: float = 0.0
    by: str = "panel"
    frame_true: int = 0
    frame_missed: int = 0
    clean_photos: int = 0
    clean_correct: int = 0
    # Box overlap on matched findings where both label and prediction have a box.
    boxed: int = 0
    iou_sum: float = 0.0
    boxes_on_target: int = 0  # IoU of at least ON_TARGET_IOU
    errors: dict[str, str] = field(default_factory=dict)
    # per confidence bin: [predictions, of which matched]
    calibration: list[list[int]] = field(default_factory=lambda: [[0, 0] for _ in CONF_BINS])

    @property
    def precision(self) -> float:
        return self.matched / self.predicted if self.predicted else 1.0

    @property
    def recall(self) -> float:
        return self.matched / self.true_findings if self.true_findings else 1.0

    @property
    def f1(self) -> float:
        p, r = self.precision, self.recall
        return 2 * p * r / (p + r) if p + r else 0.0

    @property
    def type_accuracy(self) -> float:
        return self.type_correct / self.matched if self.matched else 0.0

    @property
    def severity_mae(self) -> float:
        return self.severity_abs_error / self.matched if self.matched else 0.0

    @property
    def mean_iou(self) -> float:
        return self.iou_sum / self.boxed if self.boxed else 0.0

    @property
    def brier(self) -> float:
        """Mean squared gap between confidence and whether the prediction matched (lower is
        better; 0.25 is what always answering 0.5 scores)."""
        return self.brier_sum / self.predicted if self.predicted else 0.0


def _bin(conf: float) -> int:
    return next(i for i, (_, hi) in enumerate(CONF_BINS) if conf <= hi)


def score(
    truth: Findings, pred: Findings, errors: dict[str, str] | None = None, by: str = "panel"
) -> Score:
    """Score predictions on every labeled photo. A photo with no prediction counts as 'no
    damage found' unless it is listed in errors, in which case it is left out."""
    if by not in ("panel", "type"):
        raise ValueError(f"by must be 'panel' or 'type', not {by!r}")
    s = Score(errors=dict(errors or {}), by=by)
    for ref, true_items in truth.items():
        if ref in s.errors:
            continue
        p_items = pred.get(ref, [])
        s.photos += 1
        s.true_findings += len(true_items)
        s.predicted += len(p_items)
        if not true_items:
            s.clean_photos += 1
            s.clean_correct += not p_items
        pairs, missed, false_alarms = match(true_items, p_items, by)
        s.matched += len(pairs)
        for t, p in pairs:
            s.type_correct += t.damage_type == p.damage_type
            s.severity_abs_error += abs(t.severity - p.severity)
            if t.box is not None and p.box is not None:
                overlap = iou(t.box, p.box)
                s.boxed += 1
                s.iou_sum += overlap
                s.boxes_on_target += overlap >= ON_TARGET_IOU
        for p, hit in [(p, 1) for _, p in pairs] + [(p, 0) for p in false_alarms]:
            s.brier_sum += (p.confidence - hit) ** 2
            s.calibration[_bin(p.confidence)][0] += 1
            s.calibration[_bin(p.confidence)][1] += hit
        s.frame_true += sum(t.panel == Panel.FRAME for t in true_items)
        s.frame_missed += sum(t.panel == Panel.FRAME for t in missed)
    return s


def run_detector(detector, photo_refs: list[str]) -> tuple[Findings, dict[str, str]]:
    """Run a detector photo by photo. A failure on one photo is recorded, not fatal."""
    pred: Findings = {}
    errors: dict[str, str] = {}
    for ref in photo_refs:
        try:
            pred[ref] = detector.detect_photo(ref)
        except Exception as err:  # noqa: BLE001 - one bad photo shouldn't stop the run
            errors[ref] = str(err)
    return pred, errors


def render_report(s: Score, title: str = "Damage detector evaluation") -> str:
    lines = [
        f"# {title}",
        "",
        f"Photos scored: {s.photos} ({len(s.errors)} failed and left out). "
        f"True findings: {s.true_findings}. Predicted: {s.predicted}.",
        "",
        *(["Findings matched on damage type only (labels have no panels); precision and "
           "recall don't measure panel placement, and frame misses aren't meaningful.", ""]
          if s.by == "type" else []),
        "| Metric | Value |",
        "|---|---|",
        f"| Panel precision (predictions that match real damage) | {s.precision:.1%} |",
        f"| Panel recall (real damage found) | {s.recall:.1%} |",
        f"| Panel F1 | {s.f1:.1%} |",
        f"| Damage type correct, on matched findings | {s.type_accuracy:.1%} |",
        f"| Severity mean absolute error, on matched findings | {s.severity_mae:.2f} |",
        f"| Confidence Brier score (lower is better) | {s.brier:.3f} |",
        f"| Frame damage missed | {s.frame_missed} of {s.frame_true} |",
        f"| Clean photos with no false alarm | {s.clean_correct} of {s.clean_photos} |",
        *([f"| Box overlap with the label (mean IoU), {s.boxed} boxed matches | "
           f"{s.mean_iou:.2f} |",
           f"| Boxes on target (IoU {ON_TARGET_IOU:.1f} or more) | "
           f"{s.boxes_on_target} of {s.boxed} |"] if s.boxed else []),
        "",
        "## Calibration",
        "",
        "Is a finding stated with 80% confidence right about 80% of the time?",
        "",
        "| Stated confidence | Predictions | Actually matched |",
        "|---|---|---|",
    ]
    for (lo, hi), (n, hit) in zip(CONF_BINS, s.calibration, strict=True):
        rate = f"{hit / n:.0%}" if n else "-"
        lines.append(f"| {lo:.1f}-{hi:.1f} | {n} | {rate} |")
    if s.errors:
        lines += ["", "## Failed photos", ""]
        lines += [f"- `{ref}`: {msg}" for ref, msg in sorted(s.errors.items())]
    return "\n".join(lines) + "\n"

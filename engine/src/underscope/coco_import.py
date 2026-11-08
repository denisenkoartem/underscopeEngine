"""Convert COCO-format damage annotations into detect-eval labels.

A mapping file (YAML) says what each COCO category means:

    damage:            # category name -> our damage type (null = ignore)
      Dent: dent
    parts:             # category name -> our panel and side (null = ignore)
      Front-door: {panel: door}
      back_left_fender: {panel: fender, side: left}
    default_panel: door      # used when an image has no usable part annotations
    default_severity: 0.5    # used when there is no part to measure against

Each damage annotation goes to the part whose box covers most of it. Severity is then the
share of that part's area the damage covers (capped at 1), a geometric stand-in, not a repair
estimate. Without part annotations the defaults apply, and only `--match-by type` scoring is
meaningful.
"""

from __future__ import annotations

import json
from pathlib import Path as FsPath
from typing import Any

import yaml

from underscope.detector_eval import Findings
from underscope.models import DamageFinding, DamageType, Panel


def _box(a: dict) -> tuple[float, float, float, float]:
    x, y, w, h = a["bbox"]
    return x, y, x + w, y + h


def _overlap(a: tuple, b: tuple) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return max(0.0, w) * max(0.0, h)


def _area(a: dict) -> float:
    return float(a.get("area") or a["bbox"][2] * a["bbox"][3])


def _fraction_box(a: dict, img: dict) -> tuple[float, float, float, float] | None:
    """The annotation's box as fractions of the image, when the image size is known."""
    w, h = img.get("width"), img.get("height")
    if not w or not h:
        return None
    x0, y0, x1, y1 = _box(a)
    box = (max(0.0, x0 / w), max(0.0, y0 / h), min(1.0, x1 / w), min(1.0, y1 / h))
    return box if box[0] < box[2] and box[1] < box[3] else None


def load_mapping(path: str | FsPath) -> dict[str, Any]:
    m = yaml.safe_load(FsPath(path).read_text()) or {}
    for value in (m.get("damage") or {}).values():
        if value is not None:
            DamageType(value)  # fail early on a typo
    for value in (m.get("parts") or {}).values():
        if value is not None:
            Panel(value["panel"])
    if m.get("default_panel") is not None:
        Panel(m["default_panel"])
    return m


def convert(coco: dict[str, Any], mapping: dict[str, Any]) -> tuple[Findings, dict[str, int]]:
    """Returns (labels keyed by image file_name, counts of what was used and skipped)."""
    names = {c["id"]: c["name"] for c in coco.get("categories", [])}
    damage_map = mapping.get("damage") or {}
    part_map = mapping.get("parts") or {}
    default_panel = mapping.get("default_panel")
    default_severity = float(mapping.get("default_severity", 0.5))
    by_image: dict[int, list[dict]] = {}
    for a in coco.get("annotations", []):
        by_image.setdefault(a["image_id"], []).append(a)

    counts = {"images": 0, "damage": 0, "ignored": 0, "unknown_category": 0,
              "on_part": 0, "default_panel": 0, "no_panel": 0}  # fmt: skip
    labels: Findings = {}
    for img in coco.get("images", []):
        counts["images"] += 1
        anns = by_image.get(img["id"], [])
        parts = [a for a in anns if part_map.get(names.get(a["category_id"])) is not None]
        found: list[DamageFinding] = []
        for a in anns:
            name = names.get(a["category_id"])
            if name not in damage_map and name not in part_map:
                counts["unknown_category"] += 1
                continue
            if name not in damage_map:
                continue  # a part annotation
            damage_type = damage_map[name]
            if damage_type is None:
                counts["ignored"] += 1
                continue
            box = _box(a)
            best = max(parts, key=lambda p: _overlap(box, _box(p)), default=None)
            if best is not None and _overlap(box, _box(best)) > 0:
                part = part_map[names[best["category_id"]]]
                panel, side = part["panel"], part.get("side")
                severity = min(1.0, _area(a) / max(_area(best), 1.0))
                counts["on_part"] += 1
            elif default_panel is not None:
                panel, side, severity = default_panel, None, default_severity
                counts["default_panel"] += 1
            else:
                counts["no_panel"] += 1
                continue
            found.append(DamageFinding(
                panel=panel, damage_type=damage_type, side=side, confidence=1.0,
                severity=round(severity, 3), photo_ref=img["file_name"],
                box=_fraction_box(a, img),
            ))  # fmt: skip
            counts["damage"] += 1
        labels[img["file_name"]] = found
    return labels, counts


def convert_file(annotations: str | FsPath, mapping: str | FsPath):
    return convert(json.loads(FsPath(annotations).read_text()), load_mapping(mapping))

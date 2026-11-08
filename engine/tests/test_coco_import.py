import json

import pytest
import yaml
from typer.testing import CliRunner

from underscope.cli import app
from underscope.coco_import import convert, load_mapping
from underscope.config import DEFAULT_PATH

MAPPING = {
    "damage": {"Dent": "dent", "Corrosion": None},
    "parts": {"back_left_door": {"panel": "door", "side": "left"}, "Mirror": None},
    "default_panel": "hood",
    "default_severity": 0.5,
}
COCO = {
    "categories": [{"id": 1, "name": "Dent"}, {"id": 2, "name": "back_left_door"},
                   {"id": 3, "name": "Corrosion"}, {"id": 4, "name": "Sticker"}],
    "images": [{"id": 10, "file_name": "a.jpg"}, {"id": 11, "file_name": "b.jpg"},
               {"id": 12, "file_name": "clean.jpg"}],
    "annotations": [
        {"image_id": 10, "category_id": 2, "bbox": [0, 0, 100, 100], "area": 10000},
        {"image_id": 10, "category_id": 1, "bbox": [10, 10, 50, 40], "area": 2000},
        {"image_id": 10, "category_id": 3, "bbox": [0, 0, 5, 5], "area": 25},
        {"image_id": 11, "category_id": 1, "bbox": [0, 0, 10, 10], "area": 100},
        {"image_id": 11, "category_id": 4, "bbox": [0, 0, 10, 10], "area": 100},
    ],
}  # fmt: skip


def test_damage_lands_on_overlapping_part_with_area_severity():
    labels, counts = convert(COCO, MAPPING)
    (a,) = labels["a.jpg"]
    assert (a.panel.value, a.side, a.damage_type.value, a.severity) == ("door", "left", "dent", 0.2)
    (b,) = labels["b.jpg"]
    assert (b.panel.value, b.side, b.severity) == ("hood", None, 0.5)
    assert labels["clean.jpg"] == []
    assert counts == {"images": 3, "damage": 2, "ignored": 1, "unknown_category": 1,
                      "on_part": 1, "default_panel": 1, "no_panel": 0}  # fmt: skip


def test_no_default_panel_drops_unplaced_damage():
    labels, counts = convert(COCO, {**MAPPING, "default_panel": None})
    assert labels["b.jpg"] == [] and counts["no_panel"] == 1


def test_mapping_typos_fail_early(tmp_path):
    p = tmp_path / "m.yaml"
    p.write_text(yaml.safe_dump({**MAPPING, "damage": {"Dent": "dnet"}}))
    with pytest.raises(ValueError):
        load_mapping(p)


def test_shipped_humans_in_the_loop_mapping_is_valid():
    m = load_mapping(DEFAULT_PATH.parent / "coco_mapping.humans_in_the_loop.yaml")
    assert m["damage"]["Cracked"] == "crack" and m["parts"]["Mirror"] is None


def test_cli_import_then_score(tmp_path):
    ann, mp, out = tmp_path / "ann.json", tmp_path / "m.yaml", tmp_path / "labels.json"
    ann.write_text(json.dumps(COCO))
    mp.write_text(yaml.safe_dump(MAPPING))
    r = CliRunner().invoke(app, ["import-coco", str(ann), "--mapping", str(mp), "--out", str(out)])
    assert r.exit_code == 0, r.output
    assert "2 damage labels" in r.output and "categories not in the mapping: 1" in r.output
    r = CliRunner().invoke(app, ["detect-eval", str(out), "--detector", "mock"])
    assert r.exit_code == 0 and "| Panel F1 | 100.0% |" in r.output


def test_boxes_become_photo_fractions_when_image_size_is_known():
    coco = {**COCO, "images": [{"id": 10, "file_name": "a.jpg", "width": 200, "height": 100},
                               {"id": 11, "file_name": "b.jpg"}]}  # fmt: skip
    labels, _ = convert(coco, MAPPING)
    assert labels["a.jpg"][0].box == (0.05, 0.1, 0.3, 0.5)
    assert labels["b.jpg"][0].box is None  # no size, no box

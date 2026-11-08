import json

import pytest
from typer.testing import CliRunner

from underscope import labeling
from underscope.cli import app

runner = CliRunner()


def test_apply_commands():
    found = []
    assert labeling.apply(found, "+ door left dent 0.4", "a.jpg")[0] == "edit"
    assert labeling.apply(found, "+ hood - scratch 0.1", "a.jpg")[0] == "edit"
    assert [(f.side, f.confidence, f.photo_ref) for f in found] == [
        ("left", 1.0, "a.jpg"), (None, 1.0, "a.jpg")]
    assert labeling.apply(found, "- 1", "a.jpg")[0] == "edit" and len(found) == 1
    assert [labeling.apply(found, c, "a.jpg")[0] for c in ("n", "s", "q", "?")] == [
        "next", "skip", "quit", "help"]
    for bad in ("+ wing left dent 0.4", "+ door left dent 1.5", "- 9", "+ door up dent 0.2"):
        with pytest.raises(ValueError):
            labeling.apply(found, bad, "a.jpg")


def test_label_session_saves_each_photo_and_resumes(tmp_path):
    photos = tmp_path / "photos"
    photos.mkdir()
    for name in ("a.jpg", "b.png", "c.webp", "notes.txt"):
        (photos / name).write_bytes(b"x")
    labels = tmp_path / "labels.json"
    keys = "+ door left dent 0.4\nn\nn\nq\n"
    r = runner.invoke(app, ["label", str(photos), "--labels", str(labels)], input=keys)
    assert r.exit_code == 0, r.output
    saved = json.loads(labels.read_text())
    assert list(saved) == ["a.jpg", "b.png"] and saved["b.png"] == []
    assert saved["a.jpg"][0]["side"] == "left"
    r = runner.invoke(app, ["label", str(photos), "--labels", str(labels)], input="n\n")
    assert "2 labeled, 1 to go" in r.output
    assert list(json.loads(labels.read_text())) == ["a.jpg", "b.png", "c.webp"]


def test_prefill_starts_from_predictions(tmp_path):
    photos = tmp_path / "photos"
    photos.mkdir()
    (photos / "a.jpg").write_bytes(b"x")
    pred = tmp_path / "pred.json"
    pred.write_text(json.dumps({"a.jpg": [{"panel": "hood", "damage_type": "scratch",
                                           "severity": 0.2, "confidence": 0.6}]}))
    labels = tmp_path / "labels.json"
    r = runner.invoke(app, ["label", str(photos), "--labels", str(labels), "--prefill",
                            str(pred)], input="n\n")  # fmt: skip
    assert r.exit_code == 0, r.output
    assert json.loads(labels.read_text())["a.jpg"][0]["confidence"] == 1.0

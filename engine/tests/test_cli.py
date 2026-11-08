import json

from typer.testing import CliRunner

from underscope.cli import AWAITING_CONFIRMATION, app
from underscope.data import FIXTURE_DIR

runner = CliRunner()
DENT = str(FIXTURE_DIR / "dent_600.json")
TOTAL = str(FIXTURE_DIR / "total_loss.json")


def test_text_output_with_skip_confirm():
    r = runner.invoke(app, ["evaluate", DENT, "--skip-confirm"])
    assert r.exit_code == 0, r.output
    assert "RECOMMENDATION" in r.output and "PLACEHOLDER" in r.output
    assert "NOT confirmed" in r.output


def test_json_output_with_skip_confirm():
    r = runner.invoke(app, ["evaluate", TOTAL, "--json", "--skip-confirm"])
    assert r.exit_code == 0
    out = json.loads(r.stdout)
    assert out["winner"] in {"repair_then_acv", "acv_as_is", "copart_salvage", "part_out"}
    assert "NOT confirmed" in out["findings_status"]


def test_every_vehicle_waits_for_checker_by_default(tmp_path):
    r = runner.invoke(app, ["evaluate", DENT, "--no-interactive", "--review-dir", str(tmp_path)])
    assert r.exit_code == AWAITING_CONFIRMATION
    assert "RECOMMENDATION" not in r.output
    assert (tmp_path / "FIXDENT0000000001.json").exists()
    html = (tmp_path / "FIXDENT0000000001.html").read_text()
    assert "door" in html and "Awaiting checker confirmation" in html


def test_file_handoff_confirm_then_proceed(tmp_path):
    runner.invoke(app, ["evaluate", TOTAL, "--no-interactive", "--review-dir", str(tmp_path)])
    req = tmp_path / "FIXTOTAL000000001.json"
    # Not confirmed yet: resuming is refused.
    r = runner.invoke(app, ["evaluate", TOTAL, "--confirmed", str(req)])
    assert r.exit_code == AWAITING_CONFIRMATION
    r = runner.invoke(app, ["confirm", str(req), "--checker", "admin",
                            "--remove", "3", "--add", "roof:dent:0.4"])  # fmt: skip
    assert r.exit_code == 0, r.output
    saved = json.loads(req.read_text())
    assert saved["status"] == "confirmed" and saved["checker"] == "admin"
    assert [f["panel"] for f in saved["findings"]] == ["frame", "hood", "roof"]
    assert all(f["verified"] for f in saved["findings"])
    r = runner.invoke(app, ["evaluate", TOTAL, "--confirmed", str(req)])
    assert r.exit_code == 0, r.output
    assert "RECOMMENDATION" in r.output and "confirmed by admin" in r.output


def test_confirmed_review_must_match_vehicle(tmp_path):
    runner.invoke(app, ["evaluate", TOTAL, "--no-interactive", "--review-dir", str(tmp_path)])
    req = tmp_path / "FIXTOTAL000000001.json"
    runner.invoke(app, ["confirm", str(req), "--checker", "admin"])
    r = runner.invoke(app, ["evaluate", DENT, "--confirmed", str(req)])
    assert r.exit_code != 0


def test_interactive_checker_adds_missed_damage(tmp_path):
    keys = "+ frame dent 0.8\nu no\ne no\na\nPat\n"
    r = runner.invoke(
        app, ["evaluate", DENT, "--interactive", "--review-dir", str(tmp_path)], input=keys
    )
    assert r.exit_code == 0, r.output
    assert "confirmed by Pat" in r.output
    saved = json.loads((tmp_path / "FIXDENT0000000001.json").read_text())
    assert {f["panel"] for f in saved["findings"]} == {"door", "frame"}


def test_interactive_quit_leaves_pending(tmp_path):
    r = runner.invoke(
        app, ["evaluate", DENT, "--interactive", "--review-dir", str(tmp_path)], input="q\n"
    )
    assert r.exit_code == AWAITING_CONFIRMATION
    assert json.loads((tmp_path / "FIXDENT0000000001.json").read_text())["status"] == "pending"


def test_risky_mode_skips_quiet_vehicles(tmp_path):
    # The dent fixture has confident findings, complete inspection flags and no frame damage.
    r = runner.invoke(app, ["evaluate", DENT, "--review-mode", "risky", "--no-interactive",
                            "--review-dir", str(tmp_path)])  # fmt: skip
    assert r.exit_code == 0, r.output
    assert "no risk signals" in r.output
    # The total loss has frame damage and an undercarriage flag: still goes to a checker.
    r = runner.invoke(app, ["evaluate", TOTAL, "--review-mode", "risky", "--no-interactive",
                            "--review-dir", str(tmp_path)])  # fmt: skip
    assert r.exit_code == AWAITING_CONFIRMATION


def test_batch_queues_then_decides_confirmed(tmp_path):
    reviews, out = tmp_path / "reviews", tmp_path / "out.jsonl"
    args = ["batch", str(FIXTURE_DIR), "--review-dir", str(reviews), "--out", str(out)]
    r = runner.invoke(app, args)
    assert r.exit_code == AWAITING_CONFIRMATION
    assert "0 decided, 3 awaiting" in r.output
    assert (reviews / "index.html").exists()
    runner.invoke(app, ["confirm", str(reviews / "FIXTOTAL000000001.json"), "--checker", "Lee"])
    r = runner.invoke(app, args)
    assert "1 decided, 2 awaiting" in r.output
    rows = [json.loads(line) for line in out.read_text().splitlines()]
    assert [x["vin"] for x in rows] == ["FIXTOTAL000000001"]
    assert rows[0]["findings_status"] == "confirmed by Lee"


def test_batch_risky_mode_decides_quiet_vehicles(tmp_path):
    r = runner.invoke(app, ["batch", str(FIXTURE_DIR), "--review-mode", "risky",
                            "--review-dir", str(tmp_path)])  # fmt: skip
    assert "FIXDENT0000000001" in r.output and "no risk signals" in r.output
    assert r.exit_code == AWAITING_CONFIRMATION  # the two adjuster cases still need a checker


def test_queue_lists_pending_first_and_links_sheets(tmp_path):
    runner.invoke(app, ["batch", str(FIXTURE_DIR), "--review-dir", str(tmp_path)])
    runner.invoke(app, ["confirm", str(tmp_path / "FIXBORDER00000001.json"), "--checker", "Lee"])
    r = runner.invoke(app, ["queue", "--review-dir", str(tmp_path)])
    assert r.exit_code == 0, r.output
    assert "2 pending, 1 confirmed" in r.output
    lines = [x for x in r.output.splitlines() if x.startswith("FIX")]
    assert lines[-1].startswith("FIXBORDER00000001")  # confirmed sorts last
    page = (tmp_path / "index.html").read_text()
    assert 'href="FIXDENT0000000001.html"' in page and "Lee at" in page


def test_queue_with_no_reviews(tmp_path):
    r = runner.invoke(app, ["queue", "--review-dir", str(tmp_path / "none")])
    assert r.exit_code == 0 and "No reviews." in r.output


def test_confirmed_review_refused_when_vehicle_changed(tmp_path):
    runner.invoke(app, ["evaluate", DENT, "--no-interactive", "--review-dir", str(tmp_path)])
    req = tmp_path / "FIXDENT0000000001.json"
    runner.invoke(app, ["confirm", str(req), "--checker", "admin"])
    changed = json.loads((FIXTURE_DIR / "dent_600.json").read_text())
    changed["mileage"] += 1000
    vfile = tmp_path / "dent_changed.json"
    vfile.write_text(json.dumps(changed))
    r = runner.invoke(app, ["evaluate", str(vfile), "--confirmed", str(req)])
    assert r.exit_code == AWAITING_CONFIRMATION
    assert "changed since" in r.output


def test_batch_rereviews_changed_vehicle_and_skips_bad_files(tmp_path):
    vehicles, reviews = tmp_path / "v", tmp_path / "r"
    vehicles.mkdir()
    dent = json.loads((FIXTURE_DIR / "dent_600.json").read_text())
    (vehicles / "dent.json").write_text(json.dumps(dent))
    (vehicles / "broken.json").write_text('{"vin": "X"}')
    args = ["batch", str(vehicles), "--review-dir", str(reviews)]
    runner.invoke(app, args)
    runner.invoke(app, ["confirm", str(reviews / "FIXDENT0000000001.json"), "--checker", "Lee"])
    r = runner.invoke(app, args)
    assert "1 decided" in r.output and "broken.json" in r.output and "invalid" in r.output
    dent["mileage"] += 5000
    (vehicles / "dent.json").write_text(json.dumps(dent))
    r = runner.invoke(app, args)
    assert "0 decided, 1 awaiting" in r.output
    assert json.loads((reviews / "FIXDENT0000000001.json").read_text())["status"] == "pending"


def test_evaluate_reports_invalid_vehicle_cleanly(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"vin": "X"}')
    r = runner.invoke(app, ["evaluate", str(bad), "--skip-confirm"])
    assert r.exit_code == 2 and "invalid" in r.output and "Traceback" not in r.output


def _labels(tmp_path):
    labels = {"a.jpg": [{"panel": "door", "damage_type": "dent", "severity": 0.4,
                         "confidence": 1.0}], "b.jpg": []}  # fmt: skip
    path = tmp_path / "labels.json"
    path.write_text(json.dumps(labels))
    return path


def test_detect_eval_mock_scores_perfectly(tmp_path):
    r = runner.invoke(app, ["detect-eval", str(_labels(tmp_path)), "--detector", "mock"])
    assert r.exit_code == 0, r.output
    assert "Panel recall (real damage found) | 100.0%" in r.output


def test_detect_eval_claude_needs_yes_and_shows_estimate(tmp_path):
    r = runner.invoke(app, ["detect-eval", str(_labels(tmp_path)), "--detector", "claude"])
    assert r.exit_code == 1
    assert "2 photos" in r.output and "$" in r.output and "--yes" in r.output


def test_detect_eval_scores_saved_predictions(tmp_path):
    pred = tmp_path / "pred.json"
    pred.write_text(json.dumps({"a.jpg": [], "b.jpg": []}))
    report = tmp_path / "r.md"
    r = runner.invoke(app, ["detect-eval", str(_labels(tmp_path)), "--predictions", str(pred),
                            "--report", str(report)])  # fmt: skip
    assert r.exit_code == 0 and "Panel recall (real damage found) | 0.0%" in report.read_text()


def _fake_claude(monkeypatch, *replies):
    import underscope.vision as vision
    from test_vision import FakeClient

    client = FakeClient(*replies)
    real = vision.ClaudeVisionDetector
    monkeypatch.setattr(vision, "ClaudeVisionDetector",
                        lambda root, **kw: real(root, client=client, **kw))  # fmt: skip
    return client


def test_evaluate_with_claude_detector_sends_unmapped_damage_to_checker(tmp_path, monkeypatch):
    from test_vision import PNG, reply

    (tmp_path / "door.jpg").write_bytes(PNG)
    vfile = tmp_path / "car.json"
    car = json.loads((FIXTURE_DIR / "dent_600.json").read_text())
    vfile.write_text(json.dumps({**car, "findings": [], "photo_refs": ["door.jpg"]}))
    client = _fake_claude(monkeypatch, reply({
        "findings": [{"panel": "door", "damage_type": "dent", "severity": 0.5,
                      "confidence": 0.9}],
        "unmapped_damage": ["cracked left mirror"]}))  # fmt: skip
    r = runner.invoke(app, ["evaluate", str(vfile), "--detector", "claude", "--yes", "--photo-root",
                            str(tmp_path), "--no-interactive", "--review-dir",
                            str(tmp_path / "rev")])  # fmt: skip
    assert r.exit_code == AWAITING_CONFIRMATION, r.output
    assert len(client.calls) == 1
    saved = json.loads((tmp_path / "rev" / "FIXDENT0000000001.json").read_text())
    assert saved["findings"][0]["photo_ref"] == "door.jpg"
    assert any("cracked left mirror" in x for x in saved["reasons"])


def test_evaluate_reports_detection_failure_cleanly(tmp_path, monkeypatch):
    from test_vision import PNG, reply

    (tmp_path / "door.jpg").write_bytes(PNG)
    vfile = tmp_path / "car.json"
    car = json.loads((FIXTURE_DIR / "dent_600.json").read_text())
    vfile.write_text(json.dumps({**car, "photo_refs": ["door.jpg"]}))
    _fake_claude(monkeypatch, reply({"findings": []}, stop="refusal"))
    r = runner.invoke(app, ["evaluate", str(vfile), "--detector", "claude", "--yes", "--photo-root",
                            str(tmp_path), "--skip-confirm"])  # fmt: skip
    assert r.exit_code == 2 and "Damage detection failed" in r.output


def test_detect_eval_batch_submit_then_collect(tmp_path, monkeypatch):
    import underscope.vision as vision
    from test_vision import PNG, batch_client, ok

    (tmp_path / "a.jpg").write_bytes(PNG)
    (tmp_path / "b.jpg").write_bytes(PNG)
    client = batch_client([ok("p0", {"findings": [
        {"panel": "door", "damage_type": "dent", "severity": 0.4, "confidence": 0.9,
         "side": "left"}], "unmapped_damage": []}), ok("p1", {"findings": [],
         "unmapped_damage": []})])  # fmt: skip
    real = vision.ClaudeVisionDetector
    monkeypatch.setattr(vision, "ClaudeVisionDetector",
                        lambda root, **kw: real(root, client=client, **kw))  # fmt: skip
    labels, state = _labels(tmp_path), tmp_path / "state.json"
    base = ["detect-eval", str(labels), "--photo-root", str(tmp_path)]
    r = runner.invoke(app, [*base, "--batch"])
    assert r.exit_code == 1 and "half price" in r.output
    r = runner.invoke(app, [*base, "--batch", "--yes", "--batch-state", str(state)])
    assert r.exit_code == 0, r.output
    assert json.loads(state.read_text())["batch_id"] == "msgbatch_1"
    pred = tmp_path / "pred.json"
    r = runner.invoke(app, [*base, "--collect", str(state), "--save", str(pred)])
    assert r.exit_code == 0, r.output
    assert "| Panel F1 | 100.0% |" in r.output and "API cost" in r.output
    assert json.loads(pred.read_text())["a.jpg"][0]["side"] == "left"
    client.messages.batches.status = "in_progress"
    r = runner.invoke(app, [*base, "--collect", str(state)])
    assert r.exit_code == AWAITING_CONFIRMATION and "still in_progress" in r.output


def test_claude_views_reach_the_review_sheet(tmp_path, monkeypatch):
    from test_vision import PNG, reply

    (tmp_path / "left.jpg").write_bytes(PNG)
    vfile = tmp_path / "car.json"
    car = json.loads((FIXTURE_DIR / "dent_600.json").read_text())
    vfile.write_text(json.dumps({**car, "findings": [], "photo_refs": ["left.jpg"]}))
    _fake_claude(monkeypatch, reply({"view": "left", "findings": [], "unmapped_damage": []}))
    rev = tmp_path / "rev"
    r = runner.invoke(app, ["evaluate", str(vfile), "--detector", "claude", "--yes", "--photo-root",
                            str(tmp_path), "--no-interactive",
                            "--review-dir", str(rev)])  # fmt: skip
    assert r.exit_code == AWAITING_CONFIRMATION, r.output
    saved = json.loads((rev / "FIXDENT0000000001.json").read_text())
    assert saved["photo_views"] == {"left.jpg": "left"}
    assert any("Photos don't show: front, rear, right side, roof" in x for x in saved["reasons"])
    assert "not photographed" in r.output


def test_confirm_add_accepts_side(tmp_path):
    runner.invoke(app, ["evaluate", DENT, "--no-interactive", "--review-dir", str(tmp_path)])
    req = tmp_path / "FIXDENT0000000001.json"
    r = runner.invoke(app, ["confirm", str(req), "--checker", "a",
                            "--add", "quarter_panel:dent:0.3:right"])  # fmt: skip
    assert r.exit_code == 0, r.output
    assert json.loads(req.read_text())["findings"][-1]["side"] == "right"
    r = runner.invoke(app, ["confirm", str(req), "--checker", "a", "--add", "door:dent:0.3:x:y"])
    assert r.exit_code != 0


def test_calibrate_with_holdout(tmp_path):
    from underscope.detector_eval import save_findings
    from underscope.models import DamageFinding

    def dent(panel):
        return DamageFinding(panel=panel, damage_type="dent", severity=0.4, confidence=0.95)

    truth = {f"p{i}": [dent("door")] for i in range(80)}
    pred = {f"p{i}": [dent("door" if i % 2 else "roof")] for i in range(80)}
    save_findings(truth, tmp_path / "labels.json")
    save_findings(pred, tmp_path / "pred.json")
    out = tmp_path / "cal.json"
    result = runner.invoke(app, ["calibrate", str(tmp_path / "labels.json"),
                                 str(tmp_path / "pred.json"), "--out", str(out),
                                 "--holdout", "0.25"])  # fmt: skip
    assert result.exit_code == 0, result.output
    assert "checked on 20 held-out photos" in result.output
    assert "Calibration helps" in result.output
    assert out.exists()


def test_batch_with_claude_detector_needs_yes(tmp_path):
    result = runner.invoke(app, ["batch", str(FIXTURE_DIR), "--detector", "claude",
                                 "--review-dir", str(tmp_path)])  # fmt: skip
    assert result.exit_code == 1
    assert "photos to claude-opus-5-5, roughly $" in result.output and "--yes" in result.output
    assert not list(tmp_path.iterdir())  # nothing ran


def test_batch_with_claude_keeps_confirmed_review_on_rerun(tmp_path, monkeypatch):
    """Re-running batch must not re-ask Claude (cost) or void the checker's review."""
    from test_vision import PNG, reply

    cars = tmp_path / "cars"
    cars.mkdir()
    (tmp_path / "door.jpg").write_bytes(PNG)
    car = json.loads((FIXTURE_DIR / "dent_600.json").read_text())
    (cars / "car.json").write_text(json.dumps({**car, "findings": [], "photo_refs": ["door.jpg"]}))
    client = _fake_claude(monkeypatch, reply({"findings": [
        {"panel": "door", "damage_type": "dent", "severity": 0.5, "confidence": 0.9,
         "side": "left"}], "unmapped_damage": [], "view": "left"}))  # fmt: skip
    rev = tmp_path / "rev"
    args = ["batch", str(cars), "--detector", "claude", "--photo-root", str(tmp_path),
            "--review-dir", str(rev)]  # fmt: skip
    assert runner.invoke(app, args).exit_code == 1  # cost gate first
    r = runner.invoke(app, [*args, "--yes"])
    assert r.exit_code == AWAITING_CONFIRMATION, r.output
    runner.invoke(app, ["confirm", str(rev / "FIXDENT0000000001.json"), "--checker", "Lee"])
    r = runner.invoke(app, args)  # no --yes needed: the answer is saved
    assert r.exit_code == 0, r.output
    assert "1 decided, 0 awaiting" in r.output
    assert len(client.calls) == 1


def test_evaluate_no_cache_asks_again(tmp_path, monkeypatch):
    from test_vision import PNG, reply

    (tmp_path / "door.jpg").write_bytes(PNG)
    vfile = tmp_path / "car.json"
    car = json.loads((FIXTURE_DIR / "dent_600.json").read_text())
    vfile.write_text(json.dumps({**car, "photo_refs": ["door.jpg"]}))
    empty = {"findings": [], "unmapped_damage": []}
    client = _fake_claude(monkeypatch, reply(empty), reply(empty))
    args = ["evaluate", str(vfile), "--detector", "claude", "--photo-root", str(tmp_path),
            "--skip-confirm"]  # fmt: skip
    assert runner.invoke(app, [*args, "--yes"]).exit_code == 0
    assert runner.invoke(app, args).exit_code == 0  # cached: free, no --yes
    r = runner.invoke(app, [*args, "--no-cache"])
    assert r.exit_code == 1 and "roughly $" in r.output
    assert runner.invoke(app, [*args, "--no-cache", "--yes"]).exit_code == 0
    assert len(client.calls) == 2


def test_detect_eval_batch_sends_only_unanswered_photos(tmp_path, monkeypatch):
    import underscope.vision as vision
    from test_vision import PNG, FakeClient, batch_client, ok, reply

    (tmp_path / "a.jpg").write_bytes(PNG)
    (tmp_path / "b.jpg").write_bytes(PNG + b"b")
    dent = {"panel": "door", "damage_type": "dent", "severity": 0.4, "confidence": 0.9}
    live = FakeClient(reply({"findings": [dent], "unmapped_damage": []}))
    batches = batch_client([ok("p0", {"findings": [], "unmapped_damage": []})])
    client = type("Both", (), {"beta": live.beta, "messages": batches.messages})()
    real = vision.ClaudeVisionDetector
    monkeypatch.setattr(vision, "ClaudeVisionDetector",
                        lambda root, **kw: real(root, client=client, **kw))  # fmt: skip
    labels, state = _labels(tmp_path), tmp_path / "state.json"
    base = ["detect-eval", str(labels), "--photo-root", str(tmp_path)]
    assert runner.invoke(app, [*base, "--limit", "1", "--yes"]).exit_code == 0  # answers a.jpg
    r = runner.invoke(app, [*base, "--batch"])
    assert r.exit_code == 1 and "sends 1 photos" in r.output
    r = runner.invoke(app, [*base, "--batch", "--yes", "--batch-state", str(state)])
    assert "with 1 photos (1 already answered)" in r.output
    assert json.loads(state.read_text())["photos"] == {"p0": "b.jpg"}
    r = runner.invoke(app, [*base, "--collect", str(state)])
    assert r.exit_code == 0, r.output
    assert "Photos scored: 2 (0 failed" in r.output and "| Panel F1 | 100.0% |" in r.output


def test_claude_boxes_reach_the_saved_review(tmp_path, monkeypatch):
    from test_vision import PNG, reply

    for name in ("a.jpg", "b.jpg"):
        (tmp_path / name).write_bytes(PNG + name.encode())
    vfile = tmp_path / "car.json"
    car = json.loads((FIXTURE_DIR / "dent_600.json").read_text())
    vfile.write_text(json.dumps({**car, "findings": [], "photo_refs": ["a.jpg", "b.jpg"]}))
    dent = {"panel": "door", "damage_type": "dent", "severity": 0.5, "confidence": 0.9,
            "side": "left"}
    box = {"x0": 0.1, "y0": 0.1, "x1": 0.4, "y1": 0.5}
    answer = {"view": "left", "unmapped_damage": [], "findings": [{**dent, "box": box}]}
    _fake_claude(monkeypatch, reply(answer), reply(answer))
    rev = tmp_path / "rev"
    r = runner.invoke(app, ["evaluate", str(vfile), "--detector", "claude", "--yes",
                            "--photo-root", str(tmp_path), "--no-interactive",
                            "--review-dir", str(rev)])  # fmt: skip
    assert r.exit_code == AWAITING_CONFIRMATION, r.output
    saved = json.loads((rev / "FIXDENT0000000001.json").read_text())
    assert len(saved["findings"]) == 1  # merged
    assert [s["photo_ref"] for s in saved["sightings"]] == ["a.jpg", "b.jpg"]
    assert (rev / "FIXDENT0000000001.html").read_text().count("<b>#1</b>") == 2


def test_confirm_regrades_with_severity(tmp_path):
    reviews = tmp_path / "rev"
    runner.invoke(app, ["evaluate", str(FIXTURE_DIR / "dent_600.json"), "--no-interactive",
                        "--review-dir", str(reviews)])  # fmt: skip
    path = reviews / "FIXDENT0000000001.json"
    r = runner.invoke(app, ["confirm", str(path), "--checker", "Lee", "--severity", "1:0.7"])
    assert r.exit_code == 0, r.output
    assert json.loads(path.read_text())["findings"][0]["severity"] == 0.7
    r = runner.invoke(app, ["confirm", str(path), "--checker", "Lee", "--severity", "1:2"])
    assert r.exit_code != 0

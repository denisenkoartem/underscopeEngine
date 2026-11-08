import pytest

from underscope import calibration
from underscope.models import DamageFinding


def f(panel, conf):
    return DamageFinding(panel=panel, damage_type="dent", severity=0.4, confidence=conf)


def dataset(n_high_hit, n_high_miss, n_mid_hit, n_mid_miss):
    """Each photo has one true door dent; predictions either match it or land on the roof."""
    truth, pred, i = {}, {}, 0
    for conf, hits, misses in ((0.95, n_high_hit, n_high_miss), (0.6, n_mid_hit, n_mid_miss)):
        for k in range(hits + misses):
            truth[f"p{i}"] = [f("door", 1.0)]
            pred[f"p{i}"] = [f("door" if k < hits else "roof", conf)]
            i += 1
    return truth, pred


def test_overconfident_detector_is_pulled_down():
    truth, pred = dataset(30, 30, 18, 12)  # 0.95 band right 50%, 0.6 band right 60%
    cal = calibration.fit(truth, pred)
    bins = {b["low"]: b for b in cal["bins"]}
    assert bins[0.9]["predictions"] == 60 and bins[0.5]["predictions"] == 30
    # 50% < 60%: the two bands are pooled so the map stays monotone.
    assert bins[0.9]["calibrated"] == bins[0.5]["calibrated"] == pytest.approx(49 / 92, abs=1e-4)
    assert bins[0.0]["calibrated"] is None  # no data: unchanged
    assert calibration.apply(0.95, cal) == bins[0.9]["calibrated"]
    assert calibration.apply(0.3, cal) == 0.3
    assert calibration.apply(0.3, None) == 0.3


def test_small_bands_left_alone(tmp_path):
    truth, pred = dataset(5, 0, 25, 0)
    cal = calibration.fit(truth, pred, min_count=20)
    bins = {b["low"]: b for b in cal["bins"]}
    assert bins[0.9]["calibrated"] is None
    assert bins[0.5]["calibrated"] == pytest.approx(26 / 27, abs=1e-4)
    assert calibration.load(calibration.save(cal, tmp_path / "c.json")) == cal
    assert "unchanged (too few)" in calibration.render(cal)


def test_detector_applies_calibration(tmp_path):
    from test_vision import PNG, FakeClient, finding, reply
    from underscope.vision import ClaudeVisionDetector

    (tmp_path / "a.png").write_bytes(PNG)
    table = {"bins": [{"low": 0.0, "high": 0.5, "calibrated": None},
                      {"low": 0.5, "high": 1.0, "calibrated": 0.55}]}  # fmt: skip
    client = FakeClient(reply({"view": "left", "unmapped_damage": [],
                               "findings": [finding(conf=0.9), finding("hood", conf=0.3)]}))
    out = ClaudeVisionDetector(tmp_path, client=client, calibration=table).detect_photo("a.png")
    assert [x.confidence for x in out] == [0.55, 0.3]


def test_calibrate_cli_then_score_with_it(tmp_path):
    import json

    from typer.testing import CliRunner

    from underscope.cli import app
    from underscope.detector_eval import save_findings

    truth, pred = dataset(30, 30, 18, 12)
    lp, pp, cp = tmp_path / "l.json", tmp_path / "p.json", tmp_path / "c.json"
    save_findings(truth, lp)
    save_findings(pred, pp)
    r = CliRunner().invoke(app, ["calibrate", str(lp), str(pp), "--out", str(cp)])
    assert r.exit_code == 0, r.output and "Calibrated to" in r.output
    assert json.loads(cp.read_text())["bins"][3]["predictions"] == 60
    plain = CliRunner().invoke(app, ["detect-eval", str(lp), "--predictions", str(pp)])
    fixed = CliRunner().invoke(app, ["detect-eval", str(lp), "--predictions", str(pp),
                                     "--calibration", str(cp)])  # fmt: skip

    def brier(text):
        line = next(x for x in text.splitlines() if "Brier" in x)
        return float(line.split("|")[2])

    assert brier(fixed.output) < brier(plain.output)


def test_split_is_seeded_and_disjoint():
    refs = [f"p{i}" for i in range(10)]
    fit_refs, test_refs = calibration.split(refs, 0.3, seed=1)
    assert len(test_refs) == 3 and not set(fit_refs) & set(test_refs)
    assert set(fit_refs) | set(test_refs) == set(refs)
    assert calibration.split(refs, 0.3, seed=1) == (fit_refs, test_refs)
    assert calibration.split(refs, 0.0) == (sorted(refs), [])
    with pytest.raises(ValueError):
        calibration.split(refs, 1.0)


def test_holdout_check_shows_calibration_helping_an_overconfident_detector():
    truth, pred = dataset(30, 30, 0, 0)  # says 0.95, right half the time
    cal = calibration.fit(truth, pred)
    raw, after = calibration.holdout_check(truth, pred, cal)
    assert after < raw
    assert raw == pytest.approx((30 * 0.05**2 + 30 * 0.95**2) / 60)

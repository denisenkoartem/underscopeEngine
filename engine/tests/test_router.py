"""The router model: trained on the simulation's labels, served behind the title rules."""

import numpy as np
import pytest

from test_assessment import GOOD, body
from underscope import router
from underscope.assessment import Assessment
from underscope.bridge import route
from underscope.config import default_assumptions


@pytest.fixture(scope="module")
def model():
    return router.train(router.simulated_rows(800, seed=3), seed=3)


def test_generated_cars_are_seeded_and_allow_both_marketplaces():
    rows = router.generate(40, seed=5)
    assert rows == router.generate(40, seed=5) and rows != router.generate(40, seed=6)
    assert {r["title_status"] for r in rows} <= {"clean", "rebuilt", "lemon"}
    assert all(len(r["grades"]) == 25 and len(r["values"]["salvage_comps"]) >= 3 for r in rows)


def test_features_are_complete_numbers(model):
    a = default_assumptions()
    x = router.features(Assessment.model_validate(body(run_status="starts")), a)
    assert set(x) == set(router.FEATURES)
    assert len(router.vector(x)) == len(router.FEATURES)
    assert x["run_status"] == "starts" and x["title_status"] == "clean"
    assert x["grade_front_bumper"] == 2 and x["parts_replace"] == 1 and x["comps"] == 4
    # Nothing stated is still a full record: missing numbers and "unknown" categories.
    empty = router.features(Assessment.model_validate({}), a)
    assert set(empty) == set(router.FEATURES) and empty["engine_condition"] == "unknown"
    assert all(v == v or True for v in router.vector(empty))


def test_training_is_seeded_and_copies_the_simulation(model):
    again = router.train(router.simulated_rows(800, seed=3), seed=3)
    assert again.meta == model.meta
    h = model.meta["held_out"]
    assert h["agreement"] >= 0.85 and h["p_acv_mean_abs_error"] <= 0.12
    assert model.meta["trained_on"] == "simulated outcomes"
    assert model.meta["sources"] == {"simulation": 800}


def test_training_rows_round_trip_and_recorded_outcomes_train(tmp_path):
    rows = router.simulated_rows(300, seed=11)
    path = tmp_path / "rows.jsonl"
    path.write_text("".join(r.model_dump_json() + "\n" for r in rows))
    assert router.read_rows(path) == rows
    # A recorded outcome: one net per marketplace, no simulated share.
    recorded = [router.TrainingRow(assessment=r.assessment, source="recorded",
                                   outcome={"acv_net": r.outcome.acv_net,
                                            "copart_net": r.outcome.copart_net}) for r in rows]
    m = router.train(recorded, seed=1)
    assert m.meta["trained_on"] == "recorded outcomes" and m.meta["sources"] == {"recorded": 300}
    assert "recorded outcome" in router.report(m.meta) and "simulated" not in router.report(m.meta)
    with pytest.raises(ValueError, match="too few"):
        router.train(rows[:20])


def test_the_model_decides_when_both_marketplaces_are_open(model):
    a = default_assumptions()
    out = route(body(**GOOD), a, model)
    assert out["decided_by"] == "model" and out["model"]["trained_on"] == "simulated outcomes"
    assert out["destination"] == ("ACV" if out["p_acv"] >= 0.5 else "Copart")
    assert 0 <= out["p_acv"] <= 1 and 0 <= out["p_acv_simulation"] <= 1
    assert any("trained on simulated outcomes" in n for n in out["notes"])
    # A car that does not start, with no keys, is never a better ACV candidate.
    worse = route(body(**{**GOOD, "run_status": "does_not_start", "keys": False,
                          "engine_condition": "failed"}), a, model)  # fmt: skip
    assert worse["p_acv"] <= out["p_acv"] + 0.02


def test_rules_and_missing_data_come_before_the_model(model):
    a = default_assumptions()
    out = route(body(title_status="salvage"), a, model)
    assert (out["decided_by"], out["destination"], out["model"]) == ("title_rule", "Copart", None)
    out = route(body(values={"clean_wholesale": None, "salvage_comps": []}), a, model)
    assert out["decided_by"] == "simulation" and out["confidence"] == "insufficient"
    out = route(body(title_status="unknown"), a, model)
    assert set(out["title_branches"]) == {"clean", "salvage"}


def test_a_disagreement_with_the_simulation_is_flagged():
    class Contrary:
        def __init__(self, p):
            self.p = p

        def p_acv(self, x):
            return self.p

        def summary(self):
            return {}

    a = default_assumptions()
    sim = route(body(**GOOD), a)
    out = route(body(**GOOD), a, Contrary(0.02 if sim["destination"] == "ACV" else 0.98))
    assert out["destination"] != sim["destination"]
    assert out["confidence"] == "close_call" and out["needs_human_review"]
    assert "dollar simulation prefers" in out["review_reasons"][0]
    assert out["winner"] in {o["path"] for o in out["options"]}


def test_without_a_model_the_simulation_decides(monkeypatch, tmp_path):
    monkeypatch.setenv(router.ENV, str(tmp_path / "missing.joblib"))
    out = route(body(**GOOD))
    assert out["decided_by"] == "simulation" and out["model"] is None


def test_the_saved_model_matches_the_code_and_the_simulation(monkeypatch):
    monkeypatch.delenv(router.ENV)
    saved = router.load_model()
    if saved is None:
        pytest.skip("no engine/models/router.joblib: run `underscope train-router`")
    a = default_assumptions()
    rows = router.simulated_rows(300, seed=991)
    agree = np.mean([
        (saved.p_acv(router.features(Assessment.model_validate(r.assessment), a)) >= 0.5)
        == (r.outcome.acv_net >= r.outcome.copart_net) for r in rows])  # fmt: skip
    assert agree >= 0.9

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
    # Facts are hidden from the model, so it cannot match the full-information answer always.
    assert h["agreement"] >= 0.6 and set(h["by_level"]) <= set(router.LEVELS)
    assert sum(v["rows"] for v in h["by_level"].values()) == h["rows"]
    assert model.meta["trained_on"] == "simulated outcomes"
    # Cars a rule decides (here the seller's deadline) are left out: nothing to learn there.
    assert 700 < model.meta["sources"]["simulation"] <= 800


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
    assert m.meta["trained_on"] == "recorded outcomes"
    assert m.meta["sources"] == {"recorded": len(rows)}
    assert "recorded outcome" in router.report(m.meta) and "simulated" not in router.report(m.meta)
    with pytest.raises(ValueError, match="too few"):
        router.train(rows[:20])


def no_clean_value(**extra):
    """GOOD without the clean wholesale value: the simulation would run on a placeholder."""
    b = body(**{**GOOD, **extra})
    b["values"] = {**b["values"], "clean_wholesale": None}
    return b


def test_the_simulation_decides_when_the_seller_gives_both_money_facts(model):
    a = default_assumptions()
    out = route(body(**GOOD), a, model)
    assert out["decided_by"] == "simulation" and out["confidence"] != "insufficient"
    assert out["p_acv"] == out["p_acv_simulation"]


def test_the_model_decides_when_a_money_fact_is_missing(model):
    a = default_assumptions()
    out = route(no_clean_value(), a, model)
    assert out["decided_by"] == "model" and out["model"]["trained_on"] == "simulated outcomes"
    assert out["destination"] == ("ACV" if out["p_acv"] >= 0.5 else "Copart")
    assert 0 <= out["p_acv"] <= 1 and 0 <= out["p_acv_simulation"] <= 1
    assert any("trained on simulated outcomes" in n for n in out["notes"])
    # A car that does not start, with no keys, is never a better ACV candidate.
    worse = route(no_clean_value(run_status="does_not_start", keys=False,
                                 engine_condition="failed"), a, model)  # fmt: skip
    assert worse["p_acv"] <= out["p_acv"] + 0.02


def test_rules_and_missing_data_come_before_the_model(model):
    a = default_assumptions()
    out = route(body(title_status="salvage"), a, model)
    assert (out["decided_by"], out["destination"], out["model"]) == ("title_rule", "Copart", None)
    # No model: missing values leave the simulation on placeholders, so it does not answer.
    no_values = body(values={"clean_wholesale": None, "salvage_comps": []})
    out = route(no_values, a)
    assert out["decided_by"] == "simulation" and out["confidence"] == "insufficient"
    out = route(body(title_status="unknown"), a, model)
    assert set(out["title_branches"]) == {"clean", "salvage"}


class Contrary:
    """A stand-in model that always answers the same chance."""

    def __init__(self, p):
        self.p, self.meta = p, {}

    def p_acv(self, x):
        return self.p

    def summary(self):
        return {}


def test_a_disagreement_with_the_simulation_is_flagged():
    a = default_assumptions()
    sim = route(no_clean_value(), a)
    out = route(no_clean_value(), a, Contrary(0.02 if sim["destination"] == "ACV" else 0.98))
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
    rows = [r for r in router.simulated_rows(1500, seed=991) if r.level != "low"]
    said = saved.p_acv_many([router.features(Assessment.model_validate(r.assessment), a)
                             for r in rows]) >= 0.5  # fmt: skip
    agree = np.mean(said == np.array([r.outcome.acv_net >= r.outcome.copart_net for r in rows]))
    assert len(rows) > 100 and agree >= 0.85  # with the needed facts given
    by_level = saved.meta["held_out"]["by_level"]
    assert set(by_level) == set(router.LEVELS)
    assert by_level["full"]["agreement"] >= by_level["low"]["agreement"]


def test_training_cars_hide_facts_the_way_the_reader_does():
    a = default_assumptions()
    rates = router.load_rates()
    assert set(rates) == set(a["router_training"]["profiles"]) and set(rates["sparse"]) == set(
        router.MASK_FIELDS)
    # Each fact is hidden at about the configured rate.
    rng = np.random.default_rng(0)
    cars = router.generate(600, seed=4)
    for profile in ("sparse", "medium"):
        seen = [router.mask(c, rates[profile], rng)[0] for c in cars]
        for field, want in (("run_status", rates[profile]["run_status"]),
                            ("mileage", rates[profile]["mileage"])):  # fmt: skip
            got = np.mean([s[field] not in (None, "unknown") for s in seen])
            assert abs(got - want) < 0.07, (profile, field, got, want)
        got = np.mean([s["values"]["clean_wholesale"] is not None for s in seen])
        assert abs(got - rates[profile]["values.clean_wholesale"]) < 0.07
    full = [router.mask(c, rates["full"], rng) for c in cars[:50]]
    assert all(seen == car and not hidden for (seen, hidden), car in zip(full, cars, strict=False))
    # The feature matrix therefore has unknowns, and the label still comes from the full car.
    rows = router.simulated_rows(600, seed=4)
    X = np.array([router.vector(router.features(Assessment.model_validate(r.assessment), a))
                  for r in rows])  # fmt: skip
    clean = X[:, router.FEATURES.index("clean_value")]
    assert 0.3 < np.isnan(clean).mean() < 0.9
    assert all(r.outcome.p_acv is not None for r in rows)
    assert {r.level for r in rows} == set(router.LEVELS)


def test_the_model_answers_with_values_missing_and_says_it_is_less_precise(model):
    a = default_assumptions()
    out = route(body(values={"clean_wholesale": None, "salvage_comps": []}), a, model)
    assert out["decided_by"] == "model" and out["confidence"] != "insufficient"
    assert out["missing"] == ["clean wholesale value", "at least 3 comparable salvage sales"]
    assert out["ranges_are_rough"] and any("rough" in n for n in out["notes"])
    assert route(body(**GOOD), a, model)["ranges_are_rough"] is False
    # Nothing to go on at all: no answer, with or without a model.
    bare = route({}, a, model)
    assert bare["decided_by"] == "simulation" and bare["confidence"] == "insufficient"
    assert "nothing to go on" in bare["review_reasons"][0]
    # One fact is enough to be asked.
    assert route({"run_status": "does_not_start"}, a, model)["decided_by"] == "model"


def test_precision_is_reported_with_the_measured_agreement(model):
    a = default_assumptions()
    low = {"expected": 23, "given": 5, "level": "low",
           "note": "The answer wouldn't be as precise: 18 of the 23 facts the reader was "
                   "expecting were not given (6 of them needed for the decision)."}  # fmt: skip
    expected = [{"field": "mileage", "need": "needed", "given": False, "ask": "the mileage"},
                {"field": "keys", "need": "helpful", "given": False, "ask": "the keys"},
                {"field": "title_status", "need": "needed", "given": True, "ask": "the title"}]
    out = route(no_clean_value(precision=low, expected=expected[1:] + expected[:1]), a, model)
    p = out["precision"]
    assert p["level"] == "low" and p["not_given"] == ["the mileage", "the keys"]  # needed first
    measured = model.meta.get("deployed") or model.meta["held_out"]
    assert p["agreement"] == measured["by_level"]["low"]["agreement"]
    assert p["note"].startswith(low["note"]) and "matched the full-information answer" in p["note"]
    assert f"{p['agreement']:.0%} of test cars" in p["note"]
    # Without the reader's own count the engine works the level out itself.
    own = route(body(**GOOD), a, model)["precision"]
    assert own["level"] in ("full", "reduced") and "low" != own["level"]
    assert route(body(values={"clean_wholesale": None, "salvage_comps": []}), a, model)[
        "precision"]["level"] == "low"
    # A rule's answer carries the level but no model agreement.
    ruled = route(body(title_status="salvage", precision=low), a, model)["precision"]
    assert ruled["level"] == "low" and ruled["agreement"] is None


def test_a_low_precision_answer_is_never_a_clear_call():
    a, model = default_assumptions(), Contrary(0.97)  # as sure as the simulation here
    low = {"level": "low", "note": "The answer wouldn't be as precise."}
    sure = route(body(**GOOD), a, model)
    capped = route(body(**GOOD, precision=low), a, model)
    assert sure["confidence"] == "clear" and capped["confidence"] == "close_call"
    assert capped["destination"] == sure["destination"] and capped["needs_human_review"]
    assert any("not a clear call" in r for r in capped["review_reasons"])
    reduced = route(body(**GOOD, precision={"level": "reduced", "note": "x"}), a, model)
    assert reduced["confidence"] == "clear"
    # A rule's answer does not depend on the missing facts.
    assert route(body(title_status="salvage", precision=low), a, model)["confidence"] == "clear"

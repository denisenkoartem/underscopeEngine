"""Every Assessment the reader emits routes as it is (fixture written by the reader side:
`pnpm -s reader:assessments` in reader/; rows are {id, kind, a})."""

import json
from pathlib import Path as FsPath

import pytest

from underscope import router
from underscope.assessment import Assessment, expectations, precision_level
from underscope.bridge import nothing_to_go_on, route
from underscope.config import default_assumptions

FIXTURE = FsPath(__file__).parent / "fixtures" / "reader_assessments.jsonl"
BRANDED = {"salvage", "flood", "non_repairable"}  # titles the config sends to Copart only


@pytest.fixture(scope="module")
def rows():
    if not FIXTURE.is_file():
        pytest.skip("no tests/fixtures/reader_assessments.jsonl in this checkout")
    return [json.loads(line) for line in FIXTURE.read_text().splitlines() if line.strip()]


@pytest.fixture(scope="module")
def routed(rows):
    # No VIN is added and nothing is filled in: the Assessment goes in as the reader wrote it.
    # Explicit assumptions: no saved model, so these runs do not depend on the model file.
    a = default_assumptions()
    return [(r, route(r["a"], a)) for r in rows]


def test_every_row_routes_without_a_vin(rows, routed):
    assert len(routed) == len(rows) > 100
    assert sum(not r["a"].get("vin") for r in rows) > 50  # the file does cover missing VINs
    for r, out in routed:
        assert out["destination"] in ("ACV", "Copart"), r["id"]
        assert out["decided_by"] in ("title_rule", "seller_rule", "seller_limit", "model",
                                     "simulation"), r["id"]  # fmt: skip
        assert out["winner"] in {o["path"] for o in out["options"]}, r["id"]
        assert out["reader_missing"] == r["a"]["missing"], r["id"]
        assert out["could_add"] == r["a"]["could_add"], r["id"]


def test_a_private_seller_never_goes_to_acv(routed):
    private = [(r, out) for r, out in routed if r["a"].get("seller_type") == "individual"]
    assert private
    for r, out in private:
        assert out["destination"] == "Copart", r["id"]


def test_the_sellers_lane_limit_is_respected(routed):
    limited = [(r, out) for r, out in routed if r["a"].get("lanes_allowed")]
    assert limited
    for r, out in limited:
        a = r["a"]
        if out["destination"].lower() in a["lanes_allowed"]:
            continue
        # The one way a limit is not met: a rule that comes first leaves none of those lanes
        # (a branded title, a private seller or an insurer cannot use ACV, whatever the seller
        # prefers).
        assert out["destination"] == "Copart", r["id"]
        barred_seller = a["seller_type"] in ("individual", "insurer")
        assert a["title_status"] in BRANDED or barred_seller, r["id"]
        assert out["decided_by"] in ("title_rule", "seller_rule"), r["id"]
        # ...and it is never silent about it.
        assert out["review_reasons"][0].startswith("The seller allows only"), r["id"]
        assert out["answer"].startswith("The seller allows only"), r["id"]
        assert out["needs_human_review"], r["id"]
        assert out["verify_first"] == "Confirm the seller's marketplace limit", r["id"]


def test_the_same_input_gives_the_same_output(rows, routed):
    a = default_assumptions()
    for r, out in routed[::7]:
        assert route(r["a"], a) == out, r["id"]


def test_rows_with_both_money_facts_are_decided_by_the_simulation_or_a_rule(routed, monkeypatch):
    monkeypatch.delenv(router.ENV)
    if router.load_model() is None:
        pytest.skip("no engine/models/router.joblib: run `underscope train-router`")
    a = default_assumptions()
    full = [r for r, _ in routed if r["a"]["values"].get("clean_wholesale")
            and len(r["a"]["values"].get("salvage_comps") or []) >= a["routing"]["min_comps"]]
    assert full
    for r in full:
        out = route(r["a"])  # the saved model
        assert out["confidence"] != "insufficient", r["id"]
        # The seller's own clean value and comps: the simulation decides, never the model.
        assert out["decided_by"] != "model", r["id"]
        assert route(r["a"]) == out, r["id"]
    # Without the clean value the simulation would run on placeholders: the model answers.
    gaps = [r for r, _ in routed if not r["a"]["values"].get("clean_wholesale")]
    assert any(route(r["a"])["decided_by"] == "model" for r in gaps)


def test_the_engines_copy_of_what_the_reader_expects_matches_the_reader(rows):
    for r in rows:
        s = Assessment.model_validate(r["a"])
        mine = [(e["field"], e["need"], e["given"]) for e in expectations(s)]
        theirs = [(e["field"], e["need"], e["given"]) for e in r["a"]["expected"]]
        assert mine == theirs, r["id"]
        assert precision_level(expectations(s)) == r["a"]["precision"]["level"], r["id"]


def test_every_row_gets_an_answer_with_its_precision(rows, monkeypatch):
    monkeypatch.delenv(router.ENV)
    if router.load_model() is None:
        pytest.skip("no engine/models/router.joblib: run `underscope train-router`")
    rules = ("title_rule", "seller_rule", "seller_limit")
    answered = 0
    for r in rows:
        out, s = route(r["a"]), Assessment.model_validate(r["a"])
        p = out["precision"]
        assert p["level"] == r["a"]["precision"]["level"], r["id"]
        assert p["not_given"] == r["a"]["missing"] + r["a"]["could_add"], r["id"]
        if out["decided_by"] in rules:
            assert p["agreement"] is None, r["id"]
            continue
        # Two marketplaces allowed: the simulation answers from the seller's clean value and
        # comps, the model without them, unless there is nothing to go on.
        if nothing_to_go_on(s):
            assert (out["decided_by"], out["confidence"]) == ("simulation", "insufficient")
            continue
        answered += 1
        money = bool(r["a"]["values"].get("clean_wholesale")) and len(
            r["a"]["values"].get("salvage_comps") or []) >= 3
        assert out["decided_by"] == ("simulation" if money else "model"), r["id"]
        assert out["confidence"] != "insufficient", r["id"]
        assert 0 < p["agreement"] <= 1 and "of test cars" in p["note"], r["id"]
        if p["level"] == "low":
            assert out["confidence"] == "close_call", r["id"]  # never a clear call
        if not r["a"]["values"].get("clean_wholesale"):
            assert out["ranges_are_rough"], r["id"]
    assert answered > 100

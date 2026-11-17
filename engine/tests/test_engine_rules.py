"""One test per rule the engine applies to the reader's fields beyond damage and title."""

import json

from typer.testing import CliRunner

from test_assessment import GOOD, body
from underscope.bridge import route, to_engine
from underscope.cli import app
from underscope.config import default_assumptions


def options(out):
    return {o["path"]: o for o in out["options"]}


# ---- A. Runs on the Assessment alone


def test_no_vin_year_mileage_or_state_is_filled_from_config_and_noted():
    a = default_assumptions()
    b = body(**GOOD, vin=None, vehicle={"year": None, "make": None, "model": None},
             mileage=None, region=None)  # fmt: skip
    vehicle, _, notes = to_engine(b)
    age = a["defaults"]["vehicle_age_years"]
    assert vehicle.vin == "" and vehicle.region == a["defaults"]["region"]
    assert vehicle.year == a["base_value"]["reference_year"] - age
    assert vehicle.mileage == age * a["defaults"]["miles_per_year"] > 0  # never 0 miles
    for said in ("No 17-character VIN", "Model year not given", "Mileage not given",
                 "State not given"):  # fmt: skip
        assert any(said in n for n in notes), said
    assert route(b)["destination"] in ("ACV", "Copart")


def test_unknown_year_without_a_clean_value_is_missing():
    no_values = {"clean_wholesale": None, "salvage_comps": []}
    out = route(body(vehicle={"year": None}, values=no_values))
    assert out["confidence"] == "insufficient" and "vehicle year (or a VIN)" in out["missing"]
    # With the year known, or with a clean value, the year is not asked for.
    assert "vehicle year (or a VIN)" not in route(body(values=no_values))["missing"]
    assert "vehicle year (or a VIN)" not in route(body(vehicle={"year": None}))["missing"]


def test_route_assessment_command(tmp_path):
    one, many = tmp_path / "one.json", tmp_path / "many.jsonl"
    one.write_text(json.dumps(body(**GOOD)))
    many.write_text(json.dumps({"id": "x", "kind": "rules", "a": body()}) + "\n"
                    + json.dumps(body(title_status="salvage")) + "\n")  # fmt: skip
    r = CliRunner().invoke(app, ["route-assessment", str(one)])
    assert r.exit_code == 0 and json.loads(r.stdout)["destination"] == "ACV"
    r = CliRunner().invoke(app, ["route-assessment", str(many)])
    lines = [json.loads(x) for x in r.stdout.splitlines()]
    assert r.exit_code == 0 and len(lines) == 2 and lines[0]["id"] == "x"
    assert lines[1]["destination"] == "Copart"


# ---- B. Fields that matter


def test_4_a_private_seller_cannot_use_acv():
    out = route(body(**GOOD, seller_type="individual"))
    assert out["destination"] == "Copart" and out["decided_by"] == "seller_rule"
    reasons = {e["path"]: e["reason"] for e in out["excluded"]}
    assert "dealer-to-dealer" in reasons["acv_as_is"] and "dealer-to-dealer" in out["answer"]
    # An insurer sells claim vehicles at salvage auction, not dealer to dealer (2026-11-16).
    out = route(body(**GOOD, seller_type="insurer"))
    assert out["destination"] == "Copart" and out["decided_by"] == "seller_rule"
    assert out["confidence"] == "clear" and "Insurer" in out["answer"]
    for seller in ("dealer", "fleet", "lender", "unknown"):
        assert route(body(**GOOD, seller_type=seller))["decided_by"] == "simulation", seller
    # The title rule comes first and keeps its name.
    out = route(body(**GOOD, seller_type="individual", title_status="salvage"))
    assert out["decided_by"] == "title_rule"


def test_5_repair_cost_priority_and_already_repaired():
    quote = {**body()["values"], "repair_estimate": 4000}
    v, _, notes = to_engine(body(values=quote))
    assert v.repair_override_cents == (360_000, 400_000, 520_000)  # quote x config spread
    assert any("seller's quote of $4,000" in n for n in notes)
    v, _, _ = to_engine(body(values=quote, repair={"low": 1000, "high": 3000}))
    assert v.repair_override_cents == (100_000, 200_000, 300_000)  # the page's estimate wins
    v, _, _ = to_engine(body())
    assert v.repair_override_cents is None  # neither: the engine's own panel costs

    done = route(body(**GOOD, already_repaired="yes"))
    todo = route(body(**GOOD, already_repaired="no"))
    v, _, notes = to_engine(body(already_repaired="yes"))
    assert v.repair_done and v.repair_override_cents == (0, 0, 0)
    assert any("already repaired" in n for n in notes)
    assert (options(done)["repair_then_acv"]["expected"]
            > options(todo)["repair_then_acv"]["expected"])  # fmt: skip
    partly = route(body(**GOOD, already_repaired="partly"))
    assert any("partly repaired" in r for r in partly["review_reasons"])
    assert options(partly) == options(route(body(**GOOD)))  # the estimate is kept


def test_6_all_25_parts_are_priced_by_the_engine():
    a = default_assumptions()
    grades = {p: "replace" for p in ("left_mirror", "wheels_and_tires", "interior", "engine_bay")}
    b = body()
    b["grades"] = [{"part": g["part"], "grade": grades.get(g["part"], "fine")}
                   for g in b["grades"]]  # fmt: skip
    v, findings, notes = to_engine(b)
    table = a["grades"]["other_parts_cents"]
    assert findings == []
    assert v.mechanical_repair_cents == (sum(table[p]["replace"][0] for p in grades),
                                         sum(table[p]["replace"][1] for p in grades))  # fmt: skip
    assert not any("not priced" in n for n in notes)
    # With the page's estimate they are already in it and are not added again.
    assert to_engine({**b, "repair": {"low": 500, "high": 900}})[0].mechanical_repair_cents is None


def test_7_storage_cost_is_added_to_every_exits_holding():
    base, stored = route(body(**GOOD)), route(body(**GOOD, storage_cost_per_day=30))
    for path, o in options(stored).items():
        assert o["expected"] < options(base)[path]["expected"], path
    # The repair exit waits longest, so it pays the most storage.
    drop = {p: options(base)[p]["expected"] - o["expected"] for p, o in options(stored).items()}
    assert drop["repair_then_acv"] > drop["acv_as_is"]
    assert any("$30 a day" in n for n in stored["notes"])


def test_8_exits_slower_than_the_sellers_deadline_are_excluded():
    out = route(body(**GOOD, sell_by_days=12))  # as-is on ACV takes about 10 days
    assert [o["path"] for o in out["options"]] == ["acv_as_is"]
    assert out["decided_by"] == "seller_limit" and out["destination"] == "ACV"
    late = {e["path"]: e["reason"] for e in out["excluded"]}
    assert "the seller has 12" in late["repair_then_acv"] and "copart_salvage" in late
    # Nothing is fast enough: the fastest exit is kept and a person is asked to look.
    out = route(body(**GOOD, sell_by_days=2))
    assert [o["path"] for o in out["options"]] == ["acv_as_is"]
    assert any("No exit is expected to sell within" in r for r in out["review_reasons"])
    assert len(route(body(**GOOD, sell_by_days=365))["options"]) == 3


def test_9_reserve_price_is_reported_and_never_decides():
    base = route(body(**GOOD))
    low = route(body(**GOOD, values={**body()["values"], "reserve_price": 100}))
    high = route(body(**GOOD, values={**body()["values"], "reserve_price": 50_000}))
    assert all(o["p_meets_reserve"] is None for o in base["options"])
    assert all(o["p_meets_reserve"] == 1 for o in low["options"])
    assert all(o["p_meets_reserve"] == 0 for o in high["options"])
    assert any("lowest price of $50,000" in c for c in high["input_checks"])
    assert not any("lowest price" in c for c in low["input_checks"])
    assert base["destination"] == low["destination"] == high["destination"]


def test_10_purchase_price_shows_the_margin():
    out = route(body(**GOOD, values={**body()["values"], "purchase_price": 3000}))
    for o in out["options"]:
        assert o["vs_purchase"] == o["expected"] - 3000
    assert all(o["vs_purchase"] is None for o in route(body(**GOOD))["options"])


def test_11_missing_parts_lower_the_as_is_price():
    whole, stripped = route(body(**GOOD)), route(body(**{**GOOD, "parts_missing": True}))
    assert options(stripped)["acv_as_is"]["expected"] < options(whole)["acv_as_is"]["expected"]
    assert any("parts missing: yes" in n for n in stripped["notes"])


def test_12_reader_meta_is_returned_and_a_conflict_lowers_confidence():
    b = body(**GOOD, missing=["the mileage"], could_add=["whether the keys are with it"])
    clear = route(b)
    assert clear["reader_missing"] == ["the mileage"]
    assert clear["could_add"] == ["whether the keys are with it"]
    assert clear["confidence"] == "clear" and clear["verify_first"] is None

    two_ways = {"field": "run_status", "kept": "runs_and_drives", "dropped": "does_not_start"}
    out = route({**b, "conflicts": [two_ways]})
    assert out["confidence"] == "close_call" and out["verify_first"] == "Confirm run status"
    assert any("run status: runs_and_drives (used) or does_not_start" in r
               for r in out["review_reasons"])  # fmt: skip
    assert out["destination"] == clear["destination"]
    for field in ("flags.flood_suspected", "grades.hood", "values.clean_wholesale"):
        assert route({**b, "conflicts": [{**two_ways, "field": field}]})["verify_first"]
    # A field the decision does not use changes nothing.
    other = route({**b, "conflicts": [{**two_ways, "field": "drivetrain"}]})
    assert other["confidence"] == "clear" and other["verify_first"] is None


def test_a_lane_limit_the_title_rules_out_is_said_out_loud():
    out = route(body(**GOOD, title_status="salvage", lanes_allowed=["acv"]))
    said = "The seller allows only ACV, but a salvage title cannot be listed there"
    assert out["destination"] == "Copart" and out["decided_by"] == "title_rule"
    assert out["review_reasons"][0].startswith(said) and out["answer"].startswith(said)
    assert "Copart is the only exit. Confirm with the seller." in out["review_reasons"][0]
    assert out["needs_human_review"] and out["confidence"] == "clear"
    assert out["verify_first"] == "Confirm the seller's marketplace limit"
    # A limit that can be met raises nothing.
    met = route(body(**GOOD, title_status="salvage", lanes_allowed=["copart"]))
    assert met["verify_first"] is None and not met["needs_human_review"]


def test_a_lane_limit_the_private_seller_rule_rules_out_is_said_out_loud():
    out = route(body(**GOOD, seller_type="individual", lanes_allowed=["acv"]))
    said = "The seller allows only ACV, but a private seller cannot list there"
    assert out["destination"] == "Copart" and out["decided_by"] == "seller_rule"
    assert out["review_reasons"][0].startswith(said) and out["answer"].startswith(said)
    assert out["needs_human_review"] and out["confidence"] == "clear"
    assert out["verify_first"] == "Confirm the seller's marketplace limit"


def test_a_rule_decides_clearly_even_with_nothing_else_given():
    # The destination is not in doubt; the lack of detail is carried by precision, not here.
    for only, rule in (({"seller_type": "individual"}, "seller_rule"),
                       ({"sell_by_days": 5}, "seller_limit"),
                       ({"lanes_allowed": ["copart"]}, "seller_limit"),
                       ({"title_status": "flood"}, "title_rule")):  # fmt: skip
        out = route(only)
        assert (out["decided_by"], out["confidence"]) == (rule, "clear"), only
        assert out["precision"]["not_given"], only  # ...and the gaps are still listed
    # No rule and nothing to go on: still no answer.
    assert route({})["confidence"] == "insufficient"

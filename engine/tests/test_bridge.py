"""The web app -> engine bridge: mapping and routing to ACV or Copart."""

import copy
import json
from pathlib import Path as FsPath

import pytest

from underscope.bridge import TITLE, route, to_engine
from underscope.config import Assumptions, default_assumptions
from underscope.models import Panel

# The web page's own request bodies (one per sample case), kept with the TS engine's fixtures.
PAGE = FsPath(__file__).resolve().parents[2] / "reader" / "fixtures" / "website"

PARTS = ["front_bumper", "hood", "grille", "left_headlight", "right_headlight", "windshield",
         "left_front_fender", "right_front_fender", "left_front_door", "right_front_door",
         "left_rear_door", "right_rear_door", "left_mirror", "right_mirror", "left_rear_quarter",
         "right_rear_quarter", "tailgate_or_rear_doors", "rear_bumper", "left_taillight",
         "right_taillight", "wheels_and_tires", "roof", "interior", "engine_bay", "underbody"]


def payload(damaged=None, **extra):
    damaged = damaged or {}
    return {
        "vin": "WBA8B9C51JEE81681",
        "vehicle": {"year": "2018", "make": "BMW", "model": "330i"},
        "title_status": "clean",
        "grades": [{"part": p, "grade": damaged.get(p, "fine")} for p in PARTS],
        "flags": {"airbags_deployed": False, "frame_suspected": False, "fluid_leak": False},
        "codes": [],
        "values": {"clean_wholesale": 11000, "salvage_comps": [2625, 4875, 5325, 7725]},
        **extra,
    }


def test_grades_map_to_engine_panels_and_sides():
    vehicle, findings, notes = to_engine(payload({"hood": "replace", "left_headlight":
                                                  "repairable", "left_mirror": "replace"}))
    got = {(f.panel, f.side, f.damage_type.value) for f in findings}
    assert (Panel.HOOD, "center", "broken") in got
    assert (Panel.FRONT_BUMPER, "left", "dent") in got
    assert len(findings) == 2  # the mirror isn't a panel: it is costed from config
    assert vehicle.mechanical_repair_cents == (15_000, 45_000)
    assert any("Mirrors, wheels, interior" in n for n in notes)
    assert vehicle.clean_value_cents == 1_100_000
    assert vehicle.salvage_comps_cents == [262_500, 487_500, 532_500, 772_500]
    assert vehicle.undercarriage_damage is False and vehicle.engine_audio_abnormal is False


def test_flags_titles_and_codes():
    codes = [{"code": "P0730", "system": "transmission", "severity": "major", "cost_low": 500,
              "cost_high": 4500, "source": "generic_table"}]
    p = payload({"underbody": "replace"}, title_status="flood", codes=codes,
                flags={"frame_suspected": True})
    vehicle, findings, notes = to_engine(p)
    assert vehicle.title_status.value == "salvage"
    assert any(f.panel == Panel.FRAME for f in findings)
    assert vehicle.undercarriage_damage is True and vehicle.engine_audio_abnormal is True
    assert vehicle.mechanical_repair_cents == (50_000, 450_000)


def test_no_scan_leaves_engine_audio_unknown():
    p = payload()
    del p["codes"]
    vehicle, _, _ = to_engine(p)
    assert vehicle.engine_audio_abnormal is None


def test_route_sends_an_undamaged_car_to_acv():
    out = route(payload())
    assert out["destination"] == "ACV"
    assert [o["destination"] for o in out["options"]].count("Copart") == 1
    assert out["options"][0]["expected"] >= out["options"][-1]["expected"]


def test_route_sends_a_wreck_to_copart():
    heavy = {p: "replace" for p in ["front_bumper", "hood", "grille", "left_headlight",
                                    "right_headlight", "windshield", "left_front_fender",
                                    "right_front_fender", "left_front_door", "roof"]}
    p = payload(heavy, values={"clean_wholesale": 9000, "salvage_comps": [3000, 3500, 4000]},
                flags={"frame_suspected": True, "fluid_leak": True})
    out = route(p)
    assert out["destination"] == "Copart", out["winner_label"]
    assert "part_out" not in [o["path"] for o in out["options"]]


def test_mechanical_repair_raises_the_repair_estimate():
    base = route(payload({"hood": "repairable"}))
    codes = [{"code": "P0730", "system": "transmission", "severity": "major", "cost_low": 500,
              "cost_high": 4500, "source": "generic_table"}]
    with_codes = route(payload({"hood": "repairable"}, codes=codes))
    rep = {o["path"]: o["expected"] for o in base["options"]}["repair_then_acv"]
    rep_codes = {o["path"]: o["expected"] for o in with_codes["options"]}["repair_then_acv"]
    assert rep_codes < rep


def test_a_missing_vin_is_noted_not_rejected():
    vehicle, _, notes = to_engine(payload(vin="SHORT"))
    assert vehicle.vin == "" and any("No 17-character VIN" in n for n in notes)


def test_app_repair_estimate_replaces_engine_costs():
    """One repair cost: the app's estimate (with codes and unknowns) is what the engine uses."""
    codes = [{"code": "P0730", "system": "transmission", "severity": "major", "cost_low": 500,
              "cost_high": 4500, "source": "generic_table"}]
    p = payload({"hood": "replace"}, codes=codes, repair={"low": 1200, "high": 5200})
    vehicle, _, notes = to_engine(p)
    assert vehicle.repair_override_cents == (120_000, 320_000, 520_000)
    assert vehicle.mechanical_repair_cents is None  # codes are inside the app's estimate
    assert not any("of mechanical repair" in n for n in notes)
    assert any("taken from the app" in n for n in notes)


def test_app_repair_estimate_drives_the_decision():
    cheap = route(payload({"hood": "replace"}, repair={"low": 300, "high": 600}))
    dear = route(payload({"hood": "replace"}, repair={"low": 9000, "high": 14000}))
    exp = lambda r: {o["path"]: o["expected"] for o in r["options"]}["repair_then_acv"]  # noqa: E731
    assert exp(cheap) > exp(dear)
    assert dear["destination"] != "ACV" or dear["winner"] != "repair_then_acv"


def test_non_repairable_title_never_routes_to_acv():
    out = route(payload({"left_front_door": "replace"}, title_status="non_repairable"))
    assert {o["destination"] for o in out["options"]} == {"Copart"}
    assert out["destination"] == "Copart" and out["confidence"] == "clear"
    assert "Non-repairable" in out["answer"] and not out["flip_conditions"]
    assert {x["path"] for x in out["excluded"]} == {"repair_then_acv", "acv_as_is", "part_out"}


def test_lanes_cover_every_app_title():
    assert set(default_assumptions()["lanes"]["by_title"]) == set(TITLE) - {"unknown"}


def page(name):
    if not PAGE.exists():
        pytest.skip("web page fixtures not in this checkout")
    return json.loads((PAGE / name).read_text())


@pytest.mark.parametrize("name", ["03_airbags_salvage.json", "05_flood_title.json",
                                  "06_nonrepairable.json"])  # fmt: skip
def test_branded_titles_go_to_copart(name):
    out = route(page(name))
    assert out["destination"] == "Copart" and out["confidence"] == "clear"
    assert out["p_acv"] == 0 and [o["path"] for o in out["options"]] == ["copart_salvage"]
    assert not out["needs_human_review"]


def test_acv_exits_overlapping_is_not_a_close_call():
    # Repair-then-ACV and as-is on ACV beat each other about half the time, but both are ACV
    # and Copart is far behind: a clear ACV answer, no review.
    out = route(page("01_front_hit_runs.json"))
    assert out["destination"] == "ACV" and out["p_acv"] == 1 and out["confidence"] == "clear"
    assert not out["needs_human_review"]
    assert [o["path"] for o in out["options"]][-1] == "copart_salvage"
    # The as-is formula ($18,000) disagrees with the comps; flagged, numbers unchanged.
    assert any("comps" in c for c in out["input_checks"])


def test_unknown_title_that_decides_the_marketplace():
    out = route(page("04_transmission_title_unknown.json"))
    assert out["title_branches"]["clean"]["destination"] == "ACV"
    assert out["title_branches"]["salvage"]["destination"] == "Copart"
    assert out["confidence"] == "close_call" and out["verify_first"] == "Confirm the title brand"
    assert out["needs_human_review"] and out["inputs"]["title"] == "unknown"
    assert "Confirm the title brand first" in out["answer"]


def test_unknown_title_same_marketplace_either_way():
    heavy = {p: "replace" for p in ["front_bumper", "hood", "grille", "windshield", "roof",
                                    "left_front_fender", "right_front_fender"]}  # fmt: skip
    p = payload(heavy, title_status="unknown", flags={"frame_suspected": True},
                values={"clean_wholesale": 9000, "salvage_comps": [3000, 3500, 4000]})
    out = route(p)
    assert {b["destination"] for b in out["title_branches"].values()} == {"Copart"}
    assert out["verify_first"] is None and "either way" in out["notes"][0]


def test_missing_market_values_make_the_answer_insufficient():
    out = route(payload({"hood": "replace"}, values={}))
    assert out["confidence"] == "insufficient" and out["needs_human_review"]
    assert out["missing"] == ["clean wholesale value", "at least 3 comparable salvage sales"]
    assert route(page("08_spanish_notes_only.json"))["confidence"] == "insufficient"
    # With only one marketplace allowed, missing values can't change where it goes.
    one = route(payload({"hood": "replace"}, title_status="salvage", values={}))
    assert one["confidence"] == "clear" and one["missing"] == []


def test_part_out_returns_when_the_seller_dismantles():
    data = copy.deepcopy(default_assumptions().data)
    data["lanes"]["seller_can_part_out"] = True
    out = route(payload({"hood": "replace"}), Assumptions(data))
    assert "part_out" in [o["path"] for o in out["options"]]
    assert "part_out" not in [x["path"] for x in out["excluded"]]

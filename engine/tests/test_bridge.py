"""The web app -> engine bridge: mapping and routing to ACV or Copart."""

import pytest

from underscope.bridge import route, to_engine
from underscope.models import Panel

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
    assert len(findings) == 2  # the mirror isn't a costed panel
    assert any("left mirror" in n for n in notes)
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
    assert out["destination"] in {"Copart", "Parts buyer"}, out["winner_label"]


def test_mechanical_repair_raises_the_repair_estimate():
    base = route(payload({"hood": "repairable"}))
    codes = [{"code": "P0730", "system": "transmission", "severity": "major", "cost_low": 500,
              "cost_high": 4500, "source": "generic_table"}]
    with_codes = route(payload({"hood": "repairable"}, codes=codes))
    rep = {o["path"]: o["expected"] for o in base["options"]}["repair_then_acv"]
    rep_codes = {o["path"]: o["expected"] for o in with_codes["options"]}["repair_then_acv"]
    assert rep_codes < rep


def test_bad_vin_is_rejected():
    with pytest.raises(ValueError, match="17 characters"):
        to_engine(payload(vin="SHORT"))


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
    assert {o["destination"] for o in out["options"]} <= {"Copart", "Parts buyer"}
    assert out["destination"] in {"Copart", "Parts buyer"}
    assert "Non-repairable" in out["answer"] and not out["flip_conditions"]

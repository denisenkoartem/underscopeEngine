"""The reader's Assessment as the engine's input, and what its facts do to the money."""

import re
from pathlib import Path as FsPath

import pytest

from underscope import assessment as A
from underscope.assessment import Assessment
from underscope.bridge import route, to_engine
from underscope.config import default_assumptions
from underscope.decision import ACV_PATHS, simulate
from underscope.models import Path
from underscope.valuation import value_vehicle

CONTRACT = FsPath(__file__).resolve().parents[2] / "reader" / "src" / "contract.ts"
VIN = "WBA8B9C51JEE81681"


def body(**extra):
    """A full Assessment as the reader sends it: light front damage, everything else unknown."""
    grades = {"front_bumper": "replace", "hood": "repairable"}
    return {
        "reader": "rules", "vin": VIN, "vehicle": {"year": 2018, "make": "BMW", "model": "330i"},
        "title_status": "clean", "title_state": "NY", "title_in_hand": "unknown", "lien": "unknown",
        "mileage": 84000, "odometer_status": "unknown", "region": "NY", "zip": None,
        "seller_type": "unknown", "lanes_allowed": None,
        "run_status": "unknown", "keys": "unknown", "engine_condition": "unknown",
        "transmission_condition": "unknown", "drivetrain": "unknown", "fuel_type": "unknown",
        "primary_damage": "front", "secondary_damage": "unknown",
        "grades": [{"part": p, "grade": grades.get(p, "fine")} for p in A.PARTS],
        "flags": {f: "unknown" for f in A.FLAGS},
        "catalytic_converter": "unknown", "parts_missing": "unknown", "already_repaired": "unknown",
        "warning_lights": [], "codes": [], "symptoms": [],
        "values": {"clean_wholesale": 11000, "salvage_comps": [2625, 4875, 5325, 7725],
                   "purchase_price": None, "repair_estimate": None, "reserve_price": None},
        "storage_cost_per_day": None, "sell_by_days": None,
        "evidence": {}, "missing": [], "could_add": [], "questions": [], "additional": [],
        "conflicts": [],
        **extra,
    }  # fmt: skip


def nets(b):
    a = default_assumptions()
    vehicle, findings, _ = to_engine(b)
    val = value_vehicle(vehicle, findings, a)
    return {p: simulate(vehicle, val, a).nets[p] for p in Path}


@pytest.mark.skipif(not CONTRACT.is_file(), reason="reader/src/contract.ts not in this checkout")
def test_lists_match_the_readers_contract():
    ts = CONTRACT.read_text()

    def names(block: str) -> tuple[str, ...]:
        return tuple(re.findall(r"'([^']+)'", block))

    def const(name: str) -> tuple[str, ...]:
        return names(re.search(rf"export const {name} = \[(.*?)\] as const", ts, re.S).group(1))

    enums = re.search(r"export const ENUMS = \{(.*?)\} as const", ts, re.S).group(1)
    got = {k: names(v) for k, v in re.findall(r"(\w+): \[(.*?)\]", enums, re.S)}
    assert got == A.ENUMS
    for name, ours in (("PARTS", A.PARTS), ("GRADES", A.GRADES), ("TRI_FIELDS", A.TRI_FIELDS),
                       ("FLAGS", A.FLAGS), ("VALUE_FIELDS", A.VALUE_FIELDS),
                       ("LANES", A.LANES)):  # fmt: skip
        assert const(name) == ours, name
    # Every key of the reader's JSON has a place in the engine's model.
    block = ts.split("export type Assessment = {")[1].split("\n};")[0]
    keys = set(re.findall(r"^  (\w+)\??:", block, re.M))
    assert keys <= set(Assessment.model_fields), keys - set(Assessment.model_fields)


def test_empty_and_odd_bodies_parse():
    assert Assessment.model_validate({}).condition() is None
    a = Assessment.model_validate({"run_status": "flies", "keys": "maybe", "lanes_allowed": ["x"],
                                   "flags": None, "new_reader_key": 1})  # fmt: skip
    assert a.run_status == "unknown" and a.keys == "unknown" and a.lanes_allowed is None
    out = route({"vin": VIN, "run_status": "unknown"})
    assert out["confidence"] == "insufficient" and out["decided_by"] == "simulation"


def test_the_old_page_body_gets_no_condition():
    old = {k: v for k, v in body().items() if k in ("vin", "vehicle", "title_status", "grades",
                                                    "values", "mileage", "region")}  # fmt: skip
    old["flags"] = {"airbags_deployed": True, "frame_suspected": False, "fluid_leak": False}
    assert to_engine(old)[0].condition is None


def test_stated_facts_reach_the_vehicle():
    c = to_engine(body(run_status="does_not_start", keys=False, engine_condition="failed",
                       lien="open", flags={"flood_suspected": True}))[0].condition  # fmt: skip
    assert (c.run_status, c.keys, c.engine, c.lien) == ("does_not_start", False, "failed", "open")
    assert c.flood_suspected is True and c.transmission is None and c.airbags_deployed is None


GOOD = dict(run_status="runs_and_drives", keys=True, engine_condition="ok",
            transmission_condition="ok", catalytic_converter="present", odometer_status="actual",
            title_in_hand=True, lien="none",
            flags={"airbags_deployed": False, "frame_suspected": False, "fluid_leak": False,
                   "flood_suspected": False, "fire_damage": False})  # fmt: skip
BAD = [
    {"run_status": "does_not_start"}, {"run_status": "starts"}, {"keys": False},
    {"engine_condition": "failed"}, {"transmission_condition": "minor"},
    {"catalytic_converter": "missing"}, {"odometer_status": "not_actual"},
    {"title_in_hand": False}, {"lien": "open"},
    {"flags": {**GOOD["flags"], "flood_suspected": True}},
    {"flags": {**GOOD["flags"], "fire_damage": True}},
    {"flags": {**GOOD["flags"], "airbags_deployed": True}},
]  # fmt: skip


@pytest.mark.parametrize("bad", BAD, ids=lambda b: str(b)[:40])
def test_a_bad_fact_never_raises_an_acv_net_and_unknown_sits_between(bad):
    (fact, value), = bad.items()
    unknown = {**GOOD["flags"], next(k for k in value if value[k] is True): "unknown"} \
        if fact == "flags" else "unknown"
    good, mid, worst = (nets(body(**{**GOOD, fact: v})) for v in (GOOD[fact], unknown, value))
    for p in ACV_PATHS:
        assert worst[p].mean() <= good[p].mean() and mid[p].mean() <= good[p].mean()
        # Unknown is a chance of the worst value, so a milder stated one can sit above it.
        if value not in ("starts", "minor"):
            assert worst[p].mean() <= mid[p].mean()
    assert any(worst[p].mean() < good[p].mean() for p in ACV_PATHS)  # it does something
    assert worst[Path.COPART_SALVAGE].mean() <= good[Path.COPART_SALVAGE].mean()


def test_all_good_facts_equal_no_condition_at_all():
    base = {k: v for k, v in body().items() if k not in A.CONDITION_KEYS}
    base["flags"] = {"airbags_deployed": False, "frame_suspected": False, "fluid_leak": False}
    with_good, without = nets(body(**GOOD)), nets(base)
    # Stating that all is fine removes only the allowance for an unheard engine.
    assert (with_good[Path.ACV_AS_IS] == without[Path.ACV_AS_IS]).all()
    assert (with_good[Path.COPART_SALVAGE] == without[Path.COPART_SALVAGE]).all()


def test_seller_lane_limit():
    out = route(body(**GOOD, lanes_allowed=["copart"]))
    assert out["destination"] == "Copart" and out["decided_by"] == "seller_limit"
    assert {e["path"] for e in out["excluded"]} >= {"repair_then_acv", "acv_as_is"}
    assert any("seller does not allow ACV" in e["reason"] for e in out["excluded"])
    # A limit the title cannot meet does not strand the car.
    out = route(body(**GOOD, title_status="salvage", lanes_allowed=["acv"]))
    assert out["destination"] == "Copart" and out["decided_by"] == "title_rule"


def test_notes_say_what_was_used():
    notes = route(body(run_status="does_not_start"))["notes"]
    assert any("run status: does not start" in n and "From the description" in n for n in notes)
    assert any("Not stated, engine: failed assumed in 8% of outcomes" in n for n in notes)

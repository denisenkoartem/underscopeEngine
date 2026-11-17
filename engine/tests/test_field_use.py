"""Every key of the reader's Assessment is used: it changes a dollar term, a rule, the
confidence, or is passed back. FIELD_USE says which; this file checks each one does."""

import re
from pathlib import Path as FsPath

import pytest

from test_assessment import GOOD, body
from underscope.assessment import Assessment
from underscope.bridge import route
from underscope.config import default_assumptions
from underscope.intake import FIELD_USE, to_engine

CONTRACT = FsPath(__file__).resolve().parents[2] / "reader" / "src" / "contract.ts"
NO_CLEAN = {"clean_wholesale": None, "salvage_comps": [2625, 4875, 5325, 7725]}
UNGRADED = [{"part": g["part"], "grade": "unknown"} for g in body()["grades"]]
# Flood not stated: it is then assumed in a share of outcomes (stated flood signs exclude ACV).
FLOOD = {**GOOD["flags"], "flood_suspected": "unknown"}

# key -> (base body, the same body with only that key changed)
CASES = {
    "reader": (body(), body(reader="rules+model")),
    "vin": (body(), body(vin=None)),
    "vehicle": (body(values=NO_CLEAN), body(values=NO_CLEAN, vehicle={"year": 2010})),
    "title_status": (body(**GOOD), body(**GOOD, title_status="rebuilt")),
    "title_state": (body(**GOOD), body(**GOOD, title_state="CA")),
    "title_in_hand": (body(**GOOD), body(**{**GOOD, "title_in_hand": False})),
    "lien": (body(**GOOD), body(**{**GOOD, "lien": "open"})),
    "mileage": (body(values=NO_CLEAN), body(values=NO_CLEAN, mileage=190000)),
    "odometer_status": (body(**GOOD), body(**{**GOOD, "odometer_status": "not_actual"})),
    "region": (body(**GOOD), body(**GOOD, region="CA")),
    "zip": (body(**GOOD, region=None), body(**GOOD, region=None, zip="90210")),
    "seller_type": (body(**GOOD), body(**GOOD, seller_type="individual")),
    "lanes_allowed": (body(**GOOD), body(**GOOD, lanes_allowed=["copart"])),
    "run_status": (body(**GOOD), body(**{**GOOD, "run_status": "does_not_start"})),
    "keys": (body(**GOOD), body(**{**GOOD, "keys": False})),
    "engine_condition": (body(**GOOD), body(**{**GOOD, "engine_condition": "failed"})),
    "transmission_condition": (body(**GOOD),
                               body(**{**GOOD, "transmission_condition": "failed"})),
    "drivetrain": (body(**{**GOOD, "transmission_condition": "failed"}),
                   body(**{**GOOD, "transmission_condition": "failed"}, drivetrain="awd")),
    "fuel_type": (body(**{**GOOD, "flags": FLOOD}),
                  body(**{**GOOD, "flags": FLOOD}, fuel_type="electric")),
    "primary_damage": (body(**GOOD, grades=UNGRADED, primary_damage="unknown"),
                       body(**GOOD, grades=UNGRADED, primary_damage="front")),
    "secondary_damage": (body(**GOOD, grades=UNGRADED, primary_damage="unknown"),
                         body(**GOOD, grades=UNGRADED, primary_damage="unknown",
                              secondary_damage="rear")),
    "grades": (body(**GOOD, grades=UNGRADED), body(**GOOD)),
    "flags": (body(**GOOD), body(**{**GOOD, "flags": {**GOOD["flags"], "frame_suspected": True}})),
    "catalytic_converter": (body(**GOOD), body(**{**GOOD, "catalytic_converter": "missing"})),
    "parts_missing": (body(**GOOD), body(**{**GOOD, "parts_missing": True})),
    "already_repaired": (body(**GOOD), body(**GOOD, already_repaired="yes")),
    "warning_lights": (body(**GOOD), body(**GOOD, warning_lights=["abs"])),
    "codes": (body(**GOOD), body(**GOOD, codes=[{"code": "C1234", "status": "confirmed"}])),
    "symptoms": (body(**GOOD), body(**GOOD, symptoms=[{"system": "brakes", "text": "grinds"}])),
    "values": (body(**GOOD), body(**GOOD, values={**body()["values"], "clean_wholesale": 20000})),
    "storage_cost_per_day": (body(**GOOD), body(**GOOD, storage_cost_per_day=30)),
    "sell_by_days": (body(**GOOD), body(**GOOD, sell_by_days=12)),
    "evidence": (body(**{**GOOD, "run_status": "does_not_start"}),
                 body(**{**GOOD, "run_status": "does_not_start"},
                      evidence={"run_status": "will not crank"})),
    "expected": (body(**GOOD), body(**GOOD, expected=[
        {"field": "mileage", "need": "needed", "given": False, "ask": "the mileage"}])),
    "precision": (body(**GOOD), body(**GOOD, precision={"level": "low", "note": "less precise"})),
    "missing": (body(**GOOD), body(**GOOD, missing=["the mileage"])),
    "could_add": (body(**GOOD), body(**GOOD, could_add=["whether the keys are with it"])),
    "questions": (body(**GOOD), body(**GOOD, questions=["Which side is the fender on?"])),
    "additional": (body(**GOOD), body(**GOOD, additional=["Owner smoked in it."])),
    "conflicts": (body(**GOOD), body(**GOOD, conflicts=[
        {"field": "run_status", "kept": "runs_and_drives", "dropped": "starts"}])),
}  # fmt: skip


def test_field_use_lists_every_key_of_the_contract():
    assert set(FIELD_USE) == set(Assessment.model_fields) - {"repair"}  # repair is the page's
    assert set(CASES) == set(FIELD_USE)
    assert {kind for kind, _ in FIELD_USE.values()} <= {"dollar", "rule", "confidence",
                                                        "feature", "returned"}  # fmt: skip
    if CONTRACT.is_file():
        block = CONTRACT.read_text().split("export type Assessment = {")[1].split("\n};")[0]
        assert set(re.findall(r"^  (\w+)\??:", block, re.M)) == set(FIELD_USE)


def money(out):
    return [(o["path"], o["expected"], o["p10"], o["p90"]) for o in out["options"]]


@pytest.mark.parametrize("key", list(CASES))
def test_changing_the_field_changes_what_its_use_says(key):
    a = default_assumptions()
    base, changed = CASES[key]
    kind = FIELD_USE[key][0]
    before, after = route(base, a), route(changed, a)
    assert before != after, key
    if kind == "dollar":
        # A term of the simulation: the dollars per exit move (or, for the state the car is
        # in, the total-loss threshold the simulation uses).
        moved = money(before) != money(after)
        region = to_engine(base, a)[0].region != to_engine(changed, a)[0].region
        assert moved or (key in ("region", "zip") and region), key
    elif kind == "rule":
        assert before["inputs"]["eligible"] != after["inputs"]["eligible"] or money(
            before) != money(after), key
    elif kind == "confidence":
        assert (before["confidence"], before["precision"]) != (
            after["confidence"], after["precision"]), key


def test_what_the_seller_does_not_mention_clears_nothing():
    a = default_assumptions()
    quiet = to_engine(body(warning_lights=[], codes=[], symptoms=[]), a)[0]
    assert quiet.signals == [] and quiet.engine_audio_abnormal is None  # still unknown


def test_a_check_engine_light_counts_unless_the_engine_fault_is_already_stated():
    a = default_assumptions()
    for engine, n in (("unknown", 1), ("ok", 1), ("minor", 0), ("failed", 0)):
        b = body(**{**GOOD, "engine_condition": engine}, warning_lights=["check_engine"])
        v, _, notes = to_engine(b, a)
        assert len(v.signals) == n, engine
        assert any("check engine light (60%" in x for x in notes) == bool(n), engine
    fine = {**GOOD, "engine_condition": "ok"}
    lit = route(body(**fine, warning_lights=["check_engine"]), a)
    assert money(lit) != money(route(body(**fine), a))


def test_parts_assumed_from_a_damage_area_are_marked_and_switchable():
    a = default_assumptions()
    b = body(**GOOD, grades=UNGRADED, primary_damage="front")
    _, findings, notes = to_engine(b, a)
    assert findings and any(n.startswith("Assumed from the main damage area (front)")
                            for n in notes)  # fmt: skip
    # A part the description grades is never overridden.
    graded = [{"part": g["part"], "grade": "fine" if g["part"] == "hood" else "unknown"}
              for g in body()["grades"]]  # fmt: skip
    _, some, said = to_engine(body(**GOOD, grades=graded, primary_damage="front"), a)
    assert len(some) < len(findings) and not any("hood" in n for n in said if "Assumed" in n)
    # The switch turns the inference off.
    import copy

    from underscope.config import Assumptions

    off = copy.deepcopy(a.data)
    off["damage_areas"]["fill_ungraded_parts"] = False
    _, none, quiet = to_engine(b, Assumptions(off))
    assert none == [] and not any("Assumed" in n for n in quiet)

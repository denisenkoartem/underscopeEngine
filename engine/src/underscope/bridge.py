"""Bridge from the Underscope web app to the engine.

The app collects a VIN decode, a title, 25 part grades (from OpenAI photo grading or a
reviewer), damage flags, decoded fault codes and market values. This module turns that into
the engine's VehicleRecord + DamageFinding list, runs the decision, and says where to send
the car: ACV (repair then sell, or sell as-is) or Copart (salvage), or a parts buyer.

Pure functions, no I/O: the Vercel endpoint (api/route.py) and the tests call `route`.
"""

from __future__ import annotations

from typing import Any

from underscope.decision import LABEL, evaluate
from underscope.models import DamageFinding, DamageType, Panel, Path, VehicleRecord

# App part -> (engine panel, side). Lights and grille ride on the bumpers, matching the engine
# detector's prompt; parts the engine doesn't cost (mirrors, wheels, interior, engine bay,
# underbody) are reported as notes or turned into inspection flags instead.
PART_PANEL: dict[str, tuple[Panel, str | None]] = {
    "front_bumper": (Panel.FRONT_BUMPER, "center"), "grille": (Panel.FRONT_BUMPER, "center"),
    "left_headlight": (Panel.FRONT_BUMPER, "left"),
    "right_headlight": (Panel.FRONT_BUMPER, "right"),
    "rear_bumper": (Panel.REAR_BUMPER, "center"),
    "tailgate_or_rear_doors": (Panel.REAR_BUMPER, "center"),
    "left_taillight": (Panel.REAR_BUMPER, "left"), "right_taillight": (Panel.REAR_BUMPER, "right"),
    "hood": (Panel.HOOD, "center"), "roof": (Panel.ROOF, "center"),
    "windshield": (Panel.WINDSHIELD, "center"),
    "left_front_fender": (Panel.FENDER, "left"), "right_front_fender": (Panel.FENDER, "right"),
    "left_front_door": (Panel.DOOR, "left"), "right_front_door": (Panel.DOOR, "right"),
    "left_rear_door": (Panel.DOOR, "left"), "right_rear_door": (Panel.DOOR, "right"),
    "left_rear_quarter": (Panel.QUARTER_PANEL, "left"),
    "right_rear_quarter": (Panel.QUARTER_PANEL, "right"),
}  # fmt: skip
NOT_COSTED = {"left_mirror", "right_mirror", "wheels_and_tires", "interior"}

# App grade -> (damage type, severity). Severity is the share of a full panel repair.
GRADE_DAMAGE: dict[str, tuple[DamageType, float]] = {
    "repairable": (DamageType.DENT, 0.35),
    "replace": (DamageType.BROKEN, 0.9),
}
PHOTO_CONFIDENCE = 0.85  # graded from photos (or confirmed by a reviewer on the page)

# Engine titles are clean/salvage/rebuilt. Flood and non-repairable are salvage brands;
# a lemon brand survives repair like rebuilt. Unknown is treated as clean and noted.
TITLE = {"clean": "clean", "salvage": "salvage", "rebuilt": "rebuilt", "flood": "salvage",
         "non_repairable": "salvage", "lemon": "rebuilt", "unknown": "clean"}  # fmt: skip

DESTINATION = {
    Path.REPAIR_THEN_ACV: "ACV", Path.ACV_AS_IS: "ACV",
    Path.COPART_SALVAGE: "Copart", Path.PART_OUT: "Parts buyer",
}  # fmt: skip

SEVERE = {"major", "critical"}
POWERTRAIN = {"engine", "transmission"}


def _tri(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def to_engine(payload: dict[str, Any]) -> tuple[VehicleRecord, list[DamageFinding], list[str]]:
    """App payload -> (vehicle, findings, notes). Raises ValueError on unusable input."""
    notes: list[str] = []
    vin = str(payload.get("vin") or "").strip().upper()
    if len(vin) != 17:
        raise ValueError("vin must be 17 characters")
    v = payload.get("vehicle") or {}
    values = payload.get("values") or {}
    flags = payload.get("flags") or {}
    grades = {g["part"]: g["grade"] for g in payload.get("grades") or [] if "part" in g}

    title_in = payload.get("title_status") or "unknown"
    title = TITLE.get(title_in, "clean")
    if title_in == "unknown":
        notes.append("Title not confirmed; treated as clean.")
    elif TITLE.get(title_in) != title_in:
        notes.append(f"{title_in.replace('_', '-')} title treated as {title} by the engine.")

    findings: list[DamageFinding] = []
    for part, grade in grades.items():
        if grade not in GRADE_DAMAGE:
            continue
        if part in PART_PANEL:
            panel, side = PART_PANEL[part]
            dtype, severity = GRADE_DAMAGE[grade]
            findings.append(DamageFinding(panel=panel, damage_type=dtype, severity=severity,
                                          confidence=PHOTO_CONFIDENCE, side=side))  # fmt: skip
        elif part in NOT_COSTED:
            notes.append(f"{part.replace('_', ' ')} ({grade}) is not priced by the engine.")
    if flags.get("frame_suspected") is True:
        findings.append(DamageFinding(panel=Panel.FRAME, damage_type=DamageType.CRUSH,
                                      severity=0.6, confidence=0.6, side="center"))  # fmt: skip
        notes.append("Suspected frame damage added as a frame finding.")

    under = grades.get("underbody")
    undercarriage = (True if under in GRADE_DAMAGE or flags.get("fluid_leak") is True
                     else False if under == "fine" else None)  # fmt: skip

    codes = [c for c in payload.get("codes") or [] if c.get("source") != "invalid"]
    engine_audio: bool | None
    if "codes" not in payload:
        engine_audio = None  # no scan: unknown, the engine reserves for hidden damage
    else:
        engine_audio = any(c.get("severity") in SEVERE and c.get("system") in POWERTRAIN
                           for c in codes) or grades.get("engine_bay") == "replace"  # fmt: skip
    mech = None
    if codes:
        lo = sum(int(c.get("cost_low") or 0) for c in codes)
        hi = sum(int(c.get("cost_high") or 0) for c in codes)
        mech = (lo * 100, hi * 100)
        notes.append(f"{len(codes)} fault code(s) add ${lo:,} to ${hi:,} of mechanical repair.")

    # One repair cost: when the app sends its repair estimate (parts table + fault codes,
    # widened for unknowns), the engine uses it instead of its placeholder panel costs.
    repair = payload.get("repair") or {}
    override = None
    if repair.get("high") is not None and repair.get("low") is not None:
        lo, hi = sorted((int(repair["low"]), int(repair["high"])))
        ex = int(repair.get("expected") or (lo + hi) // 2)
        override = (lo * 100, min(max(ex, lo), hi) * 100, hi * 100)
        mech = None  # fault codes are already inside the app's estimate
        notes = [n for n in notes if "of mechanical repair" not in n]
        notes.append(f"Repair estimate ${lo:,} to ${hi:,} taken from the app (parts, labor, "
                     "fault codes, allowance for unknowns); engine placeholder costs not used.")

    clean = values.get("clean_wholesale")
    comps = [int(x) for x in values.get("salvage_comps") or [] if int(x) > 0]
    if not clean:
        notes.append("No clean value given; the engine uses its placeholder depreciation curve.")

    vehicle = VehicleRecord(
        vin=vin,
        year=int(v.get("year") or 2020),
        make=str(v.get("make") or "Unknown"),
        model=str(v.get("model") or ""),
        mileage=max(0, int(payload.get("mileage") or 0)),
        region=str(payload.get("region") or "NY"),
        title_status=title,
        undercarriage_damage=undercarriage,
        engine_audio_abnormal=engine_audio,
        clean_value_cents=int(clean) * 100 if clean else None,
        salvage_comps_cents=[c * 100 for c in comps] or None,
        mechanical_repair_cents=mech,
        repair_override_cents=override,
    )
    return vehicle, findings, notes


def route(payload: dict[str, Any]) -> dict[str, Any]:
    """Run the engine on an app payload and say where the car should go."""
    vehicle, findings, notes = to_engine(payload)
    rec = evaluate(vehicle, findings)
    options = list(rec.options)
    if payload.get("title_status") == "non_repairable":
        # A non-repairable title can't be repaired and registered or sold to dealers as a road
        # car: only salvage buyers and dismantlers. The engine has no such title, so filter.
        options = [o for o in options if o.path in (Path.COPART_SALVAGE, Path.PART_OUT)]
        notes.append("Non-repairable title: ACV exits removed (can't be repaired and resold).")
    winner = options[0].path
    dollars = lambda c: round(c / 100)  # noqa: E731
    filtered = winner != rec.winner or len(options) < len(rec.options)
    answer = (f"Non-repairable title: only salvage and parts buyers can take it; "
              f"{LABEL[winner]} nets the most." if filtered else rec.answer)  # fmt: skip
    return {
        "destination": DESTINATION[winner],
        "winner": winner.value,
        "winner_label": LABEL[winner],
        "answer": answer,
        "explanation": answer if filtered else rec.explanation,
        "needs_human_review": rec.needs_human_review and not filtered,
        "review_reasons": [] if filtered else rec.review_reasons,
        "total_loss_decides": rec.total_loss_decides,
        "flip_conditions": [] if filtered else rec.flip_conditions,
        "options": [{
            "path": o.path.value, "label": LABEL[o.path], "destination": DESTINATION[o.path],
            "expected": dollars(o.expected_cents), "p10": dollars(o.p10_cents),
            "p50": dollars(o.p50_cents), "p90": dollars(o.p90_cents),
        } for o in options],  # fmt: skip
        "inputs": {"findings": len(findings), "title": vehicle.title_status.value,
                   "undercarriage_damage": vehicle.undercarriage_damage,
                   "engine_audio_abnormal": vehicle.engine_audio_abnormal},  # fmt: skip
        "notes": notes + ["Engine fees, holding costs and days to sell are PLACEHOLDER "
                          "assumptions (engine/config/assumptions.yaml)."],  # fmt: skip
    }

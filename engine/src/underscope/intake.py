"""Intake: the reader's Assessment -> the engine's vehicle, damage findings and notes.

Every key of the Assessment that carries a fact about the car is turned into something the
simulation uses here (FIELD_USE lists all of them and what each changes). Nothing is guessed
silently: a default, an inferred part or a counted complaint is named in the notes.
"""

from __future__ import annotations

import copy
from typing import Any

from underscope.assessment import Assessment
from underscope.config import Assumptions, default_assumptions
from underscope.models import DamageFinding, Panel, Signal, VehicleRecord

# What each Assessment key changes: "dollar" (a term of the simulation), "rule" (which exits
# are allowed), "confidence", "feature" (seen by the router model), "returned" (passed back).
# tests/test_field_use.py checks the list is complete and that each key does change the answer.
FIELD_USE: dict[str, tuple[str, str]] = {
    "reader": ("returned", "which reader wrote the JSON"),
    "vin": ("returned", "identity only; never required"),
    "vehicle": ("dollar", "year sets age for the value curve and assumed mileage; make, model "
                          "and trim are returned"),
    "title_status": ("rule", "which marketplaces the title allows; title discount on prices"),
    "title_state": ("dollar", "a title from another state than the vehicle adds holding days"),
    "title_in_hand": ("dollar", "no title in hand adds holding days"),
    "lien": ("dollar", "an open lien adds holding days"),
    "mileage": ("dollar", "value curve when there is no clean value; model feature"),
    "odometer_status": ("dollar", "not actual or exempt lowers both ACV prices"),
    "region": ("dollar", "the state's total-loss threshold"),
    "zip": ("dollar", "gives the state when the description has no state"),
    "seller_type": ("rule", "a private seller or an insurer cannot use ACV; an insurer also "
                            "makes it a claim (total-loss branding)"),
    "lanes_allowed": ("rule", "the seller's marketplace limit"),
    "run_status": ("dollar", "ACV as-is price, towing, no-start repair"),
    "keys": ("dollar", "key replacement cost"),
    "engine_condition": ("dollar", "mechanical repair cost"),
    "transmission_condition": ("dollar", "mechanical repair cost"),
    "drivetrain": ("dollar", "all-wheel drive raises a transmission repair"),
    "fuel_type": ("dollar", "battery vehicles: deeper flood discount, no catalytic converter"),
    "primary_damage": ("dollar", "fills parts the description does not grade; sets flood, fire "
                                 "and frame flags it leaves unknown"),
    "secondary_damage": ("dollar", "same as primary, one grade milder"),
    "grades": ("dollar", "damage findings and the engine's repair estimate"),
    "flags": ("dollar", "frame finding, airbags, leak, flood and fire effects; stated "
              "flood signs exclude ACV"),
    "catalytic_converter": ("dollar", "replacement cost"),
    "parts_missing": ("dollar", "lower as-is and Copart price"),
    "already_repaired": ("dollar", "yes: no repair cost or days; partly: review reason"),
    "warning_lights": ("dollar", "each light is a chance of a repair"),
    "codes": ("dollar", "each fault code is a chance of a repair"),
    "symptoms": ("dollar", "each complaint is a chance of a repair"),
    "values": ("dollar", "clean value and comps anchor prices; repair quote is the repair "
                         "cost; reserve and purchase price are reported per exit"),
    "storage_cost_per_day": ("dollar", "added to every exit's holding cost"),
    "sell_by_days": ("rule", "exits expected to take longer are excluded"),
    "evidence": ("returned", "the seller's words are quoted in the notes for each fact used"),
    "expected": ("confidence", "what the reader was expecting: the precision level"),
    "precision": ("confidence", "level low is never a clear answer"),
    "missing": ("returned", "as reader_missing"),
    "could_add": ("returned", "as could_add"),
    "questions": ("returned", "open questions for the seller"),
    "additional": ("returned", "as not_read: sentences nothing was read from"),
    "conflicts": ("confidence", "a decision field read two ways caps the answer at a close "
                                "call"),
}

# App part -> (engine panel, side). Lights and grille ride on the bumpers, matching the engine
# detector's prompt. Parts that are not panels (mirrors, wheels, interior, engine bay) get a
# repair cost from config `grades.other_parts_cents`; underbody becomes an inspection flag.
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

DAMAGED = ("repairable", "replace")  # app grades that become a finding (config `grades`)

# Engine titles are clean/salvage/rebuilt. Flood and non-repairable are salvage brands;
# a lemon brand survives repair like rebuilt. Unknown is treated as clean and noted.
TITLE = {"clean": "clean", "salvage": "salvage", "rebuilt": "rebuilt", "flood": "salvage",
         "non_repairable": "salvage", "lemon": "rebuilt", "unknown": "clean"}  # fmt: skip

SEVERE = {"major", "critical"}
POWERTRAIN = {"engine", "transmission"}


def _tri(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _usd(x: Any) -> int | None:
    """A dollar amount from the reader (number or null) as whole dollars, or None."""
    try:
        return None if x is None or isinstance(x, bool) else int(round(float(x)))
    except (TypeError, ValueError):
        return None


def _year(payload: dict[str, Any]) -> int | None:
    y = _usd((payload.get("vehicle") or {}).get("year"))
    return y if y and 1900 <= y <= 2100 else None


def _state_from_zip(zip_code: Any, a: Assumptions) -> str | None:
    digits = str(zip_code or "").strip()[:3]
    if len(digits) != 3 or not digits.isdigit():
        return None
    for state, ranges in a["defaults"]["zip_prefix_state"].items():
        if any(lo <= int(digits) <= hi for lo, hi in ranges):
            return str(state)
    return None


def fill_from_damage_areas(payload: dict[str, Any], a: Assumptions,
                           ) -> tuple[dict[str, Any], list[str]]:  # fmt: skip
    """The payload with parts and flags the description leaves open filled from its damage
    areas (config `damage_areas`), and one note per area saying what was assumed. Grades and
    flags the description states are never changed. This is an inference, not a stated fact."""
    cfg = a["damage_areas"]
    s = Assessment.model_validate(payload)
    areas = [(s.primary_damage, False), (s.secondary_damage, True)]
    if not cfg.get("fill_ungraded_parts", True) or all(x == "unknown" for x, _ in areas):
        return payload, []
    out = copy.deepcopy(payload)
    grades = {g.get("part"): g for g in out.get("grades") or [] if isinstance(g, dict)}
    flags = out.setdefault("flags", {}) if isinstance(out.get("flags"), dict) else {}
    out["flags"] = flags
    notes = []

    def put(part: str, grade: str) -> bool:
        if part in grades and grades[part].get("grade") in DAMAGED + ("fine",):
            return False
        if part in grades:
            grades[part]["grade"] = grade
        else:
            out.setdefault("grades", []).append({"part": part, "grade": grade})
            grades[part] = out["grades"][-1]
        return True

    for area, milder in areas:
        if area == "unknown":
            continue
        which = "second" if milder else "main"
        if area == "none":
            if not milder:
                from underscope.assessment import PARTS

                done = [p for p in PARTS if put(p, "fine")]
                if done:
                    notes.append(f"Main damage area is none: {len(done)} parts the description "
                                 "does not grade are assumed fine.")
            continue
        got = [f"{p.replace('_', ' ')} {g}" for p, g in cfg["parts"].get(area, {}).items()
               if put(p, "repairable" if milder else g)]  # fmt: skip
        set_flags = [f for f in cfg["flags"].get(area, []) if not isinstance(flags.get(f), bool)]
        for f in set_flags:
            flags[f] = True
        got += [f.replace("_", " ") for f in set_flags]
        if got:
            notes.append(f"Assumed from the {which} damage area ({area.replace('_', ' ')}), "
                         f"not stated part by part: {', '.join(got)}.")
    return out, notes


def signals(s: Assessment, region: str | None, a: Assumptions) -> list[Signal]:
    """Complaints the seller mentions (warning lights, fault codes, symptoms) and an
    out-of-state title, each as a chance of a cost or a delay. What the seller does not mention
    clears nothing: no light is not a scan."""
    cfg = a["signals"]
    engine, trans = s.engine_condition != "unknown", s.transmission_condition != "unknown"
    out: list[Signal] = []

    def add(name: str, spec: dict[str, Any], chance_pct: float | None = None) -> None:
        pct = spec["chance_pct"] if chance_pct is None else chance_pct
        out.append(Signal(name=name, chance=pct / 100, repair_cents=tuple(spec["repair_cents"])))

    for light in s.warning_lights:
        counted = ((light == "check_engine" and engine)
                   or (light == "airbag" and s.flags.get("airbags_deployed") is True))  # fmt: skip
        if light in cfg["warning_light"] and not counted:
            add(f"{str(light).replace('_', ' ')} light", cfg["warning_light"][light])
    for c in s.codes[: cfg["max_codes"]]:
        code = str(c.get("code") if isinstance(c, dict) else c).upper()
        status = c.get("status") if isinstance(c, dict) else None
        if code[:1] not in cfg["code"] or (code[:1] == "P" and (engine or trans)):
            continue
        status = status if status in cfg["code_status_chance_pct"] else "confirmed"
        add(f"code {code} ({status})", cfg["code"][code[:1]],
            cfg["code_status_chance_pct"][status])  # fmt: skip
    for sym in s.symptoms:
        if not isinstance(sym, dict):
            continue
        system = sym.get("system") if sym.get("system") in cfg["symptom"] else "other"
        if (system == "engine" and engine) or (system == "transmission" and trans):
            continue
        add(f"{system.replace('_', ' ')} complaint", cfg["symptom"][system])
    state = str(s.title_state or "").strip().upper()
    if state and region and state != region:
        out.append(Signal(name=f"title from {state}, vehicle in {region}", chance=1.0,
                          days=cfg["out_of_state_title_days"]))  # fmt: skip
    return out


def to_engine(payload: dict[str, Any], a: Assumptions | None = None,
              ) -> tuple[VehicleRecord, list[DamageFinding], list[str]]:  # fmt: skip
    """App payload -> (vehicle, findings, notes). Any Assessment the reader emits is usable."""
    a = a or default_assumptions()
    g, d = a["grades"], a["defaults"]
    payload, notes = fill_from_damage_areas(payload, a)
    s = Assessment.model_validate(payload)
    condition = s.condition()
    vin = str(payload.get("vin") or "").strip().upper()
    if len(vin) != 17:
        vin = ""
        notes.append("No 17-character VIN; the vehicle is taken from the description.")
    v = payload.get("vehicle") or {}
    values = payload.get("values") or {}
    flags = payload.get("flags") or {}
    grades = {x["part"]: x.get("grade") for x in payload.get("grades") or []
              if isinstance(x, dict) and "part" in x}  # fmt: skip

    year = _year(payload)
    if year is None:
        year = a["base_value"]["reference_year"] - d["vehicle_age_years"]
        notes.append(f"Model year not given; {d['vehicle_age_years']} years old assumed.")
    mileage = _usd(payload.get("mileage"))
    if mileage is None or mileage < 0:
        age = max(0, a["base_value"]["reference_year"] - year)
        mileage = age * d["miles_per_year"]
        notes.append(f"Mileage not given; {mileage:,} assumed ({d['miles_per_year']:,} a year).")
    region = str(payload.get("region") or "").strip().upper()
    stated_region = region or _state_from_zip(s.zip, a)
    if not region and stated_region:
        region = stated_region
        notes.append(f"State {region} taken from the ZIP code {s.zip}.")
    elif not region:
        region = d["region"]
        notes.append(f"State not given; {region} assumed for the total-loss threshold.")

    title_in = payload.get("title_status") or "unknown"
    title = TITLE.get(title_in, "clean")
    if title_in == "unknown":
        notes.append("Title not confirmed; treated as clean.")
    elif TITLE.get(title_in) != title_in:
        notes.append(f"{title_in.replace('_', '-')} title treated as {title} by the engine.")

    findings: list[DamageFinding] = []
    other_lo = other_hi = 0  # parts that are not panels, cents
    for part, grade in grades.items():
        if grade not in DAMAGED:
            continue
        if part in PART_PANEL:
            panel, side = PART_PANEL[part]
            findings.append(DamageFinding(panel=panel, damage_type=g[grade]["damage_type"],
                                          severity=g[grade]["severity"],
                                          confidence=g["confidence"], side=side))  # fmt: skip
        elif part in g["other_parts_cents"]:
            lo, hi = g["other_parts_cents"][part][grade]
            other_lo, other_hi = other_lo + lo, other_hi + hi
    if flags.get("frame_suspected") is True:
        f = g["frame_suspected"]
        findings.append(DamageFinding(panel=Panel.FRAME, damage_type=f["damage_type"],
                                      severity=f["severity"], confidence=f["confidence"],
                                      side="center"))  # fmt: skip
        notes.append("Suspected frame damage added as a frame finding.")

    under = grades.get("underbody")
    undercarriage = (True if under in DAMAGED or flags.get("fluid_leak") is True
                     else False if under == "fine" else None)  # fmt: skip

    # Only codes the old decoder priced (severity, cost band) count here. The reader's codes
    # are {code, status}: what the seller mentioned, not a scan, so they clear nothing.
    codes = [c for c in payload.get("codes") or []
             if isinstance(c, dict) and "severity" in c and c.get("source") != "invalid"]
    engine_audio: bool | None
    if "codes" not in payload or (condition is not None and not codes):
        engine_audio = None  # no scan: unknown, the engine reserves for hidden damage
    else:
        engine_audio = any(c.get("severity") in SEVERE and c.get("system") in POWERTRAIN
                           for c in codes) or grades.get("engine_bay") == "replace"  # fmt: skip
    if condition and condition.engine == condition.transmission == "ok":
        engine_audio = False  # the seller says both are fine: no allowance for an unknown
    mech_lo, mech_hi = other_lo, other_hi
    if other_hi:
        notes.append(f"Mirrors, wheels, interior and engine bay add ${other_lo // 100:,} to "
                     f"${other_hi // 100:,} to the engine's repair estimate.")
    if codes:
        lo = sum(int(c.get("cost_low") or 0) for c in codes)
        hi = sum(int(c.get("cost_high") or 0) for c in codes)
        mech_lo, mech_hi = mech_lo + lo * 100, mech_hi + hi * 100
        notes.append(f"{len(codes)} fault code(s) add ${lo:,} to ${hi:,} of mechanical repair.")
    mech = (mech_lo, mech_hi) if mech_hi else None

    # One repair cost, by priority: the page's estimate (parts table, widened for unknowns),
    # then the seller's own shop quote, then the engine's placeholder panel costs.
    repair = payload.get("repair") or {}
    quote = _usd(values.get("repair_estimate"))
    override, repair_done = None, False
    used_mech = "of mechanical repair", "to the engine's repair estimate"
    if s.already_repaired == "yes":
        override, repair_done, mech = (0, 0, 0), True, None
        notes = [n for n in notes if not any(k in n for k in used_mech)]
        notes.append("The seller says the damage is already repaired: no repair cost and no "
                     "repair days are counted.")
    elif _usd(repair.get("high")) is not None and _usd(repair.get("low")) is not None:
        lo, hi = sorted((_usd(repair["low"]), _usd(repair["high"])))
        ex = _usd(repair.get("expected")) or (lo + hi) // 2
        override, mech = (lo * 100, min(max(ex, lo), hi) * 100, hi * 100), None
        notes = [n for n in notes if not any(k in n for k in used_mech)]
        notes.append(f"Repair estimate ${lo:,} to ${hi:,} taken from the app (parts, labor, "
                     "allowance for unknowns); engine placeholder costs not used.")
    elif quote and quote > 0:
        lo, ex, hi = (round(quote * k) for k in a["repair_cost"]["seller_quote_spread"])
        override, mech = (lo * 100, ex * 100, hi * 100), None
        notes = [n for n in notes if not any(k in n for k in used_mech)]
        notes.append(f"Repair cost ${lo:,} to ${hi:,} from the seller's quote of ${quote:,}; "
                     "engine placeholder costs not used.")

    clean = _usd(values.get("clean_wholesale"))
    comps = [c for c in map(_usd, values.get("salvage_comps") or []) if c and c > 0]
    if not clean:
        notes.append("No clean value given; the engine uses its placeholder depreciation curve.")
    storage = _usd(payload.get("storage_cost_per_day"))
    if storage and storage > 0:
        notes.append(f"The seller's storage cost of ${storage:,} a day is added to holding.")

    vehicle = VehicleRecord(
        vin=vin,
        year=year,
        make=str(v.get("make") or "Unknown"),
        model=str(v.get("model") or ""),
        mileage=mileage,
        region=region,
        title_status=title,
        undercarriage_damage=undercarriage,
        engine_audio_abnormal=engine_audio,
        clean_value_cents=clean * 100 if clean else None,
        salvage_comps_cents=[c * 100 for c in comps] or None,
        mechanical_repair_cents=mech,
        repair_override_cents=override,
        repair_done=repair_done,
        storage_cents_per_day=max(0, storage or 0) * 100,
        # An insurer's sale is a claim: repair cost past the state threshold brands the title.
        insurance_claim=s.seller_type == "insurer",
        signals=signals(s, stated_region, a),
        condition=condition,
    )
    return vehicle, findings, notes

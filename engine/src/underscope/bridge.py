"""Bridge from the Underscope web app to the engine.

The app collects a VIN decode, a title, 25 part grades (from OpenAI photo grading or a
reviewer), damage flags, decoded fault codes and market values. This module turns that into
the engine's VehicleRecord + DamageFinding list, runs the decision, and says which marketplace
to send the car to: ACV (repair then sell, or sell as-is) or Copart (salvage).

The body is the reader's Assessment (underscope.assessment, a mirror of reader/src/contract.ts)
plus the app's repair estimate. The facts it adds beyond damage (run status, keys, engine,
flood signs, liens...) become the vehicle's `condition`.

Who decides: the title and the seller's lane limit first; then, when both marketplaces are
allowed and the market values are there, the trained router model (underscope.router, TRAINED ON
SIMULATED OUTCOMES); the dollar simulation otherwise. The simulation always supplies the dollar
ranges, and a model answer it disagrees with is flagged for review.

The question is the marketplace, so: the title and seller decide which exits are allowed
(config `lanes`) before any money is compared; confidence is the chance ACV beats Copart, not
whether two ACV exits overlap; an unknown title is run as clean and as salvage; and missing
market values make the answer "insufficient" rather than a confident placeholder.

Pure functions, no I/O: the endpoint (api/route.py) and the tests call `route`.
"""

from __future__ import annotations

from typing import Any

from underscope import router
from underscope.assessment import Assessment
from underscope.config import Assumptions, default_assumptions
from underscope.decision import (
    LABEL,
    OVERLAP_REASON,
    PATHS,
    _dollars,
    destination_share,
    evaluate,
    simulate,
)
from underscope.models import DamageFinding, Panel, Path, VehicleRecord
from underscope.valuation import copart_relist_ceiling, value_vehicle

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

DAMAGED = ("repairable", "replace")  # app grades that become a finding (config `grades`)

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


def to_engine(payload: dict[str, Any], a: Assumptions | None = None,
              ) -> tuple[VehicleRecord, list[DamageFinding], list[str]]:  # fmt: skip
    """App payload -> (vehicle, findings, notes). Raises ValueError on unusable input."""
    g = (a or default_assumptions())["grades"]
    notes: list[str] = []
    condition = Assessment.model_validate(payload).condition()
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
        if grade not in DAMAGED:
            continue
        if part in PART_PANEL:
            panel, side = PART_PANEL[part]
            findings.append(DamageFinding(panel=panel, damage_type=g[grade]["damage_type"],
                                          severity=g[grade]["severity"],
                                          confidence=g["confidence"], side=side))  # fmt: skip
        elif part in NOT_COSTED:
            notes.append(f"{part.replace('_', ' ')} ({grade}) is not priced by the engine.")
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
        condition=condition,
    )
    return vehicle, findings, notes


def eligible_paths(title_in: str, a: Assumptions, lanes_allowed: list[str] | None = None,
                   ) -> tuple[tuple[Path, ...], list[dict]]:  # fmt: skip
    """Exits this title allows (config `lanes`) within the marketplaces the seller allows
    (`lanes_allowed`, RULES.md S01), and why each other exit is out."""
    lanes = a["lanes"]
    by_title = {Path(p) for p in lanes["by_title"].get(title_in, lanes["by_title"]["clean"])}
    if lanes.get("seller_can_part_out"):
        by_title.add(Path.PART_OUT)
    seller = {x.lower() for x in lanes_allowed or []}
    allowed = {p for p in by_title if not seller or DESTINATION[p].lower() in seller}
    # A limit that leaves nothing the title allows cannot be met; the title wins.
    allowed = allowed or by_title
    name = title_in.replace("_", "-").capitalize()
    why_title = lanes.get("why_excluded", {}).get(title_in) or (
        f"{name} title: exit not allowed (config lanes.by_title).")
    excluded = [{
        "path": p.value, "label": LABEL[p], "destination": DESTINATION[p],
        "reason": ("Part-out is a dismantler's own exit; dismantlers already bid on Copart, so "
                   "their demand is in Copart's price." if p == Path.PART_OUT
                   else why_title if p not in by_title
                   else f"The seller does not allow {DESTINATION[p]}."),
    } for p in PATHS if p not in allowed]  # fmt: skip
    return tuple(p for p in PATHS if p in allowed), excluded


def _confidence(p_acv: float, a: Assumptions) -> str:
    r = a["routing"]
    return "clear" if p_acv >= r["clear_above"] or p_acv <= r["clear_below"] else "close_call"


def _route_title(payload: dict[str, Any], title_in: str, a: Assumptions,
                 model: router.RouterModel | None = None) -> dict[str, Any]:  # fmt: skip
    """Route the car for one known title."""
    vehicle, findings, notes = to_engine(payload, a)
    assessment = Assessment.model_validate(payload)
    paths, excluded = eligible_paths(title_in, a, assessment.lanes_allowed)
    rec = evaluate(vehicle, findings, a, paths)
    val = value_vehicle(vehicle, findings, a)
    # Same seed and inputs as evaluate's run, so these are the same draws.
    p_acv = destination_share(simulate(vehicle, val, a).nets, paths)
    destinations = {DESTINATION[p] for p in paths}
    dollars = lambda c: round(c / 100)  # noqa: E731

    values = payload.get("values") or {}
    comps = [x for x in values.get("salvage_comps") or [] if int(x) > 0]
    missing = []
    if len(destinations) > 1:  # with one marketplace allowed, data can't change the destination
        if not values.get("clean_wholesale"):
            missing.append("clean wholesale value")
        if len(comps) < a["routing"]["min_comps"]:
            missing.append(f"at least {a['routing']['min_comps']} comparable salvage sales")
    # Who decides. One marketplace allowed: the rule. Both allowed and the values are there:
    # the trained model. Otherwise (no model, or not enough data): the simulation.
    winner, p_sim = rec.winner, p_acv
    by_title = eligible_paths(title_in, a)[0]
    decided_by = ("simulation" if len(destinations) > 1 else
                  "title_rule" if len({DESTINATION[p] for p in by_title}) == 1 else "seller_limit")
    if decided_by == "simulation" and not missing and model is not None:
        decided_by = "model"
        p_acv = model.p_acv(router.features(assessment, a))
        dest = "ACV" if p_acv >= a["routing"]["model_acv_at"] else "Copart"
        winner = next(o.path for o in rec.options if DESTINATION[o.path] == dest)
    disagree = DESTINATION[winner] != DESTINATION[rec.winner]
    confidence = "insufficient" if missing else _confidence(p_acv, a)
    if disagree and confidence == "clear":
        confidence = "close_call"

    # The question is the marketplace: two ACV exits overlapping doesn't make it a hard call.
    reasons = [r for r in rec.review_reasons if not r.startswith(OVERLAP_REASON)]
    if confidence == "insufficient":
        reasons.insert(0, f"Not enough market data to choose between ACV and Copart "
                          f"({', '.join(missing)} missing); the engine filled in placeholders.")
    elif disagree:
        reasons.insert(0, f"The model says {DESTINATION[winner]} ({p_acv:.0%} chance ACV nets "
                          f"more) but the dollar simulation prefers {DESTINATION[rec.winner]} "
                          f"({p_sim:.0%}). Treat it as a close call.")
    elif confidence == "close_call":
        by = "outcomes, by the model" if decided_by == "model" else "simulated outcomes"
        reasons.insert(0, f"Close call between ACV and Copart: ACV comes out ahead in "
                          f"{p_acv:.0%} of {by}.")

    checks = []
    if Path.ACV_AS_IS in paths and vehicle.salvage_comps_cents:
        ceiling = copart_relist_ceiling(val, a)
        if val.as_is_value > ceiling:
            checks.append(
                f"The ACV as-is price ({_dollars(val.as_is_value)}) is above what a dealer "
                f"would pay after buying this car on Copart at the comps' middle "
                f"({_dollars(val.salvage_value.expected)}) and relisting it on ACV "
                f"({_dollars(ceiling)} with fees, transport and margin). Check that the comps "
                "match this car's title and damage; the as-is price is a placeholder formula.")

    answer = rec.answer
    if len(paths) == 1 and excluded:
        answer = f"{excluded[0]['reason']} {rec.answer}"
    if disagree:
        answer = (f"{DESTINATION[winner]} by the model, {DESTINATION[rec.winner]} by the dollar "
                  f"simulation: a close call. {rec.answer}")
    if decided_by == "model":
        notes = notes + ["Marketplace chosen by the router model, which is trained on simulated "
                         "outcomes, not real sales (engine/reports/router.md)."]  # fmt: skip
    for e in val.effects:
        what = f"{e.fact.replace('_', ' ')}: {e.value.replace('_', ' ')}"
        notes.append(f"From the description, {what}." if e.chance == 1 else
                     f"Not stated, {what} assumed in {e.chance:.0%} of outcomes.")
    return {
        "destination": DESTINATION[winner],
        "winner": winner.value,
        "winner_label": LABEL[winner],
        "p_acv": round(p_acv, 3),
        "p_acv_simulation": round(p_sim, 3),
        "decided_by": decided_by,
        "model": model.summary() if decided_by == "model" else None,
        "confidence": confidence,
        "verify_first": None,
        "missing": missing,
        "answer": answer,
        "explanation": rec.explanation,
        "needs_human_review": bool(reasons),
        "review_reasons": reasons,
        "total_loss_decides": rec.total_loss_decides,
        "flip_conditions": rec.flip_conditions,
        "options": [{
            "path": o.path.value, "label": LABEL[o.path], "destination": DESTINATION[o.path],
            "expected": dollars(o.expected_cents), "p10": dollars(o.p10_cents),
            "p50": dollars(o.p50_cents), "p90": dollars(o.p90_cents),
        } for o in rec.options],  # fmt: skip
        "excluded": excluded,
        "input_checks": checks,
        "inputs": {"findings": len(findings), "title": vehicle.title_status.value,
                   "undercarriage_damage": vehicle.undercarriage_damage,
                   "engine_audio_abnormal": vehicle.engine_audio_abnormal,
                   "eligible": [p.value for p in paths]},  # fmt: skip
        "notes": notes + ["Engine fees, holding costs and days to sell are PLACEHOLDER "
                          "assumptions (engine/config/assumptions.yaml)."],  # fmt: skip
    }


RANK = {"clear": 0, "close_call": 1, "insufficient": 2}


def route(payload: dict[str, Any], a: Assumptions | None = None,
          model: router.RouterModel | None = None) -> dict[str, Any]:  # fmt: skip
    """Run the engine on an app payload and say which marketplace the car should go to.

    With the default assumptions the saved router model decides (when there is one); with
    custom assumptions it would not match them, so pass a model trained for them or none."""
    if a is None and model is None:
        model = router.load_model()
    a = a or default_assumptions()
    title_in = payload.get("title_status") or "unknown"
    if title_in != "unknown":
        return _route_title(payload, title_in, a, model)

    # Unknown title (RULES.md T11): decide for a clean and a salvage title. If both send the
    # car to the same marketplace the answer stands; otherwise the title must be checked first.
    clean = _route_title({**payload, "title_status": "clean"}, "clean", a, model)
    salvage = _route_title({**payload, "title_status": "salvage"}, "salvage", a, model)
    out = {**clean, "title_branches": {
        k: {key: b[key] for key in ("destination", "winner", "p_acv", "confidence")}
        for k, b in (("clean", clean), ("salvage", salvage))}}  # fmt: skip
    out["inputs"] = {**clean["inputs"], "title": "unknown"}
    out["confidence"] = max(clean["confidence"], salvage["confidence"], key=RANK.get)
    if clean["destination"] == salvage["destination"]:
        out["notes"] = [f"Title not confirmed: {clean['destination']} either way (computed for a "
                        "clean and a salvage title)."] + clean["notes"]  # fmt: skip
        return out
    if out["confidence"] == "clear":
        out["confidence"] = "close_call"
    out["verify_first"] = "Confirm the title brand"
    out["answer"] = (f"Title not confirmed, and it decides the marketplace: {clean['destination']} "
                     f"if it is clean, {salvage['destination']} if it is salvage. Confirm the "
                     "title brand first.")  # fmt: skip
    out["needs_human_review"] = True
    out["review_reasons"] = [f"The title decides the marketplace: {LABEL[Path(clean['winner'])]} "
                             f"if clean, {LABEL[Path(salvage['winner'])]} if salvage."
                             ] + clean["review_reasons"]  # fmt: skip
    out["notes"] = ["Title not confirmed: the numbers shown assume a clean title."] + clean["notes"]
    return out

"""Bridge from the Underscope web app to the engine.

The app sends what the reader took from the seller's description: a title, 25 part grades,
damage flags, market values and the rest of the Assessment. This module turns that into the
engine's VehicleRecord + DamageFinding list, runs the decision, and says which marketplace to
send the car to: ACV (repair then sell, or sell as-is) or Copart (salvage).

The body is the reader's Assessment (underscope.assessment, a mirror of reader/src/contract.ts)
plus the app's repair estimate. The facts it adds beyond damage (run status, keys, engine,
flood signs, liens...) become the vehicle's `condition`.

It runs on the Assessment alone: no VIN is needed, and a year, mileage or state the
description does not give is filled from config `defaults` and said so in the notes.

Who decides: the title, the kind of seller, the seller's lane limit and deadline first; then,
when both marketplaces are allowed and the market values are there, the trained router model
(underscope.router, TRAINED ON SIMULATED OUTCOMES); the dollar simulation otherwise. The
simulation always supplies the dollar ranges, and a model answer it disagrees with is flagged
for review.

The question is the marketplace, so: the title and seller decide which exits are allowed
(config `lanes`) before any money is compared; confidence is the chance ACV beats Copart, not
whether two ACV exits overlap; an unknown title is run as clean and as salvage; and missing
market values make the answer "insufficient" rather than a confident placeholder.

Pure functions, no I/O: the endpoint (api/route.py) and the tests call `route`.
"""

from __future__ import annotations

from typing import Any

from underscope import router
from underscope.assessment import GRADES, Assessment, expectations, precision_level
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
from underscope.intake import (  # noqa: F401  (TITLE, to_engine: used by callers and tests)
    TITLE,
    _usd,
    _year,
    to_engine,
)
from underscope.models import Path, VehicleRecord
from underscope.valuation import copart_relist_ceiling, value_vehicle

DESTINATION = {
    Path.REPAIR_THEN_ACV: "ACV", Path.ACV_AS_IS: "ACV",
    Path.COPART_SALVAGE: "Copart", Path.PART_OUT: "Parts buyer",
}  # fmt: skip


def eligible_paths(title_in: str, a: Assumptions, lanes_allowed: list[str] | None = None,
                   seller_type: str | None = None, facts: tuple[str, ...] = (),
                   ) -> tuple[tuple[Path, ...], list[dict]]:  # fmt: skip
    """Exits the title allows (config `lanes.by_title`), minus those a stated fact rules out
    (`lanes.fact_excludes`, e.g. flood signs), minus those this kind of seller cannot use
    (`lanes.seller_excludes`), within the marketplaces the seller allows (`lanes_allowed`,
    RULES.md S01). Also why each other exit is out."""
    lanes = a["lanes"]
    by_title = {Path(p) for p in lanes["by_title"].get(title_in, lanes["by_title"]["clean"])}
    if lanes.get("seller_can_part_out"):
        by_title.add(Path.PART_OUT)
    fact_cfg = lanes.get("fact_excludes", {})
    hit = [f for f in facts if f in fact_cfg]
    # A rule that leaves no exit cannot be met; the earlier rule wins.
    by_fact = (by_title - {Path(p) for f in hit for p in fact_cfg[f]}) or by_title
    barred = {Path(p) for p in lanes.get("seller_excludes", {}).get(seller_type or "", [])}
    by_seller = (by_fact - barred) or by_fact
    wanted = {x.lower() for x in lanes_allowed or []}
    allowed = {p for p in by_seller if not wanted or DESTINATION[p].lower() in wanted}
    allowed = allowed or by_seller
    name = title_in.replace("_", "-").capitalize()
    why_title = lanes.get("why_excluded", {}).get(title_in) or (
        f"{name} title: exit not allowed (config lanes.by_title).")
    why_seller = lanes.get("why_seller_excluded", {}).get(seller_type or "") or (
        f"A {seller_type} seller cannot use this exit (config lanes.seller_excludes).")
    why_fact = " ".join(lanes.get("why_fact_excluded", {}).get(f)
                        or f"{f}: exit not allowed (config lanes.fact_excludes)." for f in hit)

    def reason(p: Path) -> str:
        if p == Path.PART_OUT:
            return ("Part-out is a dismantler's own exit; dismantlers already bid on Copart, so "
                    "their demand is in Copart's price.")
        if p not in by_title:
            return why_title
        if p not in by_fact:
            return why_fact
        return why_seller if p not in by_seller else f"The seller does not allow {DESTINATION[p]}."

    excluded = [{"path": p.value, "label": LABEL[p], "destination": DESTINATION[p],
                 "reason": reason(p)} for p in PATHS if p not in allowed]  # fmt: skip
    return tuple(p for p in PATHS if p in allowed), excluded


def stated_facts(s: Assessment, a: Assumptions) -> tuple[str, ...]:
    """The flags the description states as true, directly or through a named damage area
    (config `damage_areas.flags`: water damage is a flood sign)."""
    by_area = a["damage_areas"].get("flags", {})
    named = {f for area in (s.primary_damage, s.secondary_damage) for f in by_area.get(area, [])
             if not isinstance(s.flags.get(f), bool)}  # a stated "no flood" is kept
    return tuple(sorted({f for f, v in s.flags.items() if v is True} | named))


def _one_marketplace(paths: tuple[Path, ...]) -> bool:
    return len({DESTINATION[p] for p in paths}) == 1


def expected_days(vehicle: VehicleRecord, val: Any, a: Assumptions) -> dict[Path, float]:
    """Expected days until each exit has sold (repair, selling, title paperwork)."""
    tm = a["timing"]
    extra = sum(e.chance * e.days for e in val.effects)
    fix = 0 if vehicle.repair_done else tm["repair_days"][1]
    return {p: tm["days_to_sell"][p.value][1] + extra + (fix if p == Path.REPAIR_THEN_ACV else 0)
            for p in PATHS}  # fmt: skip


def exits(s: Assessment, title_in: str, vehicle: VehicleRecord, val: Any, a: Assumptions,
          ) -> tuple[tuple[Path, ...], list[dict], str | None, list[str]]:  # fmt: skip
    """The exits left after every rule, the excluded ones with reasons, which rule left a single
    marketplace (None when two remain), and review reasons the rules raise.
    Order: title, stated facts (flood signs), kind of seller, the seller's lane limit, the
    seller's deadline."""
    seller = None if s.seller_type == "unknown" else s.seller_type
    facts = stated_facts(s, a)
    paths, excluded = eligible_paths(title_in, a, s.lanes_allowed, seller, facts)
    rule = None
    for name, stage in (("title_rule", eligible_paths(title_in, a)[0]),
                        ("condition_rule", eligible_paths(title_in, a, None, None, facts)[0]),
                        ("seller_rule", eligible_paths(title_in, a, None, seller, facts)[0]),
                        ("seller_limit", paths)):  # fmt: skip
        if rule is None and _one_marketplace(stage):
            rule = name
    reasons: list[str] = []
    deadline = s.sell_by_days
    if deadline is not None and deadline > 0:
        days = expected_days(vehicle, val, a)
        late = [p for p in paths if days[p] > deadline]
        if len(late) == len(paths):
            fastest = min(paths, key=lambda p: (days[p], PATHS.index(p)))
            late = [p for p in paths if p != fastest]
            reasons.append(f"No exit is expected to sell within the seller's {deadline:g} days; "
                           f"the fastest ({LABEL[fastest]}, about {days[fastest]:.0f} days) is "
                           "kept.")  # fmt: skip
        excluded = excluded + [{
            "path": p.value, "label": LABEL[p], "destination": DESTINATION[p],
            "reason": f"About {days[p]:.0f} days to sell this way; the seller has {deadline:g}.",
        } for p in late]  # fmt: skip
        paths = tuple(p for p in paths if p not in late)
        if rule is None and _one_marketplace(paths):
            rule = "seller_limit"
    return paths, excluded, rule, reasons


def _unmet_limit(s: Assessment, title_in: str, a: Assumptions) -> str | None:
    """The sentence for a seller's lane limit that the title or the kind of seller rules out."""
    wanted = [x.lower() for x in s.lanes_allowed or []]
    if not wanted:
        return None
    seller = None if s.seller_type == "unknown" else s.seller_type
    facts = stated_facts(s, a)
    by_title = eligible_paths(title_in, a)[0]
    by_fact = eligible_paths(title_in, a, None, None, facts)[0]
    left = eligible_paths(title_in, a, None, seller, facts)[0]
    if any(DESTINATION[p].lower() in wanted for p in left):
        return None
    names = {"acv": "ACV", "copart": "Copart"}
    only = " and ".join(names.get(x, x) for x in wanted)
    if not any(DESTINATION[p].lower() in wanted for p in by_title):
        why = f"a {title_in.replace('_', '-')} title cannot be listed there"
    elif not any(DESTINATION[p].lower() in wanted for p in by_fact):
        why = "a vehicle with stated flood signs cannot be listed there (policy not confirmed)"
    else:
        sellers = {"individual": "a private seller", "insurer": "an insurer"}
        who = sellers.get(seller or "", "this seller")
        why = f"{who} cannot list there (dealer-to-dealer; policy not confirmed)"
    exit_ = " and ".join(sorted({DESTINATION[p] for p in left}))
    return (f"The seller allows only {only}, but {why}; {exit_} is the only exit. "
            "Confirm with the seller.")


def _confidence(p_acv: float, a: Assumptions) -> str:
    r = a["routing"]
    return "clear" if p_acv >= r["clear_above"] or p_acv <= r["clear_below"] else "close_call"


# Condition fact -> where the reader keeps the seller's words for it (Assessment.evidence).
EVIDENCE_PATH = {"engine": "engine_condition", "transmission": "transmission_condition",
                 "flood_suspected": "flags.flood_suspected", "fire_damage": "flags.fire_damage",
                 "airbags_deployed": "flags.airbags_deployed"}  # fmt: skip


def nothing_to_go_on(s: Assessment) -> bool:
    """No title, no values, no graded part, no run status and no damage area: no answer."""
    graded = any(isinstance(g, dict) and g.get("grade") in GRADES for g in s.grades)
    values = s.values.get("clean_wholesale") or s.values.get("salvage_comps")
    return (s.title_status == "unknown" and not values and not graded
            and s.run_status == "unknown" and s.primary_damage == "unknown")  # fmt: skip


def _route_title(payload: dict[str, Any], title_in: str, a: Assumptions,
                 model: router.RouterModel | None = None, bare: bool = False,
                 ) -> dict[str, Any]:  # fmt: skip
    """Route the car for one known title. `bare`: the description gives nothing to go on."""
    vehicle, findings, notes = to_engine(payload, a)
    assessment = Assessment.model_validate(payload)
    val = value_vehicle(vehicle, findings, a)
    paths, excluded, rule, rule_reasons = exits(assessment, title_in, vehicle, val, a)
    rec = evaluate(vehicle, findings, a, paths)
    # Same seed and inputs as evaluate's run, so these are the same draws.
    nets = simulate(vehicle, val, a).nets
    p_acv = destination_share(nets, paths)
    dollars = lambda c: round(c / 100)  # noqa: E731

    values = payload.get("values") or {}
    comps = [c for c in map(_usd, values.get("salvage_comps") or []) if c and c > 0]
    missing = []
    if rule is None:  # with one marketplace allowed, data can't change the destination
        if not _usd(values.get("clean_wholesale")):
            missing.append("clean wholesale value")
            if _year(payload) is None:
                missing.append("vehicle year (or a VIN)")
        if len(comps) < a["routing"]["min_comps"]:
            missing.append(f"at least {a['routing']['min_comps']} comparable salvage sales")
    # Who decides. One marketplace allowed: the rule that left it. Both allowed and the values
    # are there: the trained model. Otherwise (no model, or not enough data): the simulation.
    winner, p_sim = rec.winner, p_acv
    decided_by = rule or "simulation"
    bare = bare and rule is None  # a rule's answer does not need the missing facts
    # With the clean value and the comps given, the simulation prices the car from the seller's
    # own numbers and decides. Without them it runs on placeholders, so the model answers: it
    # is trained on input with the gaps the reader's output has. Measured 2026-11-16 on 2,890
    # fresh made-up cars against the full-information answer: every fact given, simulation
    # 99.4% and model 91.0%; clean value missing, simulation 47.7% and model 69.0%.
    if decided_by == "simulation" and model is not None and not bare and missing:
        decided_by = "model"
        p_acv = model.p_acv(router.features(assessment, a))
        dest = "ACV" if p_acv >= a["routing"]["model_acv_at"] else "Copart"
        winner = next(o.path for o in rec.options if DESTINATION[o.path] == dest)
    disagree = DESTINATION[winner] != DESTINATION[rec.winner]
    insufficient = bare or (bool(missing) and decided_by != "model")
    confidence = "insufficient" if insufficient else _confidence(p_acv, a)
    if disagree and confidence == "clear":
        confidence = "close_call"

    # The question is the marketplace: two ACV exits overlapping doesn't make it a hard call.
    reasons = [r for r in rec.review_reasons if not r.startswith(OVERLAP_REASON)] + rule_reasons
    if assessment.already_repaired == "partly":
        reasons.append("The seller says the damage is partly repaired; the repair estimate "
                       "still counts all of it. Confirm what is left to do.")
    if bare:
        reasons.insert(0, "The description gives nothing to go on: no title, no values, no "
                          "damaged part, no run status and no damage area.")
    elif confidence == "insufficient":
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

    # A lane limit the seller set that an earlier rule makes impossible is never dropped
    # silently: the destination stands, and a person confirms it with the seller.
    unmet = _unmet_limit(assessment, title_in, a)
    if unmet:
        reasons.insert(0, unmet)

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
    # The seller's lowest acceptable price and the price paid: reported per exit, never a rule.
    reserve, paid = _usd(values.get("reserve_price")), _usd(values.get("purchase_price"))
    meets = {p: float((nets[p] >= reserve * 100).mean()) for p in paths} if reserve else {}
    if reserve and meets[winner] < a["routing"]["reserve_warn_below"]:
        checks.append(f"{LABEL[winner].capitalize()} nets the seller's lowest price of "
                      f"${reserve:,} or more in only {meets[winner]:.0%} of simulated outcomes.")

    answer = rec.answer
    if len(paths) == 1 and excluded:
        why = next((e["reason"] for e in excluded if e["path"] != Path.PART_OUT.value),
                   excluded[0]["reason"])  # fmt: skip
        answer = f"{why} {rec.answer}"
    if disagree:
        answer = (f"{DESTINATION[winner]} by the model, {DESTINATION[rec.winner]} by the dollar "
                  f"simulation: a close call. {rec.answer}")
    if unmet:
        answer = f"{unmet} {answer}"
    if decided_by == "model":
        notes = notes + ["Marketplace chosen by the router model, which is trained on simulated "
                         "outcomes, not real sales (engine/reports/router.md)."]  # fmt: skip
    rough = not _usd(values.get("clean_wholesale"))
    if rough:
        notes = notes + ["The dollar ranges are rough: without a clean value they rest on the "
                         "engine's placeholder value curve."]  # fmt: skip
    for e in val.effects:
        if e.fact == "signal":
            notes.append(f"From the description, {e.value}: counted as a repair or delay in "
                         f"{e.chance:.0%} of outcomes.")
            continue
        what = f"{e.fact.replace('_', ' ')}: {e.value.replace('_', ' ')}"
        quote = assessment.evidence.get(EVIDENCE_PATH.get(e.fact, e.fact))
        said = f' ("{quote}")' if isinstance(quote, str) and quote else ""
        notes.append(f"From the description{said}, {what}." if e.chance == 1 else
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
        "verify_first": "Confirm the seller's marketplace limit" if unmet else None,
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
            "p_meets_reserve": round(meets[o.path], 3) if reserve else None,
            "vs_purchase": dollars(o.expected_cents) - paid if paid else None,
        } for o in rec.options],  # fmt: skip
        "excluded": excluded,
        "ranges_are_rough": rough,
        "input_checks": checks,
        "inputs": {"findings": len(findings), "title": vehicle.title_status.value,
                   "undercarriage_damage": vehicle.undercarriage_damage,
                   "engine_audio_abnormal": vehicle.engine_audio_abnormal,
                   "eligible": [p.value for p in paths]},  # fmt: skip
        "notes": notes + ["Engine fees, holding costs and days to sell are PLACEHOLDER "
                          "assumptions (engine/config/assumptions.yaml)."],  # fmt: skip
    }


RANK = {"clear": 0, "close_call": 1, "insufficient": 2}
# Fields whose two readings (the reader's `conflicts`) make the decision less certain.
DECISION_FIELDS = ("title_status", "run_status", "seller_type", "lanes_allowed", "keys",
                   "engine_condition", "transmission_condition")  # fmt: skip
DECISION_PREFIXES = ("flags.", "grades.", "values.")


def _reader_meta(out: dict[str, Any], payload: dict[str, Any],
                 model: router.RouterModel | None) -> dict[str, Any]:  # fmt: skip
    """What the reader says about its own reading: how much of what it expected was given (the
    precision of the answer), what to ask the seller, and fields it read two ways."""
    s = Assessment.model_validate(payload)
    v = s.vehicle
    out["reader"] = s.reader
    out["vehicle"] = {"vin": s.vin, **{k: v.get(k) for k in ("year", "make", "model", "trim")}}
    out["reader_missing"], out["could_add"] = s.missing, s.could_add
    out["questions"], out["not_read"] = s.questions, s.additional

    expected = s.expected or expectations(s)
    open_ = [e for e in expected if not e.get("given")]
    needed = [e for e in open_ if e.get("need") == "needed"]
    level = (s.precision or {}).get("level")
    if level not in ("full", "reduced", "low"):
        # A body without the reader's own count (the page before the reader sent it): low only
        # when the engine itself is missing what it needs.
        level = ("low" if out["missing"] else
                 "full" if precision_level(expected) == "full" else "reduced")
    note = (s.precision or {}).get("note")
    if not note and open_:
        note = (f"The answer wouldn't be as precise: {len(open_)} of the {len(expected)} facts "
                "the reader was expecting were not given"
                + (f" ({len(needed)} of them needed for the decision)." if needed else "."))
    # How often the engine, answering as it does here, named the same marketplace as the
    # simulation with everything known (router.policy_check on fresh made-up cars). An older
    # model file has only the model's own held-out figure.
    agreement = None
    answered = out["decided_by"] in ("model", "simulation") and out["confidence"] != "insufficient"
    if answered and model is not None:
        meta = getattr(model, "meta", None) or {}
        measured = meta.get("deployed") or (
            meta.get("held_out", {}) if out["decided_by"] == "model" else {})
        agreement = (measured.get("by_level", {}).get(level) or {}).get("agreement")
    if agreement is not None:
        note = ((note + " ") if note else "") + (
            f"With this much information the engine matched the full-information answer in "
            f"{agreement:.0%} of test cars.")
    out["precision"] = {
        "level": level, "note": note, "agreement": agreement,
        "not_given": [e.get("ask") for e in needed]
                     + [e.get("ask") for e in open_ if e.get("need") != "needed"],
    }  # fmt: skip
    # A needed fact is missing: the marketplace can still be named, never as a clear call.
    # (A rule's answer does not depend on the missing facts, so it keeps its confidence.)
    by_rule = out["decided_by"] in ("title_rule", "condition_rule", "seller_rule", "seller_limit")
    if level == "low" and out["confidence"] == "clear" and not by_rule:
        out["confidence"] = "close_call"
        out["review_reasons"] = out["review_reasons"] + [
            "Facts needed for the decision are not given, so this is not a clear call."]
        out["needs_human_review"] = True
    if s.questions:
        out["notes"] = out["notes"] + [f"The reader has {len(s.questions)} open question(s) for "
                                       "the seller (see questions)."]  # fmt: skip

    for c in s.conflicts:
        field = str(c.get("field") or "")
        if field not in DECISION_FIELDS and not field.startswith(DECISION_PREFIXES):
            continue
        name = field.split(".")[-1].replace("_", " ")
        out["review_reasons"] = out["review_reasons"] + [
            f"The description can be read two ways for {name}: {c.get('kept')} (used) or "
            f"{c.get('dropped')}."]  # fmt: skip
        out["needs_human_review"] = True
        if out["confidence"] == "clear":
            out["confidence"] = "close_call"
        out["verify_first"] = out["verify_first"] or f"Confirm {name}"
    return out


def route(payload: dict[str, Any], a: Assumptions | None = None,
          model: router.RouterModel | None = None) -> dict[str, Any]:  # fmt: skip
    """Run the engine on an app payload and say which marketplace the car should go to.

    With the default assumptions the saved router model decides (when there is one); with
    custom assumptions it would not match them, so pass a model trained for them or none."""
    if a is None and model is None:
        model = router.load_model()
    a = a or default_assumptions()
    return _reader_meta(_route(payload, a, model), payload, model)


def _route(payload: dict[str, Any], a: Assumptions,
           model: router.RouterModel | None) -> dict[str, Any]:  # fmt: skip
    title_in = payload.get("title_status") or "unknown"
    if title_in not in TITLE:
        title_in = "unknown"
    if title_in != "unknown":
        return _route_title(payload, title_in, a, model)
    bare = nothing_to_go_on(Assessment.model_validate(payload))

    # Unknown title (RULES.md T11): decide for a clean and a salvage title. If both send the
    # car to the same marketplace the answer stands; otherwise the title must be checked first.
    clean = _route_title({**payload, "title_status": "clean"}, "clean", a, model, bare)
    if bare:  # nothing to go on: no branch means anything, so no title question either
        clean["inputs"] = {**clean["inputs"], "title": "unknown"}
        return clean
    salvage = _route_title({**payload, "title_status": "salvage"}, "salvage", a, model, bare)
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

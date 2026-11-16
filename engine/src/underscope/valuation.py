"""Valuation: damage findings + vehicle -> values and repair costs. All money in cents."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import NamedTuple

from underscope.config import Assumptions, default_assumptions
from underscope.models import DamageFinding, TitleStatus, VehicleRecord


class Range(NamedTuple):
    low: int
    expected: int
    high: int


@dataclass(frozen=True)
class Effect:
    """One fact from the seller's description and what it does (config `condition`).
    chance is 1.0 for a stated fact; for an unknown one it is the share of simulated outcomes
    in which the bad value applies."""

    fact: str
    value: str
    chance: float
    repair: Range | None = None  # cents added to the repair cost
    acv_as_is: Range | None = None  # price multipliers
    repaired: Range | None = None
    copart: Range | None = None
    tow: Range | None = None  # cents added to ACV as-is transport
    days: int = 0  # holding days added to every exit


def condition_effects(vehicle: VehicleRecord, a: Assumptions) -> tuple[Effect, ...]:
    """Effects of vehicle.condition, in the config's fact order. None when there is no condition."""
    c = vehicle.condition
    if c is None:
        return ()
    cfg = a["condition"]
    cause_known = "failed" in (c.engine, c.transmission)
    out = []
    for fact, by_value in cfg["effects"].items():
        value, chance = c.stated(fact), 1.0
        if value is None:
            unknown = cfg["unknown"].get(fact)
            if not unknown:
                continue
            value, chance = str(unknown["value"]), unknown["chance_pct"] / 100
        e = by_value.get(value)
        if not e or chance <= 0:
            continue
        kinds = ("repair_cents", "acv_as_is", "repaired", "copart", "tow_cents")
        rng = {k: Range(*e[k]) if k in e else None for k in kinds}
        if fact == "airbags_deployed" and vehicle.repair_override_cents:
            continue  # the caller's repair estimate already has the airbags
        if fact == "run_status" and cause_known:
            rng["repair_cents"] = None  # the failed engine or transmission is the repair
        if vehicle.salvage_comps_cents:
            rng["copart"] = None  # comps are taken to match the car
        out.append(Effect(fact, value, chance, rng["repair_cents"], rng["acv_as_is"],
                          rng["repaired"], rng["copart"], rng["tow_cents"],
                          int(e.get("days", 0))))  # fmt: skip
    return tuple(out)


@dataclass(frozen=True)
class Valuation:
    clean_value: int
    as_is_value: int
    repaired_value: int  # before title factor
    repair_cost: Range
    salvage_value: Range
    parts_gross_value: Range
    title_factor_after_repair: float
    title_after_repair: TitleStatus
    repair_ratio: float  # expected repair cost / clean value
    total_loss_threshold: float  # ratio (0.75 = 75%)
    mean_confidence: float  # 1.0 when there are no findings
    # Condition effects, applied per draw in the simulation. repair_cost above is the damage
    # estimate alone; the as-is price, repaired value and repair ratio already count the
    # expected cost and price effect of these.
    effects: tuple[Effect, ...] = field(default=())
    repair_scale: float = 1.0  # the repair_cost_scale this was valued with (flip search)


def clean_value(vehicle: VehicleRecord, a: Assumptions) -> int:
    if vehicle.clean_value_cents is not None:
        return vehicle.clean_value_cents
    b = a["base_value"]
    age = max(0, b["reference_year"] - vehicle.year)
    value = b["new_value_cents"] * (1 - b["depreciation_pct_per_year"] / 100) ** age
    value -= b["cents_per_mile"] * vehicle.mileage
    return max(b["floor_cents"], round(value))


def repair_cost(findings: list[DamageFinding], a: Assumptions) -> Range:
    rc = a["repair_cost"]
    lo = ex = hi = 0.0
    for f in findings:
        base = rc["panel_base_cents"][f.panel.value]
        mult = rc["damage_type_multiplier"][f.damage_type.value]
        sev = rc["min_severity_factor"] + (1 - rc["min_severity_factor"]) * f.severity
        scale = mult * sev
        # Low-confidence findings may not exist: shrink low/expected, keep the high tail.
        lo += base[0] * scale * f.confidence
        ex += base[1] * scale * f.confidence
        hi += base[2] * scale
    return Range(round(lo), round(ex), round(hi))


def parts_damage_loss(findings: list[DamageFinding], a: Assumptions) -> float:
    """Fraction of parts value lost to damage (0-1). Each panel loses at most its share."""
    p = a["parts"]
    lost: dict[str, float] = {}
    for f in findings:
        share = p["panel_share_of_parts_value"][f.panel.value]
        frac = p["damage_type_loss_factor"][f.damage_type.value] * f.severity * f.confidence
        lost[f.panel.value] = min(share, lost.get(f.panel.value, 0.0) + share * frac)
    return min(1.0, sum(lost.values()))


def title_after_repair(
    vehicle: VehicleRecord, repair_ratio: float, threshold: float, a: Assumptions
) -> TitleStatus:
    if vehicle.title_status == TitleStatus.SALVAGE:
        return TitleStatus.REBUILT
    if vehicle.title_status == TitleStatus.REBUILT:
        return TitleStatus.REBUILT
    if vehicle.insurance_claim and repair_ratio >= threshold:
        return TitleStatus(a["title"]["brand_after_total_loss_repair"])
    return TitleStatus.CLEAN


def copart_relist_ceiling(val: Valuation, a: Assumptions) -> int:
    """Most a dealer should pay for this car as-is on ACV when the same car sells on Copart at
    the middle of the salvage band: that price plus Copart's buyer fee, transport and the dealer's
    flip margin, grossed up for ACV's seller fee on the relist. The mirror of the as-is floor in
    value_vehicle (buy on ACV, resell on Copart). An as-is estimate above it means the comps and
    the as-is formula disagree about the car."""
    s = val.salvage_value.expected
    cf, af, m = a["fees"]["copart"], a["fees"]["acv"], a["market"]
    buyer_fee = cf["buyer_flat_cents"] + s * cf["buyer_pct_of_price"] / 100
    margin = s * m["as_is_dealer_flip_margin_pct"] / 100
    cost = s + buyer_fee + a["transport"]["copart_cents"][1] + margin
    return round((cost + af["flat_cents"]) / (1 - af["pct_of_price"] / 100))


def value_vehicle(
    vehicle: VehicleRecord,
    findings: list[DamageFinding],
    a: Assumptions | None = None,
    repair_cost_scale: float = 1.0,
) -> Valuation:
    """repair_cost_scale rescales the repair estimate everywhere it feeds in (as-is value,
    repair ratio, title brand); used to find where the decision flips."""
    a = a or default_assumptions()
    clean = clean_value(vehicle, a)
    body = repair_cost(findings, a)
    if vehicle.repair_override_cents:
        body = Range(*sorted(vehicle.repair_override_cents))
    elif vehicle.mechanical_repair_cents:
        lo, hi = sorted(vehicle.mechanical_repair_cents)
        body = Range(body.low + lo, body.expected + (lo + hi) // 2, body.high + hi)
    rep = Range(*(round(x * repair_cost_scale) for x in body))
    effects = condition_effects(vehicle, a)
    # Expected repair including what the description adds (a stated failed engine in full, an
    # unknown one by its chance). The simulation draws these per outcome.
    rep_expected = rep.expected + round(
        sum(e.chance * e.repair.expected for e in effects if e.repair) * repair_cost_scale)
    m = a["market"]
    title = {k: r[1] for k, r in a["title"]["factor"].items()}  # expected factor per status

    as_is = max(
        round(clean * m["as_is_floor_fraction"]),
        clean - round(m["as_is_discount_multiple_of_repair"] * rep_expected),
    )
    as_is = round(as_is * title[vehicle.title_status.value])
    # Damage score: expected repair cost as a share of clean value, capped at 1.
    damage_score = min(1.0, rep_expected / clean) if clean else 1.0
    haircut = m["repaired_value_haircut_pct_at_total_damage"] / 100 * damage_score
    repaired = round(clean * (1 - haircut))

    if vehicle.salvage_comps_cents:
        # Real sold prices for comparable damaged vehicles beat the placeholder fraction.
        comps = sorted(vehicle.salvage_comps_cents)
        salvage = Range(comps[0], comps[len(comps) // 2], comps[-1])
    else:
        adj = 1 - m["salvage_damage_adjust_pct_per_unit_severity"] / 100 * damage_score
        salvage = Range(*(round(clean * frac * adj) for frac in m["salvage_fraction_of_clean"]))

    # A dealer buying on ACV can always resell the car to salvage, so as-is never prices far
    # below salvage. But that dealer then pays Copart's fee and transport and wants a margin,
    # so the floor is salvage minus those costs, not salvage itself. (Flooring at full salvage
    # let ACV's lower fees beat Copart for every wreck, so Copart could never win.)
    cf, ct = a["fees"]["copart"], a["transport"]["copart_cents"]
    flip_cost = (cf["flat_cents"] + ct[1] + salvage.expected * cf["pct_of_price"] / 100
                 + salvage.expected * m.get("as_is_dealer_flip_margin_pct", 10) / 100)  # fmt: skip
    as_is = max(as_is, round(salvage.expected - flip_cost))

    p = a["parts"]
    penalty = 1.0 - parts_damage_loss(findings, a)
    if vehicle.engine_audio_abnormal:
        penalty *= 1 - p["engine_audio_abnormal_value_penalty_pct"] / 100
    parts = Range(*(round(clean * frac * penalty) for frac in p["gross_value_fraction_of_clean"]))

    ratio = rep_expected / clean if clean else 1.0
    threshold = a.total_loss_threshold_pct(vehicle.region) / 100
    t_after = title_after_repair(vehicle, ratio, threshold, a)
    conf = sum(f.confidence for f in findings) / len(findings) if findings else 1.0
    return Valuation(
        clean_value=clean,
        as_is_value=as_is,
        repaired_value=repaired,
        repair_cost=rep,
        salvage_value=salvage,
        parts_gross_value=parts,
        title_factor_after_repair=float(title[t_after.value]),
        title_after_repair=t_after,
        repair_ratio=ratio,
        total_loss_threshold=threshold,
        mean_confidence=conf,
        effects=effects,
        repair_scale=repair_cost_scale,
    )

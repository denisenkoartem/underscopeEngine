"""Decision engine: seeded Monte Carlo of net proceeds per disposition path.

All money is integer cents. Random draws are rounded to cents immediately and the rest of
the arithmetic is integer, so component sums are exact per draw.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import NamedTuple

import numpy as np

from underscope.config import Assumptions, default_assumptions
from underscope.models import (
    DamageFinding,
    DispositionOption,
    Path,
    Recommendation,
    TitleStatus,
    VehicleRecord,
)
from underscope.valuation import Range, Valuation, value_vehicle

PATHS = (Path.REPAIR_THEN_ACV, Path.ACV_AS_IS, Path.COPART_SALVAGE, Path.PART_OUT)


@dataclass
class SimResult:
    nets: dict[Path, np.ndarray]  # int64 cents, one entry per draw
    components: dict[Path, dict[str, np.ndarray]] = field(default_factory=dict)
    branded_share: float = 0.0  # share of draws where repair triggered a title brand


def _tri(rng: np.random.Generator, r: Range | list[int] | tuple, n: int) -> np.ndarray:
    """Triangular draw over (low, mode, high); float array."""
    lo, mode, hi = (float(x) for x in r)
    if hi <= lo:
        return np.full(n, lo)
    return rng.triangular(lo, mode, hi, n)


def _tri_ppf(u: np.ndarray, r: Range | list[float]) -> np.ndarray:
    """Triangular inverse CDF: maps shared uniforms onto (low, mode, high)."""
    lo, mode, hi = (float(x) for x in r)
    if hi <= lo:
        return np.full(u.shape, lo)
    c = (mode - lo) / (hi - lo)
    left = lo + np.sqrt(u * (hi - lo) * (mode - lo))
    right = hi - np.sqrt((1 - u) * (hi - lo) * (hi - mode))
    return np.where(u < c, left, right)


def _cents(x: np.ndarray) -> np.ndarray:
    return np.rint(x).astype(np.int64)


def _pct(price: np.ndarray, pct: float) -> np.ndarray:
    return _cents(price * pct / 100.0)


def simulate(
    vehicle: VehicleRecord,
    val: Valuation,
    a: Assumptions,
    draws: int | None = None,
    seed: int | None = None,
    force_title: TitleStatus | None = None,
) -> SimResult:
    """Draw net proceeds for every path.

    force_title sets the repaired title on the repair path (used to test whether the
    total-loss threshold decides the outcome). On an insurance claim, forcing a branded
    title also means the insurer totaled the car, so the as-is sale carries a salvage title.
    """
    sim = a["simulation"]
    n = draws or sim["draws"]
    rng = np.random.default_rng(sim["seed"] if seed is None else seed)
    fees, tr, tm = a["fees"], a["transport"], a["timing"]

    # All random variables are drawn up front, in a fixed order, so every path sees the same
    # market shock (common random numbers) and results are reproducible.
    market = rng.lognormal(0.0, sim["value_noise_sigma"], n)
    rep = _cents(_tri(rng, val.repair_cost, n))
    salv = _tri(rng, val.salvage_value, n)
    parts_gross = _tri(rng, val.parts_gross_value, n)
    sell_through = _tri(rng, a["parts"]["sell_through"], n)
    teardown = _cents(_tri(rng, a["parts"]["teardown_labor_cents"], n))
    t_acv = _cents(_tri(rng, tr["acv_cents"], n))
    t_cop = _cents(_tri(rng, tr["copart_cents"], n))
    t_parts = _cents(_tri(rng, tr["parts_cents"], n))
    repair_days = np.rint(_tri(rng, tm["repair_days"], n)).astype(np.int64)
    days = {p: np.rint(_tri(rng, tm["days_to_sell"][p.value], n)).astype(np.int64) for p in PATHS}
    # Title discounts are uncertain too. One shared uniform per draw moves every status's
    # factor together (a soft or strong branded-title market), so paths stay comparable.
    u_title = rng.random(n)
    factors = {t: _tri_ppf(u_title, a["title"]["factor"][t.value]) for t in TitleStatus}

    hold = tm["holding_cost_per_day_cents"]
    nets: dict[Path, np.ndarray] = {}
    comps: dict[Path, dict[str, np.ndarray]] = {}

    # 1. Repair, then sell on ACV.
    clean_shocked = val.clean_value * market
    if force_title is not None:
        title_factor = factors[force_title]
        branded = np.full(n, vehicle.insurance_claim and force_title != TitleStatus.CLEAN)
    elif vehicle.title_status != TitleStatus.CLEAN or not vehicle.insurance_claim:
        title_factor = factors[val.title_after_repair]
        branded = np.zeros(n, dtype=bool)
    else:
        # Insurance claim on a clean title: the insurer totals the car when repair cost crosses
        # the threshold, evaluated per draw against the (shocked) clean value.
        branded = rep >= val.total_loss_threshold * clean_shocked
        brand = TitleStatus(a["title"]["brand_after_total_loss_repair"])
        title_factor = np.where(branded, factors[brand], factors[TitleStatus.CLEAN])
    sale = _cents(val.repaired_value * market * title_factor)
    fee = _cents(fees["acv"]["flat_cents"] + _pct(sale, fees["acv"]["pct_of_price"]))
    holding = (repair_days + days[Path.REPAIR_THEN_ACV]) * hold
    h = a["hidden_damage"]
    reserve = _pct(rep.astype(float), h["reserve_pct_of_repair"])
    for flag, extra in (
        (vehicle.undercarriage_damage, h["undercarriage_extra_cents"]),
        (vehicle.engine_audio_abnormal, h["engine_audio_extra_cents"]),
    ):
        reserve = reserve + (h["unknown_flag_extra_cents"] if flag is None else extra * int(flag))
    if vehicle.repair_override_cents:
        # The caller's estimate already widened for unseen damage; don't reserve for it twice.
        reserve = np.zeros(n)
    nets[Path.REPAIR_THEN_ACV] = sale - rep - fee - t_acv - holding - reserve
    comps[Path.REPAIR_THEN_ACV] = {
        "sale_price": sale, "repair_cost": -rep, "acv_fees": -fee, "transport": -t_acv,
        "holding": -holding, "hidden_damage_reserve": -reserve,
    }  # fmt: skip

    # 2. Sell as-is on ACV. as_is_value carries the expected title factor; rescale per draw.
    # In draws where the insurer totals the car, the buyer gets a salvage certificate. A dealer
    # can always resell the car to salvage, so the as-is sale never falls far below the salvage
    # sale: the floor is the salvage sale minus what that dealer pays to flip it (Copart fee,
    # transport, margin). Flooring at the full salvage sale let ACV's lower fees win every wreck.
    expected_tf = a["title"]["factor"][vehicle.title_status.value][1]
    as_is_tf = np.where(branded, factors[TitleStatus.SALVAGE], factors[vehicle.title_status])
    salvage_sale = _cents(salv * market)
    cf = fees["copart"]
    flip_cost = (cf["flat_cents"] + _pct(salvage_sale, cf["pct_of_price"]) + t_cop
                 + _pct(salvage_sale, a["market"].get("as_is_dealer_flip_margin_pct", 10)))
    sale = np.maximum(_cents(val.as_is_value * market * as_is_tf / expected_tf),
                      _cents(salvage_sale - flip_cost))
    fee = _cents(fees["acv"]["flat_cents"] + _pct(sale, fees["acv"]["pct_of_price"]))
    holding = days[Path.ACV_AS_IS] * hold
    nets[Path.ACV_AS_IS] = sale - fee - t_acv - holding
    comps[Path.ACV_AS_IS] = {
        "sale_price": sale, "acv_fees": -fee, "transport": -t_acv, "holding": -holding,
    }  # fmt: skip

    # 3. Sell as salvage on Copart.
    sale = salvage_sale
    fee = _cents(fees["copart"]["flat_cents"] + _pct(sale, fees["copart"]["pct_of_price"]))
    holding = days[Path.COPART_SALVAGE] * hold
    nets[Path.COPART_SALVAGE] = sale - fee - t_cop - holding
    comps[Path.COPART_SALVAGE] = {
        "sale_price": sale, "copart_fees": -fee, "transport": -t_cop, "holding": -holding,
    }  # fmt: skip

    # 4. Part out.
    revenue = _cents(parts_gross * market * sell_through)
    storage = days[Path.PART_OUT] * a["parts"]["storage_cents_per_day"]
    nets[Path.PART_OUT] = revenue - teardown - storage - t_parts
    comps[Path.PART_OUT] = {
        "parts_revenue": revenue, "teardown_labor": -teardown, "storage": -storage,
        "transport": -t_parts,
    }  # fmt: skip
    return SimResult(nets, comps, float(branded.mean()))


def p_not_best(nets: dict[Path, np.ndarray], winner: Path) -> float:
    """Share of paired draws in which some other path nets more than the winner."""
    rivals = np.max(np.stack([nets[p] for p in PATHS if p != winner]), axis=0)
    return float(np.mean(rivals > nets[winner]))


def _winner(nets: dict[Path, np.ndarray]) -> Path:
    return max(PATHS, key=lambda p: (int(round(nets[p].mean())), -PATHS.index(p)))


def _dollars(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}${abs(cents) / 100:,.0f}"


LABEL = {
    Path.REPAIR_THEN_ACV: "repair then sell on ACV",
    Path.ACV_AS_IS: "sell as-is on ACV",
    Path.COPART_SALVAGE: "sell as salvage on Copart",
    Path.PART_OUT: "part out",
}


def _options(sim: SimResult) -> list[DispositionOption]:
    opts = []
    for p in PATHS:
        x = sim.nets[p]
        p10, p50, p90 = (int(round(v)) for v in np.percentile(x, [10, 50, 90]))
        opts.append(
            DispositionOption(
                path=p,
                expected_cents=int(round(x.mean())),
                p10_cents=p10,
                p50_cents=p50,
                p90_cents=p90,
                components={k: int(round(v.mean())) for k, v in sim.components[p].items()},
            )
        )
    # Rank by expected margin; ties keep the canonical path order.
    return sorted(opts, key=lambda o: (-o.expected_cents, PATHS.index(o.path)))


class RepairFlip(NamedTuple):
    # (repair-cost scale, new winner) at the nearest flip below and above 1x; None if no flip.
    down: tuple[float, Path] | None
    up: tuple[float, Path] | None


FLIP_SCALE_MAX = 3.0


def repair_cost_flip(
    vehicle: VehicleRecord, findings: list[DamageFinding], a: Assumptions, iters: int = 14
) -> RepairFlip:
    """Find where rescaling the repair estimate changes the winner, by bisection.

    Repair cost moves several paths at once (repair net, as-is value, title brand), so the
    flip point is found by re-running valuation and simulation, not by a closed form.
    """

    def winner(k: float) -> Path:
        return _winner(simulate(vehicle, value_vehicle(vehicle, findings, a, k), a).nets)

    base = winner(1.0)

    def search(lo: float, hi: float) -> tuple[float, Path] | None:
        # lo keeps the base winner; returns the scale nearest lo where it changes.
        if winner(hi) == base:
            return None
        for _ in range(iters):
            mid = (lo + hi) / 2
            if winner(mid) == base:
                lo = mid
            else:
                hi = mid
        return hi, winner(hi)

    return RepairFlip(search(1.0, 0.0), search(1.0, FLIP_SCALE_MAX))


def _flip_conditions(
    ranked: list[DispositionOption],
    a: Assumptions,
    vehicle: VehicleRecord,
    val: Valuation,
    flip: RepairFlip,
) -> list[str]:
    win, run = ranked[0], ranked[1]
    gap = win.expected_cents - run.expected_cents
    out = []
    est = val.repair_cost.expected
    if est > 0:
        for side, verb in ((flip.down, "fell"), (flip.up, "rose")):
            if side:
                k, new = side
                out.append(
                    f"If expected repair cost {verb} from {_dollars(est)} to about "
                    f"{_dollars(round(est * k))} ({k - 1:+.0%}), {LABEL[new]} would win."
                )
        if not flip.down and not flip.up:
            out.append(
                f"No repair cost between $0 and {FLIP_SCALE_MAX:.0f}x the estimate changes "
                "the winner."
            )

    # Price levers move one path's sale price only, so the closed form is exact there.
    fee_pct = {
        Path.ACV_AS_IS: a["fees"]["acv"]["pct_of_price"],
        Path.COPART_SALVAGE: a["fees"]["copart"]["pct_of_price"],
    }
    for opt, verb in ((win, "fall"), (run, "rise")):
        if opt.path in fee_pct:
            shift = round(gap / (1 - fee_pct[opt.path] / 100))
            out.append(
                f"For {LABEL[opt.path]}: the sale price would have to {verb} by about "
                f"{_dollars(shift)} to flip the ranking."
            )
        elif opt.path == Path.PART_OUT:
            out.append(
                f"For {LABEL[opt.path]}: net parts revenue would have to {verb} by about "
                f"{_dollars(gap)} to flip the ranking."
            )
    if vehicle.undercarriage_damage is None or vehicle.engine_audio_abnormal is None:
        out.append(
            "Missing undercarriage/engine-audio inspection flags add a hidden-damage "
            "allowance to repair; confirming them could change the ranking."
        )
    return out


def evaluate(
    vehicle: VehicleRecord,
    findings: list[DamageFinding],
    a: Assumptions | None = None,
) -> Recommendation:
    a = a or default_assumptions()
    sim_cfg = a["simulation"]
    val = value_vehicle(vehicle, findings, a)
    sim = simulate(vehicle, val, a)
    ranked = _options(sim)
    win, run = ranked[0], ranked[1]

    reasons: list[str] = []
    # Paired draws share market shocks, so this is the chance the runner-up truly beats the winner.
    overlap = float(np.mean(sim.nets[run.path] > sim.nets[win.path]))
    # Review looks at every rival, not just the runner-up: a third path can be the real threat.
    not_best = p_not_best(sim.nets, win.path)
    if not_best >= sim_cfg["review_overlap_threshold"]:
        reasons.append(
            f"Paths overlap heavily: another path beat the winner in {not_best:.0%} of "
            "simulated outcomes."
        )
    if val.mean_confidence < sim_cfg["low_confidence_threshold"]:
        reasons.append(f"Damage findings have low average confidence ({val.mean_confidence:.2f}).")

    # (winner if the repaired title stays clean, winner if it is branded), when they differ.
    tl_flip: tuple[Path, Path] | None = None
    # Only relevant on insurance claims where a material share of draws crosses the threshold.
    if sim.branded_share >= sim_cfg["total_loss_min_branded_share"]:
        brand = TitleStatus(a["title"]["brand_after_total_loss_repair"])
        w_clean = _winner(simulate(vehicle, val, a, force_title=TitleStatus.CLEAN).nets)
        w_brand = _winner(simulate(vehicle, val, a, force_title=brand).nets)
        if w_clean != w_brand:
            tl_flip = (w_clean, w_brand)
            reasons.append(
                f"The total-loss threshold decides the outcome: the repair crosses it in "
                f"{sim.branded_share:.1%} of draws, and the best path differs depending on "
                "whether the title is branded."
            )
    total_loss_decides = tl_flip is not None

    explanation = _explain(vehicle, val, ranked, overlap, tl_flip, sim)
    return Recommendation(
        vin=vehicle.vin,
        winner=win.path,
        answer=persona_answer(vehicle, val, sim, win.path),
        options=ranked,
        needs_human_review=bool(reasons),
        review_reasons=reasons,
        total_loss_decides=total_loss_decides,
        explanation=explanation,
        flip_conditions=_flip_conditions(
            ranked, a, vehicle, val, repair_cost_flip(vehicle, findings, a)
        ),
    )


# Share of draws past the threshold at which the adjuster answer is a clear yes (or, mirrored,
# a clear no). A wording cut-off for the answer line, not a market assumption.
TOTAL_LOSS_CLEAR = 0.8


def persona_answer(
    vehicle: VehicleRecord, val: Valuation, sim: SimResult, winner: Path
) -> str:
    """One-line answer to the question each persona actually asks."""
    if vehicle.insurance_claim:
        where = f"the {val.total_loss_threshold:.0%} threshold in {vehicle.region}"
        ratio = f"repair estimate is {val.repair_ratio:.0%} of clean value"
        if vehicle.title_status != TitleStatus.CLEAN:
            return (
                f"Title is already {vehicle.title_status.value}; {ratio}. "
                f"Best path: {LABEL[winner]}."
            )
        crossed = sim.branded_share
        side = "above" if val.repair_ratio >= val.total_loss_threshold else "below"
        facts = f"{ratio}, {side} {where}; repair cost crosses it in {crossed:.0%} of draws"
        if crossed >= TOTAL_LOSS_CLEAR:
            return f"Total loss: {facts}. Best path for the totaled car: {LABEL[winner]}."
        if crossed > 1 - TOTAL_LOSS_CLEAR:
            return (
                f"Borderline total loss: {facts}. A firm repair estimate settles it. "
                f"Best path on current numbers: {LABEL[winner]}."
            )
        return f"Not a total loss: {facts}. Best path: {LABEL[winner]}."
    diff = sim.nets[Path.REPAIR_THEN_ACV] - sim.nets[Path.ACV_AS_IS]
    margin = int(round(diff.mean()))
    share = float(np.mean(diff > 0))
    if margin > 0:
        return (
            f"Repair pays back: repairing then selling on ACV nets {_dollars(margin)} more than "
            f"selling as-is on average, and comes out ahead in {share:.0%} of draws."
        )
    return (
        f"Repair does not pay back: selling as-is nets {_dollars(-margin)} more than repairing "
        f"on average; repair comes out ahead in only {share:.0%} of draws."
    )


def _explain(
    vehicle: VehicleRecord,
    val: Valuation,
    ranked: list[DispositionOption],
    overlap: float,
    tl_flip: tuple[Path, Path] | None,
    sim: SimResult,
) -> str:
    win, run = ranked[0], ranked[1]
    gap = win.expected_cents - run.expected_cents
    text = (
        f"Best path: {LABEL[win.path]}, expected net {_dollars(win.expected_cents)} "
        f"(P10 {_dollars(win.p10_cents)}, P90 {_dollars(win.p90_cents)}). "
        f"Next best is {LABEL[run.path]} at {_dollars(run.expected_cents)}, "
        f"{_dollars(gap)} behind; it wins in {overlap:.0%} of simulated outcomes. "
        f"Expected repair cost is {_dollars(val.repair_cost.expected)} "
        f"({val.repair_ratio:.0%} of a {_dollars(val.clean_value)} clean value; "
        f"total-loss threshold {val.total_loss_threshold:.0%} in {vehicle.region})."
    )
    if win.path == Path.REPAIR_THEN_ACV and sim.branded_share > 0:
        text += (
            f" In {sim.branded_share:.1%} of draws the repair crosses the threshold "
            "and the title is branded."
        )
    if (
        vehicle.insurance_claim
        and win.path != Path.REPAIR_THEN_ACV
        and val.repair_ratio >= val.total_loss_threshold
    ):
        text += " Repair is past the total-loss threshold, so a repaired car would carry a brand."
    if tl_flip:
        w_clean, w_brand = tl_flip
        text += (
            f" The total-loss threshold decides this outcome: if the repaired title stays "
            f"clean, {LABEL[w_clean]} wins. If the repair brands the title, "
            f"{LABEL[w_brand]} wins instead."
        )
    return text

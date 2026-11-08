import copy

import numpy as np
import pytest

from underscope.config import Assumptions, default_assumptions
from underscope.decision import PATHS, _winner, evaluate, repair_cost_flip, simulate
from underscope.models import DamageFinding, Path, VehicleRecord
from underscope.valuation import value_vehicle


def veh(**kw):
    base = dict(
        vin="V",
        year=2022,
        make="X",
        model="Y",
        mileage=30000,
        region="NY",
        clean_value_cents=2_500_000,
        undercarriage_damage=False,
        engine_audio_abnormal=False,
    )
    return VehicleRecord(**{**base, **kw})  # fmt: skip


def f(panel="door", t="dent", sev=0.3, conf=0.95):
    return DamageFinding(panel=panel, damage_type=t, severity=sev, confidence=conf)


def test_small_dent_follows_buyer_discount():
    # Whether a ~$650 dent repair pays back depends on how hard buyers discount the damage.
    fi = [f(sev=0.5)]
    assert evaluate(veh(), fi, repair_friendly()).winner == Path.REPAIR_THEN_ACV
    mild = _with(repair_friendly(), market={
        **repair_friendly()["market"], "as_is_discount_multiple_of_repair": 1.0})
    assert evaluate(veh(), fi, mild).winner == Path.ACV_AS_IS


def test_severe_damage_goes_to_salvage_or_parts():
    v = veh(clean_value_cents=1_200_000)
    r = evaluate(v, [f("frame", "crush", 1.0), f("roof", "crush", 0.9)])
    assert r.winner in (Path.COPART_SALVAGE, Path.PART_OUT, Path.ACV_AS_IS)
    assert r.winner != Path.REPAIR_THEN_ACV


def test_deterministic_and_ranked():
    a = evaluate(veh(), [f()])
    b = evaluate(veh(), [f()])
    assert a == b
    exp = [o.expected_cents for o in a.options]
    assert exp == sorted(exp, reverse=True)
    assert all(o.p10_cents <= o.p50_cents <= o.p90_cents for o in a.options)


def test_money_is_int_and_components_sum_to_net():
    a = default_assumptions()
    v = veh()
    fi = [f()]
    val = value_vehicle(v, fi, a)
    sim = simulate(v, val, a)
    for p in PATHS:
        assert sim.nets[p].dtype == np.int64
        total = sum(sim.components[p].values())
        assert (total == sim.nets[p]).all()


def test_repair_cost_sign_and_asis_formula():
    a = default_assumptions()
    v = veh()
    val = value_vehicle(v, [f()], a)
    sim = simulate(v, val, a, draws=2000)
    assert (sim.components[Path.REPAIR_THEN_ACV]["repair_cost"] <= 0).all()
    assert (sim.components[Path.ACV_AS_IS]["acv_fees"] < 0).all()
    # as-is net ~ as_is_value * (1 - fee pct) - flat fee - transport mean
    c = sim.components[Path.ACV_AS_IS]
    approx = c["sale_price"].mean() * 0.98 - 25000 - 40000
    assert abs(sim.nets[Path.ACV_AS_IS].mean() - approx) < 0.05 * abs(approx) + 2000


def test_low_confidence_triggers_review():
    r = evaluate(veh(), [f(conf=0.3)])
    assert r.needs_human_review
    assert any("confidence" in x for x in r.review_reasons)


def _with(a=None, **sections):
    data = copy.deepcopy((a or default_assumptions()).data)
    for section, kw in sections.items():
        data[section].update(kw)
    return Assumptions(data)


def repair_friendly():
    # Test world where buyers discount visible damage steeply and repairs leave little stigma,
    # so repair can win. Not a calibration; config/assumptions.yaml stays untuned.
    a = default_assumptions()
    return _with(
        market={**a["market"], "as_is_discount_multiple_of_repair": 3.0,
                "repaired_value_haircut_pct_at_total_damage": 5},
        timing={**a["timing"], "holding_cost_per_day_cents": 2000},
    )  # fmt: skip


def test_close_call_needs_review():
    # Overlap review fires exactly when P(runner-up beats winner) reaches the threshold.
    sim = default_assumptions()["simulation"]
    always = _with(simulation={**sim, "review_overlap_threshold": 0.0})
    never = _with(simulation={**sim, "review_overlap_threshold": 1.01})
    assert any("overlap" in x for x in evaluate(veh(), [f()], always).review_reasons)
    assert not any("overlap" in x for x in evaluate(veh(), [f()], never).review_reasons)


def test_total_loss_flag_only_near_threshold():
    r = evaluate(veh(), [f(sev=0.5)])
    assert not r.total_loss_decides


def test_explanation_and_flip_present():
    r = evaluate(veh(), [f()])
    assert "Best path" in r.explanation and r.flip_conditions


def test_holding_cost_charged_on_every_sale_path():
    a = default_assumptions()
    v = veh()
    sim = simulate(v, value_vehicle(v, [f()], a), a)
    for p in (Path.REPAIR_THEN_ACV, Path.ACV_AS_IS, Path.COPART_SALVAGE):
        assert (sim.components[p]["holding"] < 0).all()


def test_total_loss_only_decides_on_insurance_claims():
    v = veh(clean_value_cents=1_800_000)
    fi = [f("frame", "crush", 0.4, 0.9), f("door", "dent", 0.6, 0.9)]
    a = default_assumptions()
    assert simulate(v, value_vehicle(v, fi, a), a).branded_share == 0
    assert not evaluate(v, fi).total_loss_decides


def test_total_loss_decides_needs_material_branding_and_says_what_flips():
    # Low threshold so the repair ratio (~43%) straddles it; repair wins only if unbranded.
    w = repair_friendly()
    a = _with(w, total_loss={**w["total_loss"], "default_threshold_pct": 45})
    v = veh(clean_value_cents=1_600_000, insurance_claim=True, region="ZZ")
    fi = [f("frame", "crush", 0.4, 0.9), f("door", "dent", 0.6, 0.9)]
    r = evaluate(v, fi, a)
    assert r.total_loss_decides
    assert "If the repair brands the title" in r.explanation
    # Far from the threshold, a sliver of branded draws doesn't make it decisive.
    far = evaluate(veh(clean_value_cents=3_000_000, insurance_claim=True, region="ZZ"), fi, a)
    assert not far.total_loss_decides
    assert "decides" not in far.explanation


def test_repair_cost_flip_reproduces():
    # Dent case: winner is coupled to repair cost through as-is value, so search, don't guess.
    v, fi = veh(), [f(sev=0.5)]
    a = repair_friendly()
    flip = repair_cost_flip(v, fi, a)
    base = _winner(simulate(v, value_vehicle(v, fi, a), a).nets)
    # Cheaper repair means buyers discount the as-is car less, so as-is takes over.
    assert flip.down is not None
    scale, new_winner = flip.down
    assert scale < 1
    past = _winner(simulate(v, value_vehicle(v, fi, a, repair_cost_scale=scale * 0.99), a).nets)
    short = _winner(simulate(v, value_vehicle(v, fi, a, repair_cost_scale=scale * 1.01), a).nets)
    assert past == new_winner != base
    assert short == base
    r = evaluate(v, fi, a)
    assert any("repair cost" in c and "$" in c for c in r.flip_conditions)


def test_title_discount_uncertainty_widens_rebuilt_repair_outcomes():
    # Title discounts are uncertain market facts; a point value hides the risk of repairing
    # a salvage car to a rebuilt title.
    a = default_assumptions()
    point = _with(a, title={**a["title"], "factor": {
        k: [r[1]] * 3 for k, r in a["title"]["factor"].items()}})  # fmt: skip
    v = veh(title_status="salvage")
    fi = [f(sev=0.5)]
    wide = simulate(v, value_vehicle(v, fi, a), a).nets[Path.REPAIR_THEN_ACV]
    narrow = simulate(v, value_vehicle(v, fi, point), point).nets[Path.REPAIR_THEN_ACV]
    assert wide.std() > 1.2 * narrow.std()
    # Symmetric ranges leave the expected net about where it was.
    assert abs(wide.mean() - narrow.mean()) < 0.03 * abs(narrow.mean())


def test_tri_ppf_matches_range():
    from underscope.decision import _tri_ppf

    u = np.linspace(0, 1, 1001)
    x = _tri_ppf(u, [0.66, 0.78, 0.90])
    assert x[0] == pytest.approx(0.66) and x[-1] == pytest.approx(0.90)
    assert (np.diff(x) >= 0).all()
    assert x.mean() == pytest.approx(0.78, abs=0.002)


def test_p_not_best_counts_every_rival():
    from underscope.decision import p_not_best

    win = np.full(10, 10)
    b = np.array([11, 11, 11, 0, 0, 0, 0, 0, 0, 0])
    c = np.array([0, 0, 0, 11, 11, 11, 0, 0, 0, 0])
    nets = {Path.REPAIR_THEN_ACV: win, Path.ACV_AS_IS: b, Path.PART_OUT: c,
            Path.COPART_SALVAGE: np.zeros(10, dtype=int)}  # fmt: skip
    # Each rival alone wins 30% of draws; together the winner isn't best in 60%.
    assert p_not_best(nets, Path.REPAIR_THEN_ACV) == pytest.approx(0.6)


def test_totaled_claim_sells_as_is_on_a_salvage_title():
    # An insurer totals the car: the as-is buyer gets a salvage certificate, not a clean title.
    a = default_assumptions()
    fi = [f("frame", "crush", 1.0, 0.95), f("hood", "crush", 0.9, 0.95)]
    claim = veh(clean_value_cents=1_200_000, insurance_claim=True)
    dealer = veh(clean_value_cents=1_200_000)
    s_claim = simulate(claim, value_vehicle(claim, fi, a), a)
    s_dealer = simulate(dealer, value_vehicle(dealer, fi, a), a)
    assert s_claim.branded_share > 0.9
    claim_sale = s_claim.components[Path.ACV_AS_IS]["sale_price"].mean()
    dealer_sale = s_dealer.components[Path.ACV_AS_IS]["sale_price"].mean()
    assert claim_sale < dealer_sale


def test_as_is_sale_never_far_below_salvage_sale_in_any_draw():
    # Floor: salvage sale minus a dealer's cost to flip it to salvage (Copart fee, transport,
    # margin). The transport draw isn't exposed per path here, so allow the top transport value.
    a = default_assumptions()
    cf, top_transport = a["fees"]["copart"], a["transport"]["copart_cents"][2]
    margin = a["market"]["as_is_dealer_flip_margin_pct"]
    for v in (veh(insurance_claim=True, clean_value_cents=1_000_000), veh(title_status="salvage")):
        fi = [f("frame", "crush", 0.9), f("door", "dent", 0.5)]
        s = simulate(v, value_vehicle(v, fi, a), a)
        as_is = s.components[Path.ACV_AS_IS]["sale_price"]
        salvage = s.components[Path.COPART_SALVAGE]["sale_price"]
        floor = salvage - (cf["flat_cents"] + top_transport
                           + salvage * (cf["pct_of_price"] + margin) / 100)
        assert (as_is >= floor - 1).all()


def test_copart_can_win_for_a_wreck():
    # Regression: with the old full-salvage floor, ACV as-is beat Copart for every wreck.
    a = default_assumptions()
    v = veh(clean_value_cents=900_000)
    fi = [f("frame", "crush", 1.0), f("hood", "crush", 1.0), f("front_bumper", "broken", 1.0),
          f("fender", "crush", 1.0), f("door", "crush", 0.9), f("roof", "crush", 0.8)]
    r = evaluate(v, fi, a)
    assert r.winner in (Path.COPART_SALVAGE, Path.PART_OUT), r.winner


def test_dealer_answer_says_whether_repair_pays_back():
    r = evaluate(veh(), [f(sev=0.5)])
    assert r.answer.startswith("Repair does not pay back") or r.answer.startswith(
        "Repair pays back"
    )
    assert "as-is" in r.answer and "$" in r.answer
    r2 = evaluate(veh(), [f(sev=0.5)], repair_friendly())
    assert r2.answer.startswith("Repair pays back")


def test_adjuster_answer_says_total_loss_or_not():
    heavy = [f("frame", "crush", 1.0, 0.95), f("hood", "crush", 0.9, 0.95)]
    total = evaluate(veh(clean_value_cents=1_200_000, insurance_claim=True), heavy)
    assert total.answer.startswith("Total loss")
    assert "75%" in total.answer
    light = evaluate(veh(insurance_claim=True), [f(sev=0.3)])
    assert light.answer.startswith("Not a total loss")


def test_adjuster_borderline_answer_is_not_contradictory():
    import json

    from underscope.data import FIXTURE_DIR

    v = VehicleRecord(**json.loads((FIXTURE_DIR / "borderline_writeoff.json").read_text()))
    r = evaluate(v, v.findings)
    assert r.answer.startswith("Borderline total loss")
    assert "below the 75%" in r.answer

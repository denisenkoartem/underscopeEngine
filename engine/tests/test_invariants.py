"""Properties that must hold for any placeholder values, checked over a grid of damage."""

import itertools

import pytest

from underscope.config import default_assumptions
from underscope.data import generate_synthetic
from underscope.decision import PATHS, evaluate, simulate
from underscope.models import DamageFinding, DamageType, Panel, Path, VehicleRecord
from underscope.valuation import value_vehicle

GRID = list(itertools.product(Panel, DamageType))


def veh(**kw):
    base = dict(vin="V", year=2021, make="X", model="Y", mileage=40000, region="NY",
                clean_value_cents=2_000_000, undercarriage_damage=False,
                engine_audio_abnormal=False)  # fmt: skip
    return VehicleRecord(**{**base, **kw})


def f(panel, t, sev):
    return DamageFinding(panel=panel, damage_type=t, severity=sev, confidence=0.9)


@pytest.mark.parametrize("panel,t", GRID)
def test_more_severity_never_helps_values(panel, t):
    a = default_assumptions()
    vals = [value_vehicle(veh(), [f(panel, t, s)], a) for s in (0.1, 0.5, 0.9)]
    for lo, hi in itertools.pairwise(vals):
        assert hi.repair_cost.expected >= lo.repair_cost.expected
        assert hi.as_is_value <= lo.as_is_value
        assert hi.repaired_value <= lo.repaired_value
        assert hi.parts_gross_value.expected <= lo.parts_gross_value.expected
        assert hi.salvage_value.expected <= lo.salvage_value.expected


@pytest.mark.parametrize("panel,t", GRID[::5])
def test_more_severity_never_raises_repair_net(panel, t):
    a = default_assumptions()
    v = veh()
    nets = [
        simulate(v, value_vehicle(v, [f(panel, t, s)], a), a).nets[Path.REPAIR_THEN_ACV].mean()
        for s in (0.1, 0.5, 0.9)
    ]
    assert nets == sorted(nets, reverse=True)


def test_recommendations_well_formed_on_synthetic_sample():
    for row in generate_synthetic(30, seed=21):
        v = VehicleRecord(**row["vehicle"])
        r = evaluate(v, v.findings)
        assert r == evaluate(v, v.findings)  # deterministic
        assert {o.path for o in r.options} == set(PATHS)
        assert r.winner == r.options[0].path
        for o in r.options:
            money = [o.expected_cents, o.p10_cents, o.p50_cents, o.p90_cents,
                     *o.components.values()]  # fmt: skip
            assert all(type(x) is int for x in money)
            assert o.p10_cents <= o.p50_cents <= o.p90_cents
            # Components are per-draw means; they sum to the expected net within rounding.
            assert abs(sum(o.components.values()) - o.expected_cents) <= len(o.components)
        assert r.needs_human_review == bool(r.review_reasons)

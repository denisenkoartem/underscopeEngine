from underscope.config import default_assumptions
from underscope.decision import evaluate
from underscope.sensitivity import (
    FIXTURES,
    PARAMS,
    SCALES,
    _fixture,
    breakeven_discount_multiple,
    build,
    scaled,
    sweep,
)


def test_scaled_changes_only_target():
    a = default_assumptions()
    b = scaled(a, "fees", "acv", 1.5)
    assert b["fees"]["acv"]["flat_cents"] == round(a["fees"]["acv"]["flat_cents"] * 1.5)
    assert b["fees"]["copart"] == a["fees"]["copart"]
    assert isinstance(b["fees"]["acv"]["flat_cents"], int)


def test_sweep_base_column_matches_evaluate():
    res = sweep()
    for name in FIXTURES:
        v, fi = _fixture(name)
        base = evaluate(v, fi).winner
        assert len(res[name]) == len(PARAMS)
        assert all(w[SCALES.index(1.0)] == base for w in res[name].values())


def test_breakeven_makes_repair_win():
    a = default_assumptions()
    v, fi = _fixture("dent_600.json")
    m = breakeven_discount_multiple(v, fi, a)
    assert m is not None and m > a["market"]["as_is_discount_multiple_of_repair"]


def test_report_mentions_every_fixture():
    text = build()
    assert all(name in text for name in FIXTURES)

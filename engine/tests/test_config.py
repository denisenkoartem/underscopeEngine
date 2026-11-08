import copy

import pytest

from underscope.config import Assumptions, default_assumptions


def test_loads_and_labeled():
    a = default_assumptions()
    assert a.total_loss_threshold_pct("NY") == 75
    assert a.total_loss_threshold_pct("ZZ") == a["total_loss"]["default_threshold_pct"]


def test_ranges_ordered():
    a = default_assumptions()
    for rng in a["repair_cost"]["panel_base_cents"].values():
        assert rng[0] <= rng[1] <= rng[2]
    for key in ("acv_cents", "copart_cents", "parts_cents"):
        r = a["transport"][key]
        assert r == sorted(r)


def test_rejects_unlabeled():
    data = dict(default_assumptions().data)
    data["fees"] = {"acv": {}, "replace_with": "x"}
    with pytest.raises(ValueError):
        Assumptions(data)


def _broken(mutate):
    data = copy.deepcopy(default_assumptions().data)
    mutate(data)
    with pytest.raises(ValueError) as e:
        Assumptions(data)
    return str(e.value)


def test_rejects_unordered_range():
    msg = _broken(lambda d: d["transport"].update(acv_cents=[70000, 40000, 20000]))
    assert "transport.acv_cents" in msg


def test_rejects_bad_percent_and_negative_money():
    assert "fees.acv.pct_of_price" in _broken(lambda d: d["fees"]["acv"].update(pct_of_price=120))
    assert "parts.storage_cents_per_day" in _broken(
        lambda d: d["parts"].update(storage_cents_per_day=-1)
    )


def test_nested_tables_inherit_unit_checks():
    msg = _broken(lambda d: d["repair_cost"]["panel_base_cents"].update(roof=[-1, 0, 1]))
    assert "repair_cost.panel_base_cents.roof" in msg


def test_rejects_missing_panel_or_path():
    assert "roof" in _broken(lambda d: d["repair_cost"]["panel_base_cents"].pop("roof"))
    assert "part_out" in _broken(lambda d: d["timing"]["days_to_sell"].pop("part_out"))

import pytest

from underscope.config import default_assumptions
from underscope.data import ACVSource, CopartSource, FixtureSource, generate_synthetic, perturbed


def test_fixtures_load():
    src = FixtureSource()
    vins = src.list_vins()
    assert "FIXDENT0000000001" in vins
    assert src.get_vehicle(vins[0]).vin == vins[0]


def test_stubs_raise_and_list_fields():
    for cls in (ACVSource, CopartSource):
        assert "vin" in cls.REQUIRED_FIELDS
        with pytest.raises(NotImplementedError):
            cls().get_vehicle("x")


def test_synthetic_seeded_and_labeled():
    a = generate_synthetic(25, seed=3)
    assert a == generate_synthetic(25, seed=3)
    assert all(r["synthetic"] for r in a)
    r = a[0]
    assert r["truth"]["best_path"] in r["truth"]["realized_net_cents"]
    assert all(isinstance(v, int) for v in r["truth"]["realized_net_cents"].values())


def test_perturbed_world_is_valid_seeded_and_different():
    a = default_assumptions()
    w = perturbed(a, seed=5)
    assert w.data == perturbed(a, seed=5).data
    assert w.data != a.data
    assert w["title"]["factor"]["clean"] == [1.0, 1.0, 1.0]
    assert max(w["parts"]["sell_through"]) <= 1.0
    assert w["total_loss"] == a["total_loss"]  # statutory, not uncertain
    assert w["simulation"]["value_noise_sigma"] > a["simulation"]["value_noise_sigma"]


def test_truth_can_come_from_another_world():
    a = default_assumptions()
    same = generate_synthetic(10, seed=3)
    other = generate_synthetic(10, seed=3, world=perturbed(a, seed=5))
    # Same vehicles and perceived findings; different realized outcomes.
    assert [r["vehicle"] for r in same] == [r["vehicle"] for r in other]
    assert [r["truth"]["realized_net_cents"] for r in same] != [
        r["truth"]["realized_net_cents"] for r in other
    ]


def test_stratified_indices_balance_bands():
    from underscope.data import BANDS, damage_band, stratified_indices

    rows = generate_synthetic(300, seed=8)
    keep = stratified_indices(rows, 10)
    assert len(keep) == 10 * len(BANDS) and keep == sorted(keep)
    bands = [damage_band(rows[i]) for i in keep]
    assert all(bands.count(name) == 10 for name, _ in BANDS)
    with pytest.raises(ValueError):
        stratified_indices(rows[:20], 10)

from underscope.backtest import run_backtest
from underscope.data import generate_synthetic


def test_backtest_metrics_sane():
    res = run_backtest(generate_synthetic(40, seed=11))
    assert 0 <= res["accuracy"] <= 1 and 0 <= res["review_rate"] <= 1
    assert res["avg_regret_cents"] >= 0
    assert res["flagged"]["n"] + res["unflagged"]["n"] == 40
    # Engine should not be worse than the worst fixed policy.
    assert res["avg_regret_cents"] <= max(res["baseline_avg_regret_cents"].values())


def test_report_has_both_truths(tmp_path):
    from underscope.backtest import write_report

    res = run_backtest(generate_synthetic(10, seed=2))
    text = write_report(res, res, tmp_path / "b.md").read_text()
    assert "Same model" in text and "Misspecified" in text


def test_damage_bands_partition_and_have_baselines():
    res = run_backtest(generate_synthetic(60, seed=4))
    bands = res["bands"]
    assert list(bands) == ["light", "mid", "heavy"]
    assert sum(b["n"] for b in bands.values()) == 60
    assert sum(b["regret"] for b in bands.values()) == round(res["avg_regret_cents"] * 60)
    for b in bands.values():
        assert set(b["baselines"]) == set(res["baseline_avg_regret_cents"])


def test_review_buckets_carry_baselines():
    res = run_backtest(generate_synthetic(30, seed=6))
    for key in ("flagged", "unflagged"):
        assert set(res[key]["baselines"]) == set(res["baseline_avg_regret_cents"])
    total = res["flagged"]["baselines"]["acv_as_is"] + res["unflagged"]["baselines"]["acv_as_is"]
    assert total == round(res["baseline_avg_regret_cents"]["acv_as_is"] * 30)


def test_report_includes_stratified_section_when_given(tmp_path):
    from underscope.backtest import write_report

    res = run_backtest(generate_synthetic(12, seed=2))
    text = write_report(res, res, tmp_path / "b.md", strat_same=res, strat_mis=res).read_text()
    assert "## Stratified set" in text and "stratified: by damage band" in text

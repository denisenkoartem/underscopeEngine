"""Backtest the decision engine against an oracle on the SYNTHETIC set."""

from __future__ import annotations

from pathlib import Path as FsPath

from underscope.data import BANDS, ROOT, SYNTHETIC_DIR, damage_band, read_synthetic
from underscope.decision import PATHS, evaluate
from underscope.models import DamageFinding, VehicleRecord


def run_backtest(rows: list[dict]) -> dict:
    n = len(rows)
    correct = 0
    regret_cents = 0
    reviewed = 0
    flagged = {"n": 0, "regret": 0, "correct": 0, "baselines": {p.value: 0 for p in PATHS}}
    unflagged = {"n": 0, "regret": 0, "correct": 0, "baselines": {p.value: 0 for p in PATHS}}
    baselines = {p.value: 0 for p in PATHS}
    oracle_total = 0
    bands = {
        name: {"n": 0, "regret": 0, "correct": 0, "baselines": {p.value: 0 for p in PATHS}}
        for name, _ in BANDS
    }
    for r in rows:
        v = VehicleRecord(**r["vehicle"])
        rec = evaluate(v, [DamageFinding(**f) for f in r["vehicle"]["findings"]])
        net = r["truth"]["realized_net_cents"]
        best = max(net.values())
        oracle_total += best
        chosen = net[rec.winner.value]
        regret = best - chosen
        ok = rec.winner.value == r["truth"]["best_path"]
        correct += ok
        regret_cents += regret
        reviewed += rec.needs_human_review
        bucket = flagged if rec.needs_human_review else unflagged
        bucket["n"] += 1
        bucket["regret"] += regret
        bucket["correct"] += ok
        band = bands[damage_band(r)]
        band["n"] += 1
        band["regret"] += regret
        band["correct"] += ok
        for p in PATHS:
            baselines[p.value] += best - net[p.value]
            band["baselines"][p.value] += best - net[p.value]
            bucket["baselines"][p.value] += best - net[p.value]
    return {
        "n": n,
        "accuracy": correct / n,
        "avg_regret_cents": regret_cents / n,
        "review_rate": reviewed / n,
        "flagged": flagged,
        "unflagged": unflagged,
        "baseline_avg_regret_cents": {k: v / n for k, v in baselines.items()},
        "avg_oracle_net_cents": oracle_total / n,
        "bands": bands,
    }


def _d(cents: float) -> str:
    return f"${cents / 100:,.0f}"


def _row(name: str, b: dict) -> str:
    if not b["n"]:
        return f"| {name} | 0 | - | - |"
    return f"| {name} | {b['n']} | {b['correct'] / b['n']:.1%} | {_d(b['regret'] / b['n'])} |"


def _metrics(res: dict) -> list[str]:
    return [
        f"{res['accuracy']:.1%}",
        f"{_d(res['avg_regret_cents'])}",
        f"{res['review_rate']:.1%}",
        f"{_d(min(res['baseline_avg_regret_cents'].values()))}",
    ]


def _band_row(name: str, upper: float, b: dict) -> str:
    bounds = [0.0] + [u for _, u in BANDS]
    lower = bounds[[n for n, _ in BANDS].index(name)]
    span = f">={lower:.0%}" if upper == float("inf") else f"{lower:.0%}-{upper:.0%}"
    label = f"{name} ({span})"
    if not b["n"]:
        return f"| {label} | 0 | - | - | - | - |"
    n = b["n"]
    policy, regret = min(b["baselines"].items(), key=lambda kv: kv[1])
    return (
        f"| {label} | {n} | {b['correct'] / n:.1%} | {_d(b['regret'] / n)} | "
        f"always {policy} | {_d(regret / n)} |"
    )


def _compare(ours: float, best: float) -> str:
    """Regret comparison in words; under $1 apart counts as a tie."""
    if abs(ours - best) < 100:
        return "ties"
    return "beats" if ours < best else "does not beat"


def _verdict(title: str, res: dict) -> str:
    policy, best = min(res["baseline_avg_regret_cents"].items(), key=lambda kv: kv[1])
    ours = res["avg_regret_cents"]
    word = _compare(ours, best)
    return (
        f"- {title}: UnderScope ({_d(ours)}) {word} the best fixed policy, "
        f"always {policy} ({_d(best)})."
    )


def _unflagged_verdict(title: str, res: dict) -> str:
    u = res["unflagged"]
    if not u["n"]:
        return f"- {title}: every vehicle was flagged for review."
    policy, best = min(u["baselines"].items(), key=lambda kv: kv[1])
    ours = u["regret"] / u["n"]
    word = _compare(ours, best / u["n"])
    return (
        f"- {title}, the {u['n'] / res['n']:.0%} of vehicles not flagged for review: UnderScope "
        f"({_d(ours)}) {word} always {policy} ({_d(best / u['n'])}) on the same vehicles."
    )


def _stratified_section(same: dict, mis: dict) -> list[str]:
    names = (
        "Accuracy (picked the oracle's path)",
        "Average regret per vehicle",
        "Human-review rate",
        "Best fixed-policy regret",
    )
    lines = [
        "## Stratified set: equal light, mid and heavy damage",
        "",
        f"{same['n']} vehicles, {same['n'] // len(BANDS)} per damage band, picked from a larger "
        "synthetic pool so the hard cases have enough rows to judge. Same cars in both truths.",
        "",
        "| Metric | Same model | Misspecified |",
        "|---|---|---|",
        *(f"| {n} | {x} | {y} |" for n, x, y in zip(
            names, _metrics(same), _metrics(mis), strict=True)),
        "",
        *(_verdict(t, r) for t, r in (("Same model", same), ("Misspecified", mis))),
        *(_unflagged_verdict(t, r) for t, r in (("Same model", same), ("Misspecified", mis))),
        "",
    ]  # fmt: skip
    for title, res in (("Same model", same), ("Misspecified", mis)):
        lines += [
            f"### {title}, stratified: by damage band",
            "",
            "| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |",
            "|---|---|---|---|---|---|",
            *(_band_row(name, upper, b) for (name, upper), b in zip(
                BANDS, res["bands"].values(), strict=True)),
            "",
        ]  # fmt: skip
    return lines


def write_report(
    same: dict,
    mis: dict,
    path: str | FsPath = ROOT / "reports" / "backtest.md",
    strat_same: dict | None = None,
    strat_mis: dict | None = None,
) -> FsPath:
    lines = [
        "# Backtest vs oracle (SYNTHETIC data)",
        "",
        "**Read this first:** the vehicles and their 'true' outcomes are synthetic. The engine",
        "sees noisy findings (severity noise, 5% missed findings, imperfect confidence); the",
        "oracle sees the true findings and one realized outcome per path. Two truths:",
        "",
        "- **Same model:** outcomes drawn from the engine's own placeholder model. This only",
        "  measures perception noise and outcome variance; it is circular by construction.",
        "- **Misspecified:** outcomes drawn from a perturbed world where every placeholder is",
        "  off by up to 25% and market noise is 1.5x wider (`data.perturbed`). The gap between",
        "  the two columns shows how much results lean on the engine's own assumptions.",
        "",
        "Neither is accuracy on real auction data.",
        "",
        f"Vehicles: {same['n']}. Oracle = best realized net per vehicle.",
        "",
        "| Metric | Same model | Misspecified |",
        "|---|---|---|",
        *(
            f"| {name} | {x} | {y} |"
            for name, x, y in zip(
                (
                    "Accuracy (picked the oracle's path)",
                    "Average regret per vehicle",
                    "Human-review rate",
                    "Best fixed-policy regret",
                ),
                _metrics(same),
                _metrics(mis),
                strict=True,
            )
        ),
        "",
        *(_verdict(title, res) for title, res in (("Same model", same), ("Misspecified", mis))),
        *(
            _unflagged_verdict(title, res)
            for title, res in (("Same model", same), ("Misspecified", mis))
        ),
        "",
    ]
    for title, res in (("Same model", same), ("Misspecified", mis)):
        lines += [
            f"## {title}: by damage band (true repair cost / clean value)",
            "",
            "| Band | Vehicles | Accuracy | UnderScope regret | Best fixed policy | Its regret |",
            "|---|---|---|---|---|---|",
            *(_band_row(name, upper, b) for (name, upper), b in zip(
                BANDS, res["bands"].values(), strict=True)),
            "",
        ]  # fmt: skip
    for title, res in (("Same model", same), ("Misspecified", mis)):
        base = res["baseline_avg_regret_cents"]
        lines += [
            f"## {title}",
            "",
            f"Average oracle net {_d(res['avg_oracle_net_cents'])}.",
            "",
            "| Group | Vehicles | Accuracy | Avg regret |",
            "|---|---|---|---|",
            _row("Flagged for review", res["flagged"]),
            _row("Not flagged", res["unflagged"]),
            "",
            "| Policy | Avg regret |",
            "|---|---|",
            *(f"| always {k} | {_d(v)} |" for k, v in base.items()),
            f"| UnderScope | {_d(res['avg_regret_cents'])} |",
            "",
        ]
    if strat_same and strat_mis:
        lines += _stratified_section(strat_same, strat_mis)
    lines.append(
        "Regret is in dollars (integer cents internally). Regenerate with "
        "`.venv/bin/python -m underscope.data && .venv/bin/python -m underscope.backtest`."
    )
    p = FsPath(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("\n".join(lines) + "\n")
    return p


if __name__ == "__main__":
    print(
        write_report(
            run_backtest(read_synthetic()),
            run_backtest(read_synthetic(SYNTHETIC_DIR / "vehicles_misspecified.jsonl")),
            strat_same=run_backtest(read_synthetic(SYNTHETIC_DIR / "vehicles_stratified.jsonl")),
            strat_mis=run_backtest(
                read_synthetic(SYNTHETIC_DIR / "vehicles_stratified_misspecified.jsonl")
            ),
        )
    )

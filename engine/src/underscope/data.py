"""Data sources: fixtures (real code path), ACV/Copart stubs (no network), synthetic generator.

Everything produced by `generate_synthetic` is SYNTHETIC and carries synthetic=True.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path as FsPath
from typing import Protocol

import numpy as np

from underscope.config import Assumptions, default_assumptions
from underscope.decision import PATHS, simulate
from underscope.models import DamageFinding, Panel, VehicleRecord
from underscope.valuation import value_vehicle

ROOT = FsPath(__file__).resolve().parents[2]
FIXTURE_DIR = ROOT / "data" / "fixtures"
SYNTHETIC_DIR = ROOT / "data" / "synthetic"


class VehicleSource(Protocol):
    def get_vehicle(self, vin: str) -> VehicleRecord: ...


class FixtureSource:
    """Loads vehicle JSON files from a directory (default data/fixtures/)."""

    def __init__(self, directory: str | FsPath = FIXTURE_DIR):
        self.directory = FsPath(directory)

    def list_vins(self) -> list[str]:
        return sorted(
            self._load(p).vin for p in self.directory.glob("*.json") if p.stem != "labels"
        )

    @staticmethod
    def _load(path: FsPath) -> VehicleRecord:
        return VehicleRecord(**json.loads(path.read_text()))

    def get_vehicle(self, vin: str) -> VehicleRecord:
        for p in self.directory.glob("*.json"):
            if p.stem != "labels" and (v := self._load(p)).vin == vin:
                return v
        raise KeyError(vin)


class ACVSource:
    """STUB. Fields we need from ACV once a data partnership exists. No network access."""

    REQUIRED_FIELDS = (
        "vin", "year", "make", "model", "trim", "odometer", "region", "title_status",
        "condition_report (panel-level damage, photos, undercarriage, engine audio)",
        "sale_price", "sale_date", "days_to_sell", "seller_fees", "arbitration_outcome",
        "wholesale_market_value_by_vin_trim_mileage_region",
    )  # fmt: skip

    def get_vehicle(self, vin: str) -> VehicleRecord:
        raise NotImplementedError("ACV adapter is a stub; no data partnership yet.")


class CopartSource:
    """STUB. Fields we need from Copart once a data partnership exists. No network access."""

    REQUIRED_FIELDS = (
        "vin", "year", "make", "model", "odometer", "region", "title_brand",
        "primary_damage", "secondary_damage", "photos", "keys_present", "runs_and_drives",
        "final_bid_price", "sale_date", "days_to_sell", "seller_fees", "tow_cost_by_lane",
    )  # fmt: skip

    def get_vehicle(self, vin: str) -> VehicleRecord:
        raise NotImplementedError("Copart adapter is a stub; no data partnership yet.")


# ---------------------------------------------------------------- synthetic generator

_MAKES = {"SynthA": ["Alpha", "Beta"], "SynthB": ["Gamma", "Delta"], "SynthC": ["Eps", "Zeta"]}
_PANEL_WEIGHTS = {
    Panel.FRONT_BUMPER: 5, Panel.REAR_BUMPER: 4, Panel.HOOD: 3, Panel.FENDER: 4, Panel.DOOR: 5,
    Panel.QUARTER_PANEL: 2, Panel.ROOF: 1, Panel.WINDSHIELD: 2, Panel.FRAME: 1,
}  # fmt: skip
_TYPES = ["scratch", "dent", "crack", "crush", "broken"]
_TYPE_P = [0.25, 0.35, 0.1, 0.2, 0.1]


# Sections whose numbers are uncertain market facts. total_loss (statutory), base_value and
# the simulation settings are left alone.
_PERTURB = (
    "repair_cost", "market", "fees", "transport", "timing", "title", "parts", "hidden_damage",
)  # fmt: skip
# Keys whose values are fractions that can't exceed 1 (or percents that can't exceed 100).
_CAP_ONE = ("sell_through", "salvage_fraction_of_clean", "factor", "min_severity_factor",
            "damage_type_loss_factor")  # fmt: skip


def perturbed(a: Assumptions, seed: int = 99, jitter: float = 0.25) -> Assumptions:
    """A SYNTHETIC 'true world' that differs from the engine's assumptions.

    Each number (each [low, expected, high] range as a unit) is scaled by a seeded factor
    in [1 - jitter, 1 + jitter], and market noise is 1.5x wider. Backtesting against truth
    drawn from this world measures how the engine does when its assumptions are wrong.
    """
    rng = np.random.default_rng(seed)
    data = copy.deepcopy(a.data)

    def walk(node, cap: float | None):
        if isinstance(node, dict):
            return {
                k: node[k] if k in ("status", "replace_with", "clean") else walk(
                    v, 100.0 if "pct" in k else 1.0 if k in _CAP_ONE else cap
                )
                for k, v in node.items()
            }  # fmt: skip
        if isinstance(node, str) or isinstance(node, bool):
            return node
        k = 1 + rng.uniform(-jitter, jitter)
        items = node if isinstance(node, list) else [node]
        out = []
        for x in items:
            y = x * k if cap is None else min(cap, x * k)
            out.append(round(y) if isinstance(x, int) else round(y, 6))
        return out if isinstance(node, list) else out[0]

    for section in _PERTURB:
        data[section] = walk(data[section], None)
    data["simulation"]["value_noise_sigma"] = a["simulation"]["value_noise_sigma"] * 1.5
    return Assumptions(data)


def generate_synthetic(
    n: int = 500, seed: int = 7, a: Assumptions | None = None, world: Assumptions | None = None
) -> list[dict]:
    """Seeded SYNTHETIC vehicles with hidden ground truth.

    Each row has the vehicle as the engine sees it (noisy perceived findings) and a truth
    block: the real findings and one realized outcome per path (an independent seed per
    vehicle). Truth is drawn from `world` (default: the engine's own assumptions `a`). With the
    default, truth shares the engine's model and scores measure decision quality under noise
    only; pass `perturbed(a)` to also measure robustness to wrong assumptions.
    """
    a = a or default_assumptions()
    world = world or a
    rng = np.random.default_rng(seed)
    regions = list(a["total_loss"]["threshold_pct_by_region"])
    panels = list(_PANEL_WEIGHTS)
    pw = np.array(list(_PANEL_WEIGHTS.values()), dtype=float)
    pw /= pw.sum()
    rows = []
    for i in range(n):
        make = str(rng.choice(list(_MAKES)))
        k = int(rng.integers(1, 5))
        true_findings = [
            DamageFinding(
                panel=panels[int(rng.choice(len(panels), p=pw))],
                damage_type=str(rng.choice(_TYPES, p=_TYPE_P)),
                severity=round(float(rng.beta(1.6, 2.4)), 3),
                confidence=1.0,
            )
            for _ in range(k)
        ]
        title = str(rng.choice(["clean", "salvage", "rebuilt"], p=[0.85, 0.1, 0.05]))
        vehicle = VehicleRecord(
            vin=f"SYN{i:014d}",
            year=int(rng.integers(2012, 2026)),
            make=make,
            model=str(rng.choice(_MAKES[make])),
            trim="Base",
            mileage=int(rng.integers(5_000, 160_000)),
            region=str(rng.choice(regions)),
            title_status=title,
            photo_refs=[f"synthetic/{i:04d}_{j}.jpg" for j in range(k)],
            undercarriage_damage=[None, False, True][int(rng.choice(3, p=[0.3, 0.55, 0.15]))],
            engine_audio_abnormal=[None, False, True][int(rng.choice(3, p=[0.4, 0.5, 0.1]))],
            insurance_claim=bool(rng.random() < 0.5),
        )
        # What the detector reports: noisy severity, 5% missed, imperfect confidence.
        perceived = []
        for f in true_findings:
            if rng.random() < 0.05:
                continue
            conf = float(np.clip(rng.normal(0.85, 0.12), 0.3, 0.99))
            sev = float(np.clip(f.severity + rng.normal(0, 0.12), 0, 1))
            perceived.append(
                f.model_copy(update={"severity": round(sev, 3), "confidence": round(conf, 3)})
            )
        vehicle = vehicle.model_copy(update={"findings": perceived})

        truth_val = value_vehicle(vehicle, true_findings, world)
        realized = simulate(vehicle, truth_val, world, draws=1, seed=int(rng.integers(2**31)))
        net = {p.value: int(realized.nets[p][0]) for p in PATHS}
        best = max(PATHS, key=lambda p: (net[p.value], -PATHS.index(p)))
        rows.append(
            {
                "synthetic": True,
                "vehicle": vehicle.model_dump(mode="json"),
                "truth": {
                    "findings": [f.model_dump(mode="json") for f in true_findings],
                    "realized_net_cents": net,
                    "best_path": best.value,
                },
            }
        )
    return rows


# Bands by true repair ratio (expected repair cost / clean value, engine's assumptions), so
# hard cases aren't averaged away by the many light-damage vehicles.
BANDS = (("light", 0.15), ("mid", 0.50), ("heavy", float("inf")))


def damage_band(row: dict, a: Assumptions | None = None) -> str:
    v = VehicleRecord(**row["vehicle"])
    true = [DamageFinding(**f) for f in row["truth"]["findings"]]
    ratio = value_vehicle(v, true, a).repair_ratio
    return next(name for name, upper in BANDS if ratio < upper)


def stratified_indices(rows: list[dict], per_band: int) -> list[int]:
    """Indices of the first per_band rows in each damage band, in pool order."""
    taken: dict[str, list[int]] = {name: [] for name, _ in BANDS}
    for i, row in enumerate(rows):
        band = taken[damage_band(row)]
        if len(band) < per_band:
            band.append(i)
    short = {name: len(ix) for name, ix in taken.items() if len(ix) < per_band}
    if short:
        raise ValueError(f"pool too small for {per_band} per band: {short}")
    return sorted(i for ix in taken.values() for i in ix)


def write_synthetic(directory: str | FsPath = SYNTHETIC_DIR, n: int = 500, seed: int = 7) -> FsPath:
    d = FsPath(directory)
    d.mkdir(parents=True, exist_ok=True)
    out = d / "vehicles.jsonl"
    out.write_text("".join(json.dumps(r) + "\n" for r in generate_synthetic(n, seed)))
    world = perturbed(default_assumptions(), seed=WORLD_SEED)
    rows = generate_synthetic(n, seed, world=world)
    (d / "vehicles_misspecified.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    # Stratified: equal light/mid/heavy counts drawn from a larger pool, same vehicles in both
    # truths, so the hard cases have enough rows to judge.
    pool = generate_synthetic(STRAT_POOL, STRAT_SEED)
    keep = stratified_indices(pool, STRAT_PER_BAND)
    pool_world = generate_synthetic(STRAT_POOL, STRAT_SEED, world=world)
    for name, src in (
        ("vehicles_stratified", pool),
        ("vehicles_stratified_misspecified", pool_world),
    ):
        (d / f"{name}.jsonl").write_text("".join(json.dumps(src[i]) + "\n" for i in keep))
    (d / "README.md").write_text(
        "# SYNTHETIC data\n\nGenerated by `underscope.data.generate_synthetic` "
        f"(n={n}, seed={seed}). Fake VINs and makes. Not real market data.\n\n"
        "- `vehicles.jsonl`: outcomes drawn from the same placeholder model the engine uses "
        "(config/assumptions.yaml).\n"
        "- `vehicles_misspecified.jsonl`: same vehicles, outcomes drawn from "
        f"`perturbed(assumptions, seed={WORLD_SEED})`, a world where every placeholder is off "
        "by up to 25% and market noise is 1.5x wider.\n"
        f"- `vehicles_stratified*.jsonl`: {STRAT_PER_BAND} vehicles per damage band (light "
        f"<15%, mid 15-50%, heavy >=50% repair ratio), picked from a pool of {STRAT_POOL} "
        f"(seed {STRAT_SEED}), with same-model and misspecified truth.\n"
    )
    return out


WORLD_SEED = 99
STRAT_POOL, STRAT_SEED, STRAT_PER_BAND = 3000, 8, 200


def read_synthetic(path: str | FsPath = SYNTHETIC_DIR / "vehicles.jsonl") -> list[dict]:
    return [json.loads(line) for line in FsPath(path).read_text().splitlines() if line]


if __name__ == "__main__":
    print(write_synthetic())

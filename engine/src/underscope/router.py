"""The router model: a trained classifier that says ACV or Copart.

It answers one question, for a car whose title allows both marketplaces: what is the chance
that ACV's best exit nets more than Copart? (the page's `p_acv`).

What it sees: the reader's Assessment as it arrives (`features`). Raw facts only: the title,
the 25 part grades, the flags, run status, keys, the values the seller gave. Nothing computed by
the engine's hand-set formulas goes in, so a model trained on recorded outcomes owes nothing to
those formulas.

What it learns from: rows of {assessment, outcome} (`train`; format in
contracts/router-training-row.schema.json). Two sources:
  - recorded: a real car with its net on ACV and its net on Copart. None exist in this repo yet.
  - simulation: a made-up car (`generate`) labelled by the engine's dollar simulation (`label`).
    This is what the saved model is trained on today. It copies the simulation; it cannot know
    more than it, and the simulation runs on the PLACEHOLDER numbers in assumptions.yaml.

The title rules stay in front of the model (bridge.eligible_paths) and the simulation still
supplies the dollar ranges per exit.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path as FsPath
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, ConfigDict

from underscope.assessment import ENUMS, FLAGS, PARTS, TRI_FIELDS, Assessment
from underscope.config import Assumptions, default_assumptions
from underscope.data import ROOT

MODEL_PATH = ROOT / "models" / "router.joblib"
META_PATH = ROOT / "models" / "router.json"
REPORT_PATH = ROOT / "reports" / "router.md"
ENV = "UNDERSCOPE_ROUTER_MODEL"  # a model path, or "off" to decide by simulation
NAN = float("nan")

# ---------- Features: the Assessment as numbers ----------

_GRADE = {"fine": 0.0, "repairable": 1.0, "replace": 2.0}  # unknown -> missing
_LIGHTS = ("check_engine", "abs", "airbag", "other")
NUMERIC = (
    "clean_value", "comps", "comps_min", "comps_median", "comps_max",  # comps as a share of clean
    "mileage", "age",
    "app_repair_low", "app_repair_high",  # the page's repair estimate, share of clean value
    "repair_quote", "reserve_price", "purchase_price",  # the seller's own, share of clean value
    "storage_cost_per_day", "sell_by_days",
    "parts_repairable", "parts_replace", "parts_unknown",
    "codes", "symptoms", "symptoms_powertrain",
    *(f"light_{x}" for x in _LIGHTS),
    *(f"grade_{p}" for p in PARTS),  # 0 fine, 1 repairable, 2 replace
    *(f"flag_{f}" for f in FLAGS),  # 1 yes, 0 no
    *TRI_FIELDS,
)  # fmt: skip
# Categories, each with "unknown" as a value of its own (index = position in the tuple).
CATEGORICAL: dict[str, tuple[str, ...]] = {k: (*v, "unknown") for k, v in ENUMS.items()}
FEATURES = (*NUMERIC, *CATEGORICAL)


def _num(v: Any) -> float:
    try:
        return NAN if v is None or isinstance(v, bool) else float(v)
    except (TypeError, ValueError):
        return NAN


def _yes_no(v: Any) -> float:
    return float(v) if isinstance(v, bool) else NAN


def features(s: Assessment, a: Assumptions) -> dict[str, float | str]:
    """One flat record per car: what the model sees, in training and when serving.
    A fact the description does not state is a missing number or the category "unknown"."""
    clean = _num(s.values.get("clean_wholesale")) or NAN
    comps = [c for c in map(_num, s.values.get("salvage_comps") or []) if c > 0]
    repair = s.repair or {}
    grades = {g.get("part"): g.get("grade") for g in s.grades if isinstance(g, dict)}
    out: dict[str, float | str] = {
        "clean_value": clean,
        "comps": float(len(comps)),
        "comps_min": min(comps) / clean if comps else NAN,
        "comps_median": float(np.median(comps)) / clean if comps else NAN,
        "comps_max": max(comps) / clean if comps else NAN,
        "mileage": _num(s.mileage),
        "age": a["base_value"]["reference_year"] - _num(s.vehicle.get("year")),
        "app_repair_low": _num(repair.get("low")) / clean,
        "app_repair_high": _num(repair.get("high")) / clean,
        "repair_quote": _num(s.values.get("repair_estimate")) / clean,
        "reserve_price": _num(s.values.get("reserve_price")) / clean,
        "purchase_price": _num(s.values.get("purchase_price")) / clean,
        "storage_cost_per_day": _num(s.storage_cost_per_day),
        "sell_by_days": _num(s.sell_by_days),
        "parts_repairable": float(sum(grades.get(p) == "repairable" for p in PARTS)),
        "parts_replace": float(sum(grades.get(p) == "replace" for p in PARTS)),
        "parts_unknown": float(sum(grades.get(p) not in _GRADE for p in PARTS)),
        "codes": float(len(s.codes)),
        "symptoms": float(len(s.symptoms)),
        "symptoms_powertrain": float(sum(x.get("system") in ("engine", "transmission")
                                         for x in s.symptoms if isinstance(x, dict))),
    }  # fmt: skip
    for x in _LIGHTS:
        out[f"light_{x}"] = float(x in s.warning_lights)
    for p in PARTS:
        out[f"grade_{p}"] = _GRADE.get(grades.get(p), NAN)
    for f in FLAGS:
        out[f"flag_{f}"] = _yes_no(s.flags.get(f))
    for t in TRI_FIELDS:
        out[t] = _yes_no(getattr(s, t))
    for k in CATEGORICAL:
        out[k] = getattr(s, k)
    return out


def vector(x: dict[str, float | str]) -> list[float]:
    """The feature record as numbers, in FEATURES order (categories as their index)."""
    row = [float(x[k]) for k in NUMERIC]
    for k, values in CATEGORICAL.items():
        row.append(float(values.index(x[k])) if x[k] in values else float(len(values) - 1))
    return row


# ---------- Training rows ----------


class Outcome(BaseModel):
    """What the car netted, in dollars after fees, transport and holding."""

    model_config = ConfigDict(extra="ignore")
    acv_net: float  # the better ACV exit (repair first, or as-is)
    copart_net: float
    # Simulation only: the share of simulated outcomes in which ACV netted more. A recorded
    # outcome has one result per marketplace, so it leaves this out.
    p_acv: float | None = None


class TrainingRow(BaseModel):
    """One car the router model learns from: the reader's JSON and how each marketplace paid."""

    model_config = ConfigDict(extra="ignore")
    assessment: dict[str, Any]  # the body of POST /api/route (assessment.schema.json)
    outcome: Outcome
    source: Literal["simulation", "recorded"] = "recorded"


def read_rows(path: str | FsPath) -> list[TrainingRow]:
    """A .jsonl file of training rows. A real sale shows one marketplace only; a row needs both
    nets, so the other side must come from a relist or a per-marketplace price estimate."""
    lines = FsPath(path).read_text(encoding="utf-8").splitlines()
    return [TrainingRow.model_validate_json(line) for line in lines if line.strip()]


def _pick(rng: np.random.Generator, shares: dict[str, float]) -> str:
    keys = list(shares)
    p = np.array([shares[k] for k in keys], dtype=float)
    return str(keys[int(rng.choice(len(keys), p=p / p.sum()))])


def generate(n: int, seed: int = 7, a: Assumptions | None = None) -> list[dict[str, Any]]:
    """n MADE-UP cars as the body /api/route receives, seeded (config `router_training`).
    Mostly unstated facts, like the rules reader's JSON. Not real cars."""
    t = (a or default_assumptions())["router_training"]
    rng = np.random.default_rng(seed)
    tri = {"yes": True, "no": False}
    lo, hi = t["clean_value_dollars"]
    cr = t["comps_ratio"]
    rows = []
    for i in range(n):
        clean = round(float(np.exp(rng.uniform(np.log(lo), np.log(hi)))), -2)
        k = int(min(len(PARTS), rng.geometric(t["damaged_parts_geometric_p"]) - 1))
        damaged = {str(p): "replace" if rng.random() < t["replace_share"] else "repairable"
                   for p in rng.choice(PARTS, size=k, replace=False)}  # fmt: skip
        rest = "fine" if rng.random() < t["rest_fine_share"] else "unknown"
        flags = {f: "unknown" if rng.random() < t["unstated"]["flags"] else bool(rng.random() < p)
                 for f, p in t["flag_true"].items()}  # fmt: skip
        ratio = float(np.clip(cr["base"] - cr["per_damaged_part"] * k + rng.normal(0, cr["sd"]),
                              0.05, 0.95))  # fmt: skip
        comps = [int(round(clean * ratio * float(rng.lognormal(0, cr["spread_sigma"])), -1))
                 for _ in range(int(rng.integers(t["comps_count"][0], t["comps_count"][1] + 1)))]
        body: dict[str, Any] = {
            "reader": "rules", "vin": f"SYN{i:014d}",
            "vehicle": {"year": int(rng.integers(t["year"][0], t["year"][1] + 1)),
                        "make": "Synth", "model": "Car"},
            "title_status": _pick(rng, t["title_share"]),
            "mileage": int(rng.integers(*t["mileage"])),
            "grades": [{"part": p, "grade": damaged.get(p, rest)} for p in PARTS],
            "flags": flags,
            "values": {"clean_wholesale": clean, "salvage_comps": comps},
        }  # fmt: skip
        for field, shares in t["stated"].items():
            value = _pick(rng, shares)
            stated = rng.random() >= t["unstated"][field]
            body[field] = tri.get(value, value) if stated else "unknown"
        if rng.random() < t["app_repair_estimate_share"]:  # else the engine's own panel costs
            cost = t["part_cost_dollars"]
            body["repair"] = {"low": sum(cost[g][0] for g in damaged.values()),
                              "high": sum(cost[g][1] for g in damaged.values())}  # fmt: skip
        rows.append(body)
    return rows


def label(body: dict[str, Any], a: Assumptions) -> TrainingRow:
    """Label one body with the engine's dollar simulation (source "simulation")."""
    from underscope.bridge import DESTINATION, eligible_paths, to_engine
    from underscope.decision import destination_share, simulate
    from underscope.valuation import value_vehicle

    vehicle, findings, _ = to_engine(body, a)
    paths, _ = eligible_paths(body.get("title_status") or "unknown", a)
    nets = simulate(vehicle, value_vehicle(vehicle, findings, a), a).nets
    best = {"ACV": float("-inf"), "Copart": float("-inf")}
    for p in paths:
        if DESTINATION[p] in best:
            best[DESTINATION[p]] = max(best[DESTINATION[p]], float(nets[p].mean()) / 100)
    outcome = Outcome(acv_net=round(best["ACV"], 2), copart_net=round(best["Copart"], 2),
                      p_acv=round(destination_share(nets, paths), 4))  # fmt: skip
    return TrainingRow(assessment=body, outcome=outcome, source="simulation")


def simulated_rows(n: int, seed: int = 7, a: Assumptions | None = None) -> list[TrainingRow]:
    a = a or default_assumptions()
    return [label(b, a) for b in generate(n, seed, a)]


# ---------- The model ----------


class RouterModel:
    def __init__(self, clf: Any, meta: dict[str, Any]):
        self.clf, self.meta = clf, meta

    def p_acv(self, x: dict[str, float | str]) -> float:
        return float(self.clf.predict_proba(np.array([vector(x)]))[0, 1])

    def summary(self) -> dict[str, Any]:
        h = self.meta.get("held_out", {})
        return {"trained_on": self.meta.get("trained_on"), "rows": self.meta.get("rows"),
                "agreement": h.get("agreement")}  # fmt: skip


@lru_cache(maxsize=4)
def _load(path: str) -> RouterModel | None:
    p = FsPath(path)
    try:
        import joblib

        meta = json.loads(p.with_suffix(".json").read_text())
        if tuple(meta.get("features", ())) != FEATURES:
            return None  # trained for other features: retrain with `underscope train-router`
        return RouterModel(joblib.load(p), meta)
    except Exception:  # no file, no scikit-learn, or a file from another version
        return None


def load_model() -> RouterModel | None:
    """The saved model, or None (then the simulation decides)."""
    path = os.environ.get(ENV) or str(MODEL_PATH)
    return None if path == "off" else _load(path)


def _band(p: np.ndarray, a: Assumptions) -> np.ndarray:
    r = a["routing"]
    return np.where(p >= r["clear_above"], 2, np.where(p <= r["clear_below"], 0, 1))


def train(rows: Iterable[TrainingRow], seed: int = 7, a: Assumptions | None = None) -> RouterModel:
    """Fit the classifier on training rows and score it on the last share of them (held out).
    Rows are used in the order given, so shuffle a file that is sorted by date or outcome."""
    from threadpoolctl import threadpool_limits

    a = a or default_assumptions()
    with threadpool_limits(limits=a["router_training"]["model"]["threads"]):
        return _train(list(rows), seed, a)


def _train(rows: list[TrainingRow], seed: int, a: Assumptions) -> RouterModel:
    import sklearn
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.inspection import permutation_importance

    m = a["router_training"]["model"]
    cut = int(len(rows) * (1 - m["held_out_share"]))
    if cut < 50 or len(rows) - cut < 10:
        raise ValueError(f"{len(rows)} training rows is too few to fit and hold some out")
    X = np.array([vector(features(Assessment.model_validate(r.assessment), a)) for r in rows])
    # A fact no training car states teaches nothing: the model gets no split on it and ignores
    # it when serving. (scikit-learn cannot bin a column with no values, so it is zeroed here.)
    unseen = np.isnan(X[:cut]).all(axis=0)
    X[:, unseen] = 0.0
    acv = np.array([r.outcome.acv_net for r in rows])
    cop = np.array([r.outcome.copart_net for r in rows])
    won = acv >= cop
    # The target is the chance ACV nets more. A simulated row carries that share; a recorded
    # row has one result, so it counts fully for the marketplace that paid more.
    p = np.array([float(w) if r.outcome.p_acv is None else r.outcome.p_acv
                  for r, w in zip(rows, won, strict=True)])  # fmt: skip
    clf = HistGradientBoostingClassifier(
        max_iter=m["max_iter"], learning_rate=m["learning_rate"], random_state=seed,
        early_stopping=False, categorical_features=list(range(len(NUMERIC), len(FEATURES))),
    )  # fmt: skip
    # Each car counts as ACV with weight p and as Copart with the rest.
    clf.fit(np.vstack([X[:cut], X[:cut]]), np.r_[np.ones(cut), np.zeros(cut)],
            sample_weight=np.r_[p[:cut], 1 - p[:cut]])  # fmt: skip

    Xt, pt = X[cut:], p[cut:]
    pred = clf.predict_proba(Xt)[:, 1]
    best_acv, model_acv = won[cut:], pred >= a["routing"]["model_acv_at"]
    wrong = model_acv != best_acv
    lost = np.where(wrong, np.abs(acv[cut:] - cop[cut:]), 0.0)
    imp = permutation_importance(clf, Xt, best_acv, n_repeats=3, random_state=seed)
    top = sorted(zip(FEATURES, imp.importances_mean, strict=True), key=lambda t: -t[1])[:12]
    sources = sorted({r.source for r in rows})
    meta = {
        "trained_on": " and ".join(f"{s} outcomes" for s in sources).replace(
            "simulation outcomes", "simulated outcomes"),
        "sources": {s: sum(r.source == s for r in rows) for s in sources},
        "model": "HistGradientBoostingClassifier", "scikit_learn": sklearn.__version__,
        "seed": seed, "rows": cut, "features": list(FEATURES),
        "held_out": {
            "rows": int(len(pt)),
            "agreement": round(float((~wrong).mean()), 4),
            "p_acv_mean_abs_error": round(float(np.abs(pred - pt).mean()), 4),
            "band_agreement": round(float((_band(pred, a) == _band(pt, a)).mean()), 4),
            "acv_share": round(float(best_acv.mean()), 4),
            "dollars_lost_per_car": round(float(lost.mean()), 2),
            "dollars_lost_per_miss": round(float(lost[wrong].mean()) if wrong.any() else 0.0, 2),
            "worst_miss_dollars": round(float(lost.max()), 2),
        },
        "top_features": [[k, round(float(v), 4)] for k, v in top],
        "features_never_stated_in_training": [f for f, u in zip(FEATURES, unseen, strict=True)
                                              if u],
    }  # fmt: skip
    return RouterModel(clf, meta)


def report(meta: dict[str, Any]) -> str:
    h = meta["held_out"]
    simulated = "recorded" not in meta["sources"]
    truth = "the simulation" if simulated else "the recorded outcome"
    lines = [
        "# Router model: ACV or Copart",
        "",
        ("**Trained on simulated outcomes, not real sales.** The training cars are made up and "
         "labelled by the engine's own dollar simulation, so these numbers say how closely the "
         "model copies the simulation. They say nothing about how often either is right about "
         "the market." if simulated else
         f"Trained on {meta['trained_on']}: " + ", ".join(
             f"{n:,} {s}" for s, n in meta["sources"].items()) + " rows."),
        "",
        f"- Model: {meta['model']} (scikit-learn {meta['scikit_learn']}), seed {meta['seed']}",
        f"- Training cars: {meta['rows']:,}; held out: {h['rows']:,}",
        f"- Features: {len(meta['features'])}, all read straight from the reader's JSON",
        "",
        "| On the held-out cars | |",
        "|---|---|",
        f"| Same marketplace as {truth} | {h['agreement']:.1%} |",
        f"| Same confidence band (clear or close call) | {h['band_agreement']:.1%} |",
        f"| Mean error of p_acv | {h['p_acv_mean_abs_error']:.3f} |",
        f"| ACV is the better marketplace | {h['acv_share']:.1%} |",
        f"| Dollars lost per car by following the model | ${h['dollars_lost_per_car']:,.0f} |",
        f"| Dollars lost per miss | ${h['dollars_lost_per_miss']:,.0f} |",
        f"| Largest single miss | ${h['worst_miss_dollars']:,.0f} |",
        "",
        "Features that matter most (drop in agreement when the feature is shuffled):",
        "",
        *[f"- `{k}`: {v:.3f}" for k, v in meta["top_features"]],
        "",
        "Regenerate with `underscope train-router` (add `--data rows.jsonl` for recorded "
        "outcomes).",
        "",
    ]  # fmt: skip
    return "\n".join(lines)


def save(model: RouterModel, path: FsPath = MODEL_PATH) -> None:
    import joblib

    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model.clf, path)
    path.with_suffix(".json").write_text(json.dumps(model.meta, indent=2) + "\n")
    _load.cache_clear()

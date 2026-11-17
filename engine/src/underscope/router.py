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

from underscope.assessment import (
    ENUMS,
    EXPECTED,
    FLAGS,
    PARTS,
    TRI_FIELDS,
    Assessment,
    expectations,
    precision_level,
)
from underscope.config import ROOT, Assumptions, default_assumptions

MODEL_PATH = ROOT / "models" / "router.joblib"
META_PATH = ROOT / "models" / "router.json"
REPORT_PATH = ROOT / "reports" / "router.md"
RATES_PATH = ROOT / "config" / "reader_given_rates.json"
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "reader_assessments.jsonl"
LEVELS = ("full", "reduced", "low")
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
    # The same amounts in dollars: they still say something when the clean value is not given.
    "comps_median_usd", "app_repair_high_usd", "repair_quote_usd", "reserve_price_usd",
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
        "comps_median_usd": float(np.median(comps)) if comps else NAN,
        "app_repair_high_usd": _num(repair.get("high")),
        "repair_quote_usd": _num(s.values.get("repair_estimate")),
        "reserve_price_usd": _num(s.values.get("reserve_price")),
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
    # How complete the description was (full / reduced / low); worked out when absent.
    level: Literal["full", "reduced", "low"] | None = None


def read_rows(path: str | FsPath) -> list[TrainingRow]:
    """A .jsonl file of training rows. A real sale shows one marketplace only; a row needs both
    nets, so the other side must come from a relist or a per-marketplace price estimate."""
    lines = FsPath(path).read_text(encoding="utf-8").splitlines()
    return [TrainingRow.model_validate_json(line) for line in lines if line.strip()]


# Facts the reader's output may or may not give, beyond its own EXPECTED list.
_EXTRA_FIELDS = ("vehicle.year", "flags.fire_damage", "parts_missing", "already_repaired",
                 "drivetrain", "fuel_type", "title_state", "secondary_damage", "warning_lights",
                 "codes", "symptoms")  # fmt: skip
MASK_FIELDS = (*(e[0] for e in EXPECTED), *_EXTRA_FIELDS)
_AREA = {"front": ("front_bumper", "hood", "grille", "left_headlight", "right_headlight",
                   "windshield", "left_front_fender", "right_front_fender"),
         "rear": ("rear_bumper", "tailgate_or_rear_doors", "left_taillight", "right_taillight",
                  "left_rear_quarter", "right_rear_quarter"),
         "side": ("left_front_door", "right_front_door", "left_rear_door", "right_rear_door",
                  "left_mirror", "right_mirror"),
         "undercarriage": ("underbody", "wheels_and_tires"), "mechanical": ("engine_bay",),
         "rollover": ("roof",)}  # fmt: skip


def _given(a: dict[str, Any], field: str) -> bool:
    """Whether a reader output gives one of the extra fields."""
    v: Any = a
    for key in field.split("."):
        v = v.get(key) if isinstance(v, dict) else None
    return v not in (None, "unknown", [])


def given_rates(fixture: str | FsPath = FIXTURE_PATH) -> dict[str, Any]:
    """How often the reader's own output gives each fact, by kind of row, measured on the
    reader's fixture ({id, kind, a} lines). Saved to config/reader_given_rates.json."""
    rows = [json.loads(x) for x in FsPath(fixture).read_text().splitlines() if x.strip()]
    profiles = {}
    for name, kind in (("sparse", "rules"), ("medium", "label")):
        seen: dict[str, list[bool]] = {f: [] for f in MASK_FIELDS}
        picked = [r["a"] for r in rows if r.get("kind") == kind]
        for a in picked:
            for e in expectations(Assessment.model_validate(a)):
                seen[e["field"]].append(e["given"])
            for f in _EXTRA_FIELDS:
                seen[f].append(_given(a, f))
        profiles[name] = {"rows": len(picked), "given": {
            f: round(sum(v) / len(v), 3) if v else 0.0 for f, v in seen.items()}}  # fmt: skip
    return {"source": "tests/fixtures/reader_assessments.jsonl (reader output; kind rules = "
                      "sparse, kind label = medium)", "profiles": profiles}  # fmt: skip


@lru_cache(maxsize=1)
def load_rates() -> dict[str, dict[str, float]]:
    """Per profile, the chance each fact is given. needed and full are derived."""
    saved = json.loads(RATES_PATH.read_text())["profiles"]
    sparse, medium = saved["sparse"]["given"], saved["medium"]["given"]
    needed = {e[0] for e in EXPECTED if e[1] == "needed"}
    return {"sparse": sparse, "medium": medium, "full": dict.fromkeys(MASK_FIELDS, 1.0),
            "needed": {f: 1.0 if f in needed else medium[f] for f in MASK_FIELDS}}  # fmt: skip


def _pick(rng: np.random.Generator, shares: dict[str, float]) -> str:
    keys = list(shares)
    p = np.array([shares[k] for k in keys], dtype=float)
    return str(keys[int(rng.choice(len(keys), p=p / p.sum()))])


def generate(n: int, seed: int = 7, a: Assumptions | None = None) -> list[dict[str, Any]]:
    """n MADE-UP cars with every fact stated, as full Assessments, seeded (config
    `router_training`). Not real cars."""
    a = a or default_assumptions()
    t = a["router_training"]
    rng = np.random.default_rng(seed)
    tri = {"yes": True, "no": False}
    states = [*a["total_loss"]["threshold_pct_by_region"], "PA", "GA", "IL", "AZ"]
    lo, hi = t["clean_value_dollars"]
    cr, cp = t["comps_ratio"], t["complaints"]
    systems = list(a["signals"]["symptom"])
    unknown = a["condition"]["unknown"]

    def flag_true(flag: str) -> float:
        return unknown[flag]["chance_pct"] / 100 if flag in unknown else t["flag_true"][flag]

    rows = []
    for _ in range(n):
        clean = round(float(np.exp(rng.uniform(np.log(lo), np.log(hi)))), -2)
        k = int(min(len(PARTS), rng.geometric(t["damaged_parts_geometric_p"]) - 1))
        damaged = {str(p): "replace" if rng.random() < t["replace_share"] else "repairable"
                   for p in rng.choice(PARTS, size=k, replace=False)}  # fmt: skip
        hits = {area: sum(p in damaged for p in parts) for area, parts in _AREA.items()}
        ranked = sorted(hits, key=lambda x: -hits[x])
        primary = "none" if not damaged else ranked[0] if hits[ranked[0]] else "minor"
        ratio = float(np.clip(cr["base"] - cr["per_damaged_part"] * k + rng.normal(0, cr["sd"]),
                              0.05, 0.95))  # fmt: skip
        comps = [int(round(clean * ratio * float(rng.lognormal(0, cr["spread_sigma"])), -1))
                 for _ in range(int(rng.integers(t["comps_count"][0], t["comps_count"][1] + 1)))]
        region = str(rng.choice(states))
        other = rng.random() < t["out_of_state_title_share"]
        body: dict[str, Any] = {
            "reader": "rules", "vin": None,
            "vehicle": {"year": int(rng.integers(t["year"][0], t["year"][1] + 1)),
                        "make": "Synth", "model": "Car", "trim": None},
            "title_status": _pick(rng, t["title_share"]),
            "title_state": str(rng.choice(states)) if other else region,
            "mileage": int(rng.integers(*t["mileage"])),
            "region": region,
            "seller_type": _pick(rng, t["seller_share"]),
            "drivetrain": _pick(rng, t["drivetrain_share"]),
            "fuel_type": _pick(rng, t["fuel_share"]),
            "primary_damage": primary,
            "secondary_damage": ranked[1] if len(damaged) > 2 and hits[ranked[1]] else "none",
            "grades": [{"part": p, "grade": damaged.get(p, "fine")} for p in PARTS],
            "flags": {f: bool(rng.random() < flag_true(f)) for f in FLAGS},
            "warning_lights": [str(x) for x in rng.choice(
                ["check_engine", "abs", "airbag", "other"], size=int(rng.integers(1, 3)),
                replace=False)] if rng.random() < cp["warning_light_share"] else [],
            "codes": [{"code": f"{rng.choice(list('PPPCBU'))}{int(rng.integers(100, 2000)):04d}",
                       "status": str(rng.choice(["confirmed", "pending", "history"]))}
                      for _ in range(int(rng.integers(1, 4)))]
                     if rng.random() < cp["code_share"] else [],
            "symptoms": [{"system": str(rng.choice(systems)), "text": "made-up complaint"}
                         for _ in range(int(rng.integers(1, 3)))]
                        if rng.random() < cp["symptom_share"] else [],
            "values": {"clean_wholesale": clean, "salvage_comps": comps, "purchase_price": None,
                       "repair_estimate": None,
                       "reserve_price": int(round(clean * rng.uniform(*t["reserve_ratio"]), -2))},
            "evidence": {"grades.rest": "everything else is fine"},
        }  # fmt: skip
        for field, shares in t["stated"].items():
            bad = unknown.get(field.removesuffix("_condition"))
            if bad and rng.random() < bad["chance_pct"] / 100:
                value = str(bad["value"])
            else:
                rest = {k: v for k, v in shares.items() if not bad or k != str(bad["value"])}
                value = _pick(rng, rest)
            body[field] = tri.get(value, value)
        cost = t["part_cost_dollars"]
        fix_lo = sum(cost[g][0] for g in damaged.values())
        fix_hi = sum(cost[g][1] for g in damaged.values())
        if rng.random() < t["app_repair_estimate_share"]:
            body["repair"] = {"low": fix_lo, "high": fix_hi}
        if damaged and rng.random() < t["seller_quote_share"]:  # a seller's shop quote
            body["values"]["repair_estimate"] = int(round(rng.uniform(fix_lo, fix_hi), -1))
        if rng.random() < t["storage_cost"]["share"]:
            body["storage_cost_per_day"] = int(rng.integers(*t["storage_cost"]["dollars_per_day"]))
        if rng.random() < t["sell_by"]["share"]:
            body["sell_by_days"] = int(rng.integers(*t["sell_by"]["days"]))
        body["already_repaired"] = _pick(rng, t["already_repaired"])
        rows.append(body)
    return rows


def mask(full: dict[str, Any], given: dict[str, float], rng: np.random.Generator,
         ) -> tuple[dict[str, Any], set[str]]:  # fmt: skip
    """What a reader would hand over for this car: each fact is kept with its chance in
    `given` and hidden otherwise ("unknown", null or an empty list, as the reader writes it).
    Returns the body and the set of hidden facts."""
    import copy

    out = copy.deepcopy(full)
    hidden = {f for f in MASK_FIELDS if rng.random() >= given.get(f, 1.0)}
    for f in hidden:
        head, _, leaf = f.partition(".")
        if f == "grades":
            for g in out["grades"]:
                g["grade"] = "unknown"
            out.pop("repair", None)  # the page prices the parts it is told about
        elif f == "grades.rest":
            for g in out["grades"]:
                g["grade"] = "unknown" if g["grade"] == "fine" else g["grade"]
        elif f == "values.salvage_comps":
            out["values"]["salvage_comps"] = out["values"]["salvage_comps"][: int(rng.integers(3))]
        elif f in ("warning_lights", "codes", "symptoms"):
            out[f] = []
        elif head == "flags":
            out["flags"][leaf] = "unknown"
        elif head in ("values", "vehicle"):
            out[head][leaf] = None
        elif f in ("mileage", "region", "title_state"):
            out[f] = None
        else:
            out[f] = "unknown"
    if hidden & {"grades", "grades.rest"}:
        out["evidence"] = {}
    return out, hidden


def level_of(body: dict[str, Any]) -> str:
    return precision_level(expectations(Assessment.model_validate(body)))


def label(full: dict[str, Any], a: Assumptions, seen: dict[str, Any] | None = None,
          level: str | None = None) -> TrainingRow | None:  # fmt: skip
    """Label a car with the engine's dollar simulation run on everything known about it
    (`full`); the row keeps what the model is shown (`seen`, default the same). None when the
    rules leave one marketplace: the model is not asked then, so there is nothing to learn."""
    from underscope.bridge import DESTINATION, exits, to_engine
    from underscope.decision import destination_share, simulate
    from underscope.valuation import value_vehicle

    vehicle, findings, _ = to_engine(full, a)
    val = value_vehicle(vehicle, findings, a)
    title = full.get("title_status") or "unknown"
    paths, _, rule, _ = exits(Assessment.model_validate(full), title, vehicle, val, a)
    if rule is not None:
        return None
    nets = simulate(vehicle, val, a).nets
    best = {"ACV": float("-inf"), "Copart": float("-inf")}
    for p in paths:
        if DESTINATION[p] in best:
            best[DESTINATION[p]] = max(best[DESTINATION[p]], float(nets[p].mean()) / 100)
    outcome = Outcome(acv_net=round(best["ACV"], 2), copart_net=round(best["Copart"], 2),
                      p_acv=round(destination_share(nets, paths), 4))  # fmt: skip
    seen = full if seen is None else seen
    return TrainingRow(assessment=seen, outcome=outcome, source="simulation",
                       level=level or level_of(seen))  # fmt: skip


def simulated_rows(n: int, seed: int = 7, a: Assumptions | None = None) -> list[TrainingRow]:
    """n made-up cars: labelled on full information, shown to the model with facts hidden the
    way the reader's output hides them. Cars a rule decides are left out."""
    a = a or default_assumptions()
    rates, shares = load_rates(), a["router_training"]["profiles"]
    rng = np.random.default_rng(seed + 1)
    rows = []
    for full in generate(n, seed, a):
        seen, hidden = mask(full, rates[_pick(rng, shares)], rng)
        level = level_of(seen)
        if "title_status" in hidden:
            # An unknown title is always run as clean and as salvage (bridge.route), so the
            # model only ever sees a title. This car is the clean branch of that question.
            full = {**full, "title_status": "clean"}
            seen["title_status"] = "clean"
        if "sell_by_days" in full and seen.get("sell_by_days") is None:
            seen["sell_by_days"] = full["sell_by_days"]
        row = label(full, a, seen, level)
        if row is not None:
            rows.append(row)
    return rows


# ---------- The model ----------


class RouterModel:
    def __init__(self, clf: Any, meta: dict[str, Any]):
        self.clf, self.meta = clf, meta

    def p_acv(self, x: dict[str, float | str]) -> float:
        return float(self.p_acv_many([x])[0])

    def p_acv_many(self, xs: list[dict[str, float | str]]) -> np.ndarray:
        """One call for many cars. One thread: a single car needs no more, and a server
        answering several requests at once must not start a thread pool for each."""
        from threadpoolctl import threadpool_limits

        with threadpool_limits(limits=1):
            return self.clf.predict_proba(np.array([vector(x) for x in xs]))[:, 1]

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
    levels = np.array([r.level or level_of(r.assessment) for r in rows[cut:]])
    by_level = {lv: {"rows": int((levels == lv).sum()),
                     "agreement": round(float((~wrong[levels == lv]).mean()), 4),
                     "dollars_lost_per_car": round(float(lost[levels == lv].mean()), 2)}
                for lv in LEVELS if (levels == lv).any()}  # fmt: skip
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
            "by_level": by_level,
        },
        "top_features": [[k, round(float(v), 4)] for k, v in top],
        "features_never_stated_in_training": [f for f, u in zip(FEATURES, unseen, strict=True)
                                              if u],
    }  # fmt: skip
    return RouterModel(clf, meta)


def fixture_check(model: RouterModel, a: Assumptions | None = None,
                  fixture: str | FsPath = FIXTURE_PATH) -> dict[str, Any] | None:  # fmt: skip
    """A sanity check on the reader's own output, not a training target: where the model
    decides, does it name the marketplace the simulation names on the same incomplete
    Assessment? By kind of row. None when the fixture is not in this checkout."""
    from underscope.bridge import _route

    if not FsPath(fixture).is_file():
        return None
    a = a or default_assumptions()
    out: dict[str, Any] = {}
    for line in filter(str.strip, FsPath(fixture).read_text().splitlines()):
        row = json.loads(line)
        got = _route(row["a"], a, model)
        k = out.setdefault(row.get("kind", "?"), {"rows": 0, "model_decides": 0, "same": 0})
        k["rows"] += 1
        if got["decided_by"] == "model":
            k["model_decides"] += 1
            k["same"] += got["destination"] == _route(row["a"], a, None)["destination"]
    for k in out.values():
        k["agreement"] = round(k["same"] / k["model_decides"], 4) if k["model_decides"] else None
    return out


def policy_check(model: RouterModel, n: int = 3000, seed: int = 1007,
                 a: Assumptions | None = None) -> dict[str, Any]:  # fmt: skip
    """The engine as it answers (bridge.route: the simulation when the clean value and comps are
    given, the model otherwise) on fresh made-up cars, not the training ones: how often it names
    the marketplace the simulation picks with everything known about the car."""
    from underscope.bridge import route

    a = a or default_assumptions()
    tally: dict[str, dict[str, list[int]]] = {"by_level": {}, "by_decider": {}}
    total = [0, 0]
    for r in simulated_rows(n, seed, a):
        out = route(r.assessment, a, model)
        if out["decided_by"] not in ("model", "simulation") or out["confidence"] == "insufficient":
            continue
        truth = "ACV" if r.outcome.acv_net >= r.outcome.copart_net else "Copart"
        same = int(out["destination"] == truth)
        for group, key in (("by_level", out["precision"]["level"]),
                           ("by_decider", out["decided_by"])):
            k = tally[group].setdefault(key, [0, 0])
            k[0] += same
            k[1] += 1
        total[0] += same
        total[1] += 1
    share = lambda k: {"rows": k[1], "agreement": round(k[0] / k[1], 4) if k[1] else None}  # noqa: E731
    return {"cars": n, "seed": seed, **share(total),
            **{g: {key: share(k) for key, k in sorted(v.items())} for g, v in tally.items()}}


def report(meta: dict[str, Any]) -> str:
    d = meta.get("deployed")
    names_d = {"full": "full (every expected fact given)", "reduced": "reduced (only helpful "
               "facts missing)", "low": "low (a needed fact missing)",
               "simulation": "the simulation decides (clean value and comps given)",
               "model": "the model decides (a money fact missing)"}  # fmt: skip
    deployed = [] if not d else [
        "## The engine as it answers",
        "",
        "The simulation decides when the seller gives the clean value and the comps; the model "
        f"decides otherwise. Measured on {d['cars']:,} fresh made-up cars (seed {d['seed']}, not "
        "the training cars), against the simulation run on everything about the car. Still "
        "agreement with the engine's own simulation, not accuracy on real sales.",
        "",
        "| | Cars | Same marketplace |",
        "|---|---|---|",
        *[f"| {names_d.get(k, k)} | {v['rows']:,} | {v['agreement']:.1%} |"
          for g in ("by_level", "by_decider") for k, v in d[g].items() if v["rows"]],
        f"| all | {d['rows']:,} | {d['agreement']:.1%} |",
        "",
    ]
    h = meta["held_out"]
    simulated = "recorded" not in meta["sources"]
    truth = "the full-information simulation" if simulated else "the recorded outcome"
    names = {"full": "full (every expected fact given)",
             "reduced": "reduced (only helpful facts missing)",
             "low": "low (a needed fact missing)"}  # fmt: skip
    levels = [
        "## By how much the description gives",
        "",
        "The model sees the car the way the reader would hand it over, with facts hidden. The "
        "answer it is scored against is the simulation run on everything about the car. So "
        "this is agreement with the engine's own simulation given full information. It is not "
        "accuracy on real sales.",
        "",
        "| Precision level | Held-out cars | Same marketplace | Dollars lost per car |",
        "|---|---|---|---|",
        *[f"| {names[lv]} | {v['rows']:,} | {v['agreement']:.1%} | "
          f"${v['dollars_lost_per_car']:,.0f} |" for lv, v in h.get("by_level", {}).items()],
        f"| all | {h['rows']:,} | {h['agreement']:.1%} | ${h['dollars_lost_per_car']:,.0f} |",
        "",
    ]  # fmt: skip
    fx = meta.get("reader_fixture")
    fixture = [] if not fx else [
        "## Sanity check on the reader's own output",
        "",
        "The reader's fixture rows (tests/fixtures/reader_assessments.jsonl), where the model "
        "decides: does it name the same marketplace as the simulation run on the same "
        "incomplete description? Not a training target, and not a measure of being right: "
        "with facts missing the simulation itself runs on placeholders.",
        "",
        "| Kind of row | Rows | Model decides | Same marketplace as the simulation |",
        "|---|---|---|---|",
        *[f"| {kind} | {v['rows']} | {v['model_decides']} | "
          + (f"{v['agreement']:.1%} |" if v["agreement"] is not None else "n/a |")
          for kind, v in fx.items()],
        "",
    ]  # fmt: skip
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
        *levels,
        *deployed,
        *fixture,
        "## Features that matter most",
        "",
        "Drop in agreement when the feature is shuffled:",
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

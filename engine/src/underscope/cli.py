"""Command line interface."""

from __future__ import annotations

import json
import sys
from enum import Enum
from pathlib import Path as FsPath
from typing import Annotated

import typer
from pydantic import ValidationError

from underscope import review
from underscope.decision import LABEL, evaluate
from underscope.models import Recommendation, VehicleRecord
from underscope.perception import MockDetector


class DetectorName(str, Enum):
    MOCK = "mock"
    OPENAI = "openai"
    CLAUDE = "claude"


NoCache = Annotated[
    bool,
    typer.Option("--no-cache", help="Ask the vision model again even for photos it answered."),
]

# Written by `underscope learn` from checker-confirmed reviews; used automatically when present.
LEARNED_CALIBRATION = FsPath(".cache/learned_calibration.json")


def _load_dotenv() -> None:
    """Read KEY=VALUE lines from the nearest .env (this folder or a parent) into the
    environment, without overriding variables already set. Values are never printed."""
    import os

    for folder in [FsPath.cwd(), *FsPath.cwd().parents]:
        env = folder / ".env"
        if env.is_file():
            for line in env.read_text(encoding="utf-8").splitlines():
                key, sep, value = line.strip().partition("=")
                if sep and key and not key.startswith("#"):
                    os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
            return


def _make_detector(
    name: DetectorName,
    labels: FsPath | None,
    photo_root: FsPath,
    calibration: FsPath | None = None,
    cache: bool = True,
):
    if name in (DetectorName.OPENAI, DetectorName.CLAUDE):
        from underscope import calibration as cal
        from underscope.vision import DEFAULT_CACHE_DIR, ClaudeVisionDetector, OpenAIVisionDetector

        if calibration is None and LEARNED_CALIBRATION.is_file():
            calibration = LEARNED_CALIBRATION  # what `learn` taught it from checker reviews
        table = cal.load(calibration) if calibration else None
        cls = OpenAIVisionDetector if name == DetectorName.OPENAI else ClaudeVisionDetector
        return cls(photo_root, calibration=table, cache_dir=DEFAULT_CACHE_DIR if cache else None)
    return MockDetector.from_file(labels) if labels else MockDetector()


def _cost_gate(detector, photo_refs: list[str], yes: bool, hint: str = "") -> None:
    """Before a paid run, say what it costs and stop unless --yes. Cached photos are free."""
    from underscope.vision import estimated_cost_usd

    if yes or not hasattr(detector, "uncached"):  # only the paid detectors have a cache
        return
    todo = detector.uncached(list(dict.fromkeys(photo_refs)))
    if not todo:
        return
    cached = len(set(photo_refs)) - len(todo)
    reuse = f" ({cached} more already answered, reused free)" if cached else ""
    estimate = getattr(detector, "estimate_usd", estimated_cost_usd)
    typer.echo(f"This sends {len(todo)} photos to {detector.model}{reuse}, roughly "
               f"${estimate(len(todo)):,.2f}. Re-run with --yes to go ahead{hint}.")  # fmt: skip
    raise typer.Exit(1)

AWAITING_CONFIRMATION = 3  # exit code: findings written for a checker, decision not made yet

app = typer.Typer(
    help="UnderScope: disposition decisions for damaged vehicles.", no_args_is_help=True
)


def _money(cents: int) -> str:
    return f"{'-' if cents < 0 else ''}${abs(cents) / 100:,.0f}"


def render(vehicle: VehicleRecord, rec: Recommendation) -> str:
    lines = [
        f"{vehicle.year} {vehicle.make} {vehicle.model} {vehicle.trim}".strip()
        + f"  VIN {vehicle.vin}  ({vehicle.region}, {vehicle.mileage:,} mi, "
        f"{vehicle.title_status}{', insurance claim' if vehicle.insurance_claim else ''})",
        "",
        f"RECOMMENDATION: {LABEL[rec.winner]}",
        rec.answer,
    ]
    if rec.needs_human_review:
        lines.append("** NEEDS HUMAN REVIEW **")
    lines += ["", f"{'Path':<28}{'Expected':>10}{'P10':>10}{'P50':>10}{'P90':>10}"]
    for o in rec.options:
        lines.append(
            f"{LABEL[o.path]:<28}{_money(o.expected_cents):>10}{_money(o.p10_cents):>10}"
            f"{_money(o.p50_cents):>10}{_money(o.p90_cents):>10}"
        )
    lines += ["", rec.explanation]
    if rec.review_reasons:
        lines += ["", "Review reasons:", *(f"  - {r}" for r in rec.review_reasons)]
    if rec.flip_conditions:
        lines += ["", "What would flip it:", *(f"  - {c}" for c in rec.flip_conditions)]
    lines += ["", "(Values use PLACEHOLDER assumptions in config/assumptions.yaml.)"]
    return "\n".join(lines)


@app.callback()
def main() -> None:
    """UnderScope command line."""
    _load_dotenv()


def _load_vehicle(path: FsPath) -> VehicleRecord:
    """Parse a vehicle file; raises ValueError with a readable message when it's invalid."""
    try:
        return VehicleRecord(**json.loads(path.read_text()))
    except json.JSONDecodeError as err:
        raise ValueError(f"invalid vehicle file {path}: not JSON ({err.msg})") from err
    except (ValidationError, TypeError) as err:
        first = err.errors()[0] if isinstance(err, ValidationError) else {"msg": str(err)}
        where = ".".join(str(x) for x in first.get("loc", ())) or "file"
        raise ValueError(f"invalid vehicle file {path}: {where}: {first['msg']}") from err


def _detect(detector, vehicle: VehicleRecord):
    """Run the detector; a photo it can't analyze ends the command with a clear message."""
    try:
        return detector.detect(vehicle)
    except Exception as err:
        from underscope.vision import DetectionError

        if not isinstance(err, DetectionError):
            raise
        typer.echo(f"Damage detection failed: {err}", err=True)
        raise typer.Exit(2) from err


def _views(detector, vehicle: VehicleRecord) -> dict[str, str]:
    """Which side of the car each of this vehicle's photos shows, when the detector says."""
    views = getattr(detector, "views", {})
    return {ref: views[ref] for ref in vehicle.photo_refs if ref in views}


def _sightings(detector, vehicle: VehicleRecord):
    """Each photo's own findings before merging (with boxes), when the detector keeps them."""
    seen = getattr(detector, "sightings", {})
    return [f for ref in vehicle.photo_refs for f in seen.get(ref, [])]


def _unmapped_reasons(detector) -> list[str]:
    """Damage the detector saw but couldn't place on a panel goes to the checker."""
    notes = getattr(detector, "notes", {})
    return [f"Seen in {ref} but not on a modeled panel: {note}"
            for ref, items in notes.items() for note in items]  # fmt: skip


def _yes_no(text: str) -> bool:
    if text.lower() in ("y", "yes", "true"):
        return True
    if text.lower() in ("n", "no", "false"):
        return False
    raise ValueError(f"expected yes or no, got {text!r}")


PROMPT_HELP = """Commands:
  a                      accept the findings and continue to the decision
  + panel type severity [side]  add a finding (e.g. + door dent 0.6 left)
  - N                    remove finding #N
  s N severity           set the severity of finding #N
  u yes|no               undercarriage damage present?
  e yes|no               abnormal engine audio?
  q                      stop; leave the review pending"""


def _interactive_review(req: review.ReviewRequest, review_dir: FsPath) -> bool:
    """Walk the checker through the findings. True once confirmed, False if they quit."""
    typer.echo(PROMPT_HELP)
    while True:
        cmd = typer.prompt("review").strip().split()
        try:
            if not cmd:
                continue
            if cmd[0] == "a":
                review.confirm(req, typer.prompt("Checker name"))
                review.save(req, review_dir)
                return True
            if cmd[0] == "q":
                review.save(req, review_dir)
                return False
            if cmd[0] == "+" and len(cmd) in (4, 5):
                review.add_finding(req, cmd[1], cmd[2], float(cmd[3]),
                                   cmd[4] if len(cmd) == 5 else None)  # fmt: skip
            elif cmd[0] == "-" and len(cmd) == 2:
                review.remove_finding(req, int(cmd[1]))
            elif cmd[0] == "s" and len(cmd) == 3:
                review.set_severity(req, int(cmd[1]), float(cmd[2]))
            elif cmd[0] in ("u", "e") and len(cmd) == 2:
                review.set_flag(req, "undercarriage" if cmd[0] == "u" else "engine",
                                _yes_no(cmd[1]))  # fmt: skip
            else:
                typer.echo(PROMPT_HELP)
                continue
        except ValueError as err:
            typer.echo(f"Not applied: {err}")
            continue
        review.save(req, review_dir)
        typer.echo(review.render_text(req))


@app.command("evaluate")
def evaluate_cmd(
    vehicle_file: Annotated[
        FsPath, typer.Argument(exists=True, readable=True, help="Vehicle JSON.")
    ],
    labels: Annotated[
        FsPath | None,
        typer.Option("--labels", exists=True, help="Detector labels JSON: photo ref -> findings."),
    ] = None,
    as_json: Annotated[
        bool, typer.Option("--json", help="Print the recommendation as JSON.")
    ] = False,
    review_mode: Annotated[
        review.ReviewMode,
        typer.Option("--review-mode", help="Ask a checker for every vehicle, or only risky ones."),
    ] = review.ReviewMode.ALL,
    confirmed: Annotated[
        FsPath | None,
        typer.Option("--confirmed", exists=True, help="Resume from a confirmed review JSON."),
    ] = None,
    skip_confirm: Annotated[
        bool,
        typer.Option("--skip-confirm", help="Decide on unconfirmed findings (batch/testing)."),
    ] = False,
    interactive: Annotated[
        bool | None,
        typer.Option("--interactive/--no-interactive",
                     help="Prompt the checker here. Default: when a terminal is attached."),
    ] = None,  # fmt: skip
    review_dir: Annotated[
        FsPath, typer.Option("--review-dir", help="Where review JSON and HTML sheets go.")
    ] = FsPath("reviews"),
    detector_name: Annotated[
        DetectorName,
        typer.Option("--detector",
                     help="mock reads labels; openai (or claude) looks at the photos."),
    ] = DetectorName.MOCK,
    photo_root: Annotated[
        FsPath, typer.Option("--photo-root", help="Folder the vehicle's photo_refs are in.")
    ] = FsPath("."),
    calibration: Annotated[
        FsPath | None,
        typer.Option("--calibration", exists=True, help="Confidence calibration from calibrate."),
    ] = None,
    yes: Annotated[
        bool, typer.Option("--yes", help="Confirm a paid run (the claude detector).")
    ] = False,
    no_cache: NoCache = False,
) -> None:
    """Evaluate disposition paths for one vehicle, after a human checker confirms the damage."""
    try:
        vehicle = _load_vehicle(vehicle_file)
    except ValueError as err:
        typer.echo(str(err), err=True)
        raise typer.Exit(2) from err
    detector = _make_detector(detector_name, labels, photo_root, calibration, not no_cache)
    _cost_gate(detector, vehicle.photo_refs, yes)
    status = "Findings NOT confirmed by a human checker."
    if confirmed:
        req = review.load(confirmed)
        if req.vin != vehicle.vin:
            raise typer.BadParameter(f"review is for VIN {req.vin}, not {vehicle.vin}")
        if review.is_stale(req, vehicle, _detect(detector, vehicle)):
            typer.echo(
                f"The vehicle data or its detected damage changed since {confirmed} was "
                f"reviewed. Send it back to a checker:\n  underscope evaluate {vehicle_file}",
                err=True,
            )
            raise typer.Exit(AWAITING_CONFIRMATION)
        if req.status != "confirmed":
            typer.echo(f"{confirmed} is still pending; confirm it first:", err=True)
            typer.echo(f"  underscope confirm {confirmed} --checker NAME", err=True)
            raise typer.Exit(AWAITING_CONFIRMATION)
        vehicle, findings = req.vehicle, req.findings
        status = f"Findings confirmed by {req.checker} at {req.confirmed_at}."
    else:
        findings = _detect(detector, vehicle)
        req = review.build_request(
            vehicle, findings, review_mode, views=_views(detector, vehicle),
            photo_root=photo_root, sightings=_sightings(detector, vehicle),
        )  # fmt: skip
        req.reasons += _unmapped_reasons(detector)
        if not skip_confirm and review.needs_confirmation(review_mode, req.reasons):
            json_path, html_path = review.save(req, review_dir)
            typer.echo(review.render_text(req), err=as_json)
            typer.echo(f"\nReview sheet (highlights every damaged area): {html_path}", err=as_json)
            if interactive is None:
                interactive = sys.stdin.isatty()
            if not interactive or not _interactive_review(req, review_dir):
                typer.echo(
                    f"\nAwaiting checker confirmation. Review request: {json_path}\n"
                    f"  1. underscope confirm {json_path} --checker NAME [edits]\n"
                    f"  2. underscope evaluate {vehicle_file} --confirmed {json_path}",
                    err=True,
                )
                raise typer.Exit(AWAITING_CONFIRMATION)
            vehicle, findings = req.vehicle, req.findings
            status = f"Findings confirmed by {req.checker} at {req.confirmed_at}."
            typer.echo("", err=as_json)
        elif not skip_confirm:
            status = "Not sent for review: no risk signals (review mode: risky)."
    rec = evaluate(vehicle, findings)
    if as_json:
        out = json.loads(rec.model_dump_json())
        out["findings_status"] = status
        typer.echo(json.dumps(out, indent=2))
    else:
        typer.echo(render(vehicle, rec) + f"\n{status}")


@app.command("confirm")
def confirm_cmd(
    review_file: Annotated[
        FsPath, typer.Argument(exists=True, readable=True, help="Review request JSON.")
    ],
    checker: Annotated[str, typer.Option("--checker", help="Name of the human checker.")],
    add: Annotated[
        list[str] | None,
        typer.Option("--add", help="Add a finding: panel:type:severity[:side] (repeatable)."),
    ] = None,
    remove: Annotated[
        list[int] | None,
        typer.Option("--remove", help="Remove finding #N as listed (repeatable)."),
    ] = None,
    severity: Annotated[
        list[str] | None,
        typer.Option("--severity", help="Re-grade finding #N: N:severity (repeatable)."),
    ] = None,
    undercarriage: Annotated[
        str | None, typer.Option("--undercarriage", help="yes|no: undercarriage damage.")
    ] = None,
    engine_audio: Annotated[
        str | None, typer.Option("--engine-audio", help="yes|no: abnormal engine audio.")
    ] = None,
) -> None:
    """Checker confirms (and optionally corrects) a pending damage review."""
    req = review.load(review_file)
    try:
        # Numbers are as the checker saw them: re-grade, then remove highest first, then add.
        for spec in severity or []:
            number, _, value = spec.partition(":")
            try:
                review.set_severity(req, int(number), float(value))
            except ValueError as err:
                raise ValueError(f"--severity {spec}: expected N:severity ({err})") from err
        for n in sorted(remove or [], reverse=True):
            review.remove_finding(req, n)
        for spec in add or []:
            panel, damage_type, severity, *side = spec.split(":")
            if len(side) > 1:
                raise ValueError(f"--add {spec}: expected panel:type:severity[:side]")
            review.add_finding(req, panel, damage_type, float(severity),
                               side[0] if side else None)  # fmt: skip
        if undercarriage is not None:
            review.set_flag(req, "undercarriage", _yes_no(undercarriage))
        if engine_audio is not None:
            review.set_flag(req, "engine", _yes_no(engine_audio))
        review.confirm(req, checker)
    except ValueError as err:
        raise typer.BadParameter(str(err)) from err
    _, html_path = review.save(req, review_file.parent, review_file)
    typer.echo(review.render_text(req))
    typer.echo(f"\nSaved {review_file} and {html_path}.")


@app.command("queue")
def queue_cmd(
    review_dir: Annotated[
        FsPath, typer.Option("--review-dir", help="Where review JSON and HTML sheets are.")
    ] = FsPath("reviews"),
) -> None:
    """List damage reviews, pending first, and write an index page linking every sheet."""
    typer.echo(review.render_queue_text(review.list_reviews(review_dir)))
    if review_dir.is_dir():
        typer.echo(f"\nIndex: {review.write_queue_index(review_dir)}")


@app.command("batch")
def batch_cmd(
    vehicle_dir: Annotated[
        FsPath, typer.Argument(exists=True, file_okay=False, help="Folder of vehicle JSON files.")
    ],
    review_mode: Annotated[
        review.ReviewMode,
        typer.Option("--review-mode", help="Ask a checker for every vehicle, or only risky ones."),
    ] = review.ReviewMode.ALL,
    review_dir: Annotated[
        FsPath, typer.Option("--review-dir", help="Where review JSON and HTML sheets go.")
    ] = FsPath("reviews"),
    out: Annotated[
        FsPath | None, typer.Option("--out", help="Write decided recommendations as JSONL.")
    ] = None,
    detector_name: Annotated[
        DetectorName,
        typer.Option("--detector",
                     help="mock reads labels; openai (or claude) looks at the photos."),
    ] = DetectorName.MOCK,
    photo_root: Annotated[
        FsPath, typer.Option("--photo-root", help="Folder the vehicles' photo_refs are in.")
    ] = FsPath("."),
    calibration: Annotated[
        FsPath | None,
        typer.Option("--calibration", exists=True, help="Confidence calibration from calibrate."),
    ] = None,
    yes: Annotated[
        bool, typer.Option("--yes", help="Confirm a paid run (the claude detector).")
    ] = False,
    no_cache: NoCache = False,
) -> None:
    """Evaluate a folder of vehicles. Confirmed reviews are decided; the rest go to the queue.

    Exits 3 while any vehicle is still waiting for a checker.
    """
    detector = _make_detector(detector_name, None, photo_root, calibration, not no_cache)
    refs = []
    for path in vehicle_dir.glob("*.json"):
        try:
            refs += _load_vehicle(path).photo_refs
        except ValueError:
            continue
    _cost_gate(detector, refs, yes)
    decided, waiting, invalid = [], [], []
    for path in sorted(vehicle_dir.glob("*.json")):
        try:
            vehicle = _load_vehicle(path)
        except ValueError as err:
            invalid.append(str(err))
            continue
        try:
            findings = detector.detect(vehicle)
        except Exception as err:  # noqa: BLE001 - one bad vehicle shouldn't stop the batch
            invalid.append(f"{path}: damage detection failed: {err}")
            continue
        existing = review_dir / f"{vehicle.vin}.json"
        req = review.load(existing) if existing.exists() else None
        if req and review.is_stale(req, vehicle, findings):
            req = None  # vehicle changed since review: start a fresh one
        if req and req.status == "confirmed":
            rec, status = evaluate(req.vehicle, req.findings), f"confirmed by {req.checker}"
        else:
            if req is None:
                req = review.build_request(
                    vehicle, findings, review_mode, views=_views(detector, vehicle),
                    photo_root=photo_root, sightings=_sightings(detector, vehicle),
                )  # fmt: skip
                req.reasons += _unmapped_reasons(detector)
            if review.needs_confirmation(review_mode, req.reasons):
                review.save(req, review_dir)
                waiting.append(vehicle.vin)
                continue
            rec, status = evaluate(vehicle, findings), "not sent for review (no risk signals)"
        decided.append((rec, status))
    for rec, status in decided:
        typer.echo(f"{rec.vin:<20}{LABEL[rec.winner]:<28}{status}")
    for vin in waiting:
        typer.echo(f"{vin:<20}{'(awaiting checker)':<28}")
    for msg in invalid:
        typer.echo(f"skipped: {msg}")
    if out:
        out.write_text("".join(
            json.dumps({**json.loads(rec.model_dump_json()), "findings_status": status}) + "\n"
            for rec, status in decided
        ))  # fmt: skip
    if review_dir.is_dir():
        typer.echo(f"\nQueue: {review.write_queue_index(review_dir)}")
    typer.echo(f"{len(decided)} decided, {len(waiting)} awaiting a checker.")
    if waiting:
        raise typer.Exit(AWAITING_CONFIRMATION)


@app.command("detect-eval")
def detect_eval_cmd(
    labels: Annotated[
        FsPath, typer.Argument(exists=True, help="True labels JSON: photo ref -> findings.")
    ],
    photo_root: Annotated[
        FsPath, typer.Option("--photo-root", help="Folder the labeled photos are in.")
    ] = FsPath("."),
    detector_name: Annotated[
        DetectorName, typer.Option("--detector", help="Detector to score.")
    ] = DetectorName.CLAUDE,
    predictions: Annotated[
        FsPath | None,
        typer.Option("--predictions", exists=True,
                     help="Score saved predictions instead of running a detector (free)."),
    ] = None,  # fmt: skip
    save: Annotated[
        FsPath | None, typer.Option("--save", help="Save the detector's predictions here.")
    ] = None,
    limit: Annotated[
        int | None, typer.Option("--limit", min=1, help="Only the first N labeled photos.")
    ] = None,
    yes: Annotated[
        bool, typer.Option("--yes", help="Confirm a paid run (the claude detector).")
    ] = False,
    report: Annotated[
        FsPath | None, typer.Option("--report", help="Also write the report as Markdown.")
    ] = None,
    match_by: Annotated[
        str,
        typer.Option("--match-by", help="panel (default), or type for labels without panels."),
    ] = "panel",
    batch: Annotated[
        bool,
        typer.Option("--batch", help="Submit as a Message Batch: half price, results within "
                                     "24 hours. Collect them later with --collect."),
    ] = False,  # fmt: skip
    collect: Annotated[
        FsPath | None,
        typer.Option("--collect", exists=True, help="Batch state file from --batch."),
    ] = None,
    batch_state: Annotated[
        FsPath, typer.Option("--batch-state", help="Where --batch saves its state.")
    ] = FsPath("detect_batch.json"),
    calibration: Annotated[
        FsPath | None,
        typer.Option("--calibration", exists=True,
                     help="Apply a calibration (fit on different photos) before scoring."),
    ] = None,  # fmt: skip
    no_cache: NoCache = False,
) -> None:
    """Score a damage detector against labeled photos."""
    from underscope import detector_eval as de

    truth = de.load_findings(labels)
    refs = sorted(truth)[:limit] if limit else sorted(truth)
    truth = {r: truth[r] for r in refs}
    errors: dict[str, str] = {}
    spent = None
    if predictions:
        pred = de.load_findings(predictions)
    elif collect:
        from underscope import vision

        state = json.loads(collect.read_text())
        detector = vision.ClaudeVisionDetector(
            photo_root, model=state.get("model", vision.MODEL),
            cache_dir=None if no_cache else vision.DEFAULT_CACHE_DIR,
        )  # fmt: skip
        status, pred, errors = detector.collect_batch(state)
        if status != "ended":
            typer.echo(f"Batch {state['batch_id']} is still {status}; try again later.")
            raise typer.Exit(AWAITING_CONFIRMATION)
        # Photos answered before the batch was submitted weren't in it; reuse those answers.
        reused = [r for r in state.get("cached", []) if r in truth]
        more, more_errors = de.run_detector(detector, reused)
        pred, errors = {**pred, **more}, {**errors, **more_errors}
        batch_refs = set(state["photos"].values()) | set(reused)
        truth = {r: truth[r] for r in truth if r in batch_refs}
        spent = detector.spent_usd(batch=True)
    elif detector_name == DetectorName.CLAUDE:
        detector = _make_detector(detector_name, None, photo_root, cache=not no_cache)
        hint = " (use --limit to try a few first)"
        if batch:
            todo = detector.uncached(refs)
            if todo and not yes:
                from underscope.vision import estimated_cost_usd

                typer.echo(f"This sends {len(todo)} photos to Claude as a batch (half price), "
                           f"roughly ${estimated_cost_usd(len(todo)) / 2:,.2f}. "
                           f"Re-run with --yes to go ahead{hint}.")  # fmt: skip
                raise typer.Exit(1)
            if not todo:
                typer.echo("Every photo is already answered; scoring the saved answers.")
                batch = False
        else:
            _cost_gate(detector, refs, yes, hint)
        if batch:
            try:
                state = detector.submit_batch(todo)
                state["cached"] = [r for r in refs if r not in todo]
            except Exception as err:
                from underscope.vision import DetectionError

                if not isinstance(err, DetectionError):
                    raise
                raise typer.BadParameter(str(err)) from err
            batch_state.write_text(json.dumps(state, indent=2))
            typer.echo(
                f"Submitted batch {state['batch_id']} with {len(todo)} photos "
                f"({len(refs) - len(todo)} already answered). State saved to "
                f"{batch_state}.\nCollect: underscope detect-eval {labels} --photo-root "
                f"{photo_root} --collect {batch_state} [--save predictions.json]"
            )
            return
        if not batch:
            pred, errors = de.run_detector(detector, refs)
            spent = detector.spent_usd()
            if detector.cache_hits:
                typer.echo(f"Reused {detector.cache_hits} saved answers (no cost).")
    else:
        pred, errors = de.run_detector(_MockPhotoDetector(labels), refs)
    if save and not predictions:
        de.save_findings(pred, save)
        if errors:
            typer.echo(f"Saved predictions for {len(pred)} photos; {len(errors)} failed "
                       "and aren't in the file.")  # fmt: skip
    if match_by not in ("panel", "type"):
        raise typer.BadParameter("--match-by must be panel or type")
    if calibration:
        from underscope import calibration as cal

        pred = cal.calibrated(pred, cal.load(calibration))
    text = de.render_report(de.score(truth, pred, errors, by=match_by))
    if spent is not None:
        text += f"\nAPI cost of this run: ${spent:,.2f} (from reported token usage).\n"
    typer.echo(text)
    if report:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(text)


@app.command("label")
def label_cmd(
    photo_dir: Annotated[
        FsPath, typer.Argument(exists=True, file_okay=False, help="Folder of photos to label.")
    ],
    labels: Annotated[
        FsPath, typer.Option("--labels", help="Labels file to create or extend.")
    ] = FsPath("labels.json"),
    prefill: Annotated[
        FsPath | None,
        typer.Option("--prefill", exists=True,
                     help="Start each photo from saved predictions (faster, but can anchor "
                          "the labeler on the model's answer)."),
    ] = None,  # fmt: skip
) -> None:
    """Record the true damage in each photo, for scoring detectors. Resumable."""
    from underscope import labeling
    from underscope.detector_eval import load_findings, save_findings

    done = load_findings(labels) if labels.exists() else {}
    start = load_findings(prefill) if prefill else {}
    todo = labeling.photos_to_label(photo_dir, done)
    typer.echo(f"{len(done)} labeled, {len(todo)} to go. Labels file: {labels}")
    typer.echo(labeling.HELP)
    for i, ref in enumerate(todo, 1):
        findings = [f.model_copy(update={"confidence": 1.0}) for f in start.get(ref, [])]
        typer.echo(f"\n[{i}/{len(todo)}] {(photo_dir / ref).resolve()}")
        typer.echo(labeling.describe(findings))
        while True:
            try:
                action, msg = labeling.apply(findings, typer.prompt("label"), ref)
            except ValueError as err:
                typer.echo(f"Not applied: {err}")
                continue
            if action == "edit":
                typer.echo(labeling.describe(findings))
            elif action == "help":
                typer.echo(msg or labeling.HELP)
            else:
                break
        if action == "next":
            done[ref] = findings
            save_findings(done, labels)
        elif action == "quit":
            break
    typer.echo(f"\n{len(done)} photos labeled in {labels}.")


@app.command("import-coco")
def import_coco_cmd(
    annotations: Annotated[FsPath, typer.Argument(exists=True, help="COCO annotations JSON.")],
    mapping: Annotated[
        FsPath, typer.Option("--mapping", exists=True, help="Category mapping YAML.")
    ],
    out: Annotated[FsPath, typer.Option("--out", help="Labels file to write.")] = FsPath(
        "labels.json"
    ),
) -> None:
    """Convert COCO damage annotations into labels for detect-eval."""
    from underscope.coco_import import convert_file
    from underscope.detector_eval import save_findings

    try:
        labels, counts = convert_file(annotations, mapping)
    except (ValueError, KeyError) as err:
        raise typer.BadParameter(f"mapping or annotations don't fit: {err}") from err
    save_findings(labels, out)
    typer.echo(
        f"{counts['images']} images, {counts['damage']} damage labels written to {out}\n"
        f"  placed on a labeled part: {counts['on_part']}\n"
        f"  on the default panel (score with --match-by type): {counts['default_panel']}\n"
        f"  dropped, no panel: {counts['no_panel']}; ignored by mapping: {counts['ignored']}\n"
        f"  categories not in the mapping: {counts['unknown_category']}"
    )


@app.command("contracts")
def contracts_cmd(
    check: Annotated[
        bool, typer.Option("--check", help="Only check the files match the code (exit 1 if not).")
    ] = False,
) -> None:
    """Write the JSON Schemas for every file passed between stages to docs/contracts/."""
    from underscope import contracts

    if check:
        drift = contracts.stale()
        if drift:
            typer.echo(f"Out of date: {', '.join(drift)}. Run: underscope contracts")
            raise typer.Exit(1)
        typer.echo("Contracts match the code.")
        return
    for path in contracts.write():
        typer.echo(f"Wrote {path}")


@app.command("demo")
def demo_cmd(
    out: Annotated[FsPath, typer.Option("--out", help="Folder to write the demo into.")] = FsPath(
        "demo"
    ),
) -> None:
    """Write a walkthrough with review sheets and decisions to open in a browser. Free."""
    from underscope import demo

    index = demo.build(out)
    typer.echo(f"Open {index} in a browser. Photos are drawings; cars and numbers are "
               "synthetic.\nThe checker's step: underscope confirm "
               f"{out / 'reviews' / 'FIXDENT0000000001.json'} --checker NAME")  # fmt: skip


@app.command("calibrate")
def calibrate_cmd(
    labels: Annotated[FsPath, typer.Argument(exists=True, help="True labels JSON.")],
    predictions: Annotated[
        FsPath, typer.Argument(exists=True, help="Saved predictions (detect-eval --save).")
    ],
    out: Annotated[FsPath, typer.Option("--out", help="Calibration file to write.")] = FsPath(
        "calibration.json"
    ),
    min_count: Annotated[
        int, typer.Option("--min-count", min=1, help="Fewest predictions to correct a band.")
    ] = 20,
    match_by: Annotated[str, typer.Option("--match-by", help="panel or type.")] = "panel",
    holdout: Annotated[
        float,
        typer.Option("--holdout", min=0.0, max=0.9,
                     help="Share of photos kept out of the fit and used to check it."),
    ] = 0.0,  # fmt: skip
    seed: Annotated[int, typer.Option("--seed", help="Seed for the holdout split.")] = 0,
) -> None:
    """Learn how often each stated confidence is actually right, for --calibration."""
    from underscope import calibration as cal
    from underscope.detector_eval import load_findings

    if match_by not in ("panel", "type"):
        raise typer.BadParameter("--match-by must be panel or type")
    truth, pred = load_findings(labels), load_findings(predictions)
    fit_refs, test_refs = cal.split(list(truth), holdout, seed)
    table = cal.fit({r: truth[r] for r in fit_refs}, pred, match_by, min_count)
    cal.save(table, out)
    typer.echo(cal.render(table))
    if test_refs:
        raw, after = cal.holdout_check({r: truth[r] for r in test_refs}, pred, table, match_by)
        verdict = "helps" if after < raw else "doesn't help; don't use it" if after > raw else (
            "changes nothing")  # fmt: skip
        typer.echo(
            f"\nFitted on {len(fit_refs)} photos, checked on {len(test_refs)} held-out photos.\n"
            f"Brier score on held-out photos (lower is better): {raw:.3f} raw, "
            f"{after:.3f} calibrated. Calibration {verdict}."
        )
        typer.echo(f"Saved {out}.")
    else:
        typer.echo(f"\nSaved {out}. Score it on different photos than these: "
                   "detect-eval ... --calibration " + str(out) + " (or use --holdout)")  # fmt: skip


PHOTO_TYPES = {".jpg", ".jpeg", ".png", ".webp"}
# Engine title statuses are clean/salvage/rebuilt; the registry also knows flood,
# non-repairable and lemon. Flood and non-repairable are branded salvage; lemon is a brand
# that survives repair, so it is treated like rebuilt.
TITLE_FROM_REGISTRY = {"clean": "clean", "salvage": "salvage", "rebuilt": "rebuilt",
                       "flood": "salvage", "non_repairable": "salvage", "lemon": "rebuilt"}


def _get_json(url: str) -> dict:
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "underscope-engine"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def vehicle_from_vin(vin: str, photos: FsPath | None, mileage: int, region: str,
                     api: str) -> tuple[dict, list[str]]:  # fmt: skip
    """A vehicle record for a real VIN: year/make/model/trim from NHTSA vPIC (free, public),
    title and market values from the Underscope registry when the VIN is registered, photo
    refs from the photo folder. Returns the record and notes on where each part came from."""
    vin = vin.strip().upper()
    notes: list[str] = []
    r = _get_json(f"https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json")
    d = (r.get("Results") or [{}])[0]
    if not d.get("Make"):
        raise ValueError(f"NHTSA could not decode VIN {vin}")
    rec: dict = {"vin": vin, "year": int(d.get("ModelYear") or 0), "make": d["Make"].title(),
                 "model": d.get("Model") or "", "trim": d.get("Trim") or d.get("Series") or "",
                 "mileage": mileage, "region": region}  # fmt: skip
    notes.append("Year, make, model and trim from NHTSA vPIC.")
    try:
        reg = _get_json(f"{api.rstrip('/')}/api/vehicle?vin={vin}")
    except Exception as err:  # registry is optional; the engine still runs without it
        reg = {}
        notes.append(f"Registry not reachable ({type(err).__name__}); title and values are "
                     "placeholders.")  # fmt: skip
    if reg.get("registered"):
        rec["title_status"] = TITLE_FROM_REGISTRY.get(reg["title_status"], "clean")
        source = reg["source"].replace("_", " ")
        notes.append(f"Title {reg['title_status']} verified from the {source} (registry).")
        if reg.get("clean_wholesale"):
            rec["clean_value_cents"] = int(reg["clean_wholesale"]) * 100
            notes.append(f"Clean value ${reg['clean_wholesale']:,} from the registry.")
        if reg.get("salvage_comps"):
            rec["salvage_comps_cents"] = [int(c) * 100 for c in reg["salvage_comps"]]
            notes.append(f"Salvage band from {len(reg['salvage_comps'])} comparable sales.")
    elif reg:
        notes.append("VIN not in the registry: title assumed clean, values are placeholders.")
    if photos:
        rec["photo_refs"] = sorted(p.name for p in photos.iterdir()
                                   if p.suffix.lower() in PHOTO_TYPES)  # fmt: skip
        notes.append(f"{len(rec['photo_refs'])} photos from {photos}.")
    return rec, notes


@app.command("check")
def check_cmd(
    vin: Annotated[str, typer.Argument(help="A real 17-character VIN.")],
    photos: Annotated[
        FsPath | None,
        typer.Option("--photos", exists=True, file_okay=False,
                     help="Folder of this car's photos; graded by OpenAI vision."),
    ] = None,  # fmt: skip
    mileage: Annotated[int, typer.Option("--mileage", min=0, help="Odometer, miles.")] = 0,
    region: Annotated[str, typer.Option("--region", help="State, for total-loss rules.")] = "NY",
    api: Annotated[
        str, typer.Option("--api", help="Underscope app for registry title and values.")
    ] = "https://underscope-eight.vercel.app",
    yes: Annotated[bool, typer.Option("--yes", help="Confirm the paid photo grading.")] = False,
    skip_confirm: Annotated[
        bool, typer.Option("--skip-confirm", help="Decide without a human checker.")
    ] = False,
    interactive: Annotated[
        bool | None, typer.Option("--interactive/--no-interactive", help="Prompt the checker.")
    ] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """Evaluate a real car from its VIN (NHTSA + registry) and photos (OpenAI vision)."""
    try:
        rec, notes = vehicle_from_vin(vin, photos, mileage, region, api)
    except Exception as err:
        typer.echo(f"Could not build the vehicle: {err}", err=True)
        raise typer.Exit(2) from err
    if photos is None:
        typer.echo("No --photos given: no damage to grade, so the decision assumes an "
                   "undamaged car.", err=True)  # fmt: skip
    path = FsPath("vehicles") / f"{rec['vin']}.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(rec, indent=2))
    typer.echo("\n".join(f"  {n}" for n in notes) + f"\n  Vehicle file: {path}\n", err=as_json)
    evaluate_cmd(
        vehicle_file=path, labels=None, as_json=as_json, review_mode=review.ReviewMode.ALL,
        confirmed=None, skip_confirm=skip_confirm, interactive=interactive,
        review_dir=FsPath("reviews"),
        detector_name=DetectorName.OPENAI if photos else DetectorName.MOCK,
        photo_root=photos or FsPath("."), calibration=None, yes=yes, no_cache=False,
    )  # fmt: skip


@app.command("learn")
def learn_cmd(
    review_dir: Annotated[
        FsPath, typer.Option("--review-dir", help="Folder of review JSON files.")
    ] = FsPath("reviews"),
    min_count: Annotated[
        int, typer.Option("--min-count", min=1, help="Fewest predictions to correct a band.")
    ] = 5,
) -> None:
    """Learn from the checker: compare what the detector reported with what each checker
    confirmed, and fit the confidence calibration the detector then uses automatically."""
    from underscope import calibration as cal
    from underscope.perception import merge_findings

    truth, pred = {}, {}
    for f in sorted(review_dir.glob("*.json")):
        try:
            req = review.load(f)
        except Exception:
            continue  # not a review file (e.g. a saved decision)
        if req.status != "confirmed" or not req.sightings:
            continue  # only checker-confirmed reviews of a real detector teach anything
        truth[req.vin] = list(req.findings)
        pred[req.vin] = merge_findings(list(req.sightings))
    if not truth:
        typer.echo(f"No confirmed reviews with detector output in {review_dir}. Run "
                   "`underscope check VIN --photos DIR`, confirm it, then learn.")  # fmt: skip
        raise typer.Exit(1)
    table = cal.fit(truth, pred, "panel", min_count)
    LEARNED_CALIBRATION.parent.mkdir(parents=True, exist_ok=True)
    cal.save(table, LEARNED_CALIBRATION)
    kept = sum(len(v) for v in truth.values())
    said = sum(len(v) for v in pred.values())
    typer.echo(cal.render(table))
    typer.echo(f"\nLearned from {len(truth)} confirmed vehicles: the detector reported {said} "
               f"damages, checkers confirmed {kept}. Saved {LEARNED_CALIBRATION}; the OpenAI "
               "detector now uses it automatically.")  # fmt: skip


class _MockPhotoDetector:
    """Per-photo view of the label file; scores 100% by construction (pipeline check)."""

    def __init__(self, labels: FsPath):
        from underscope.detector_eval import load_findings

        self.labels = load_findings(labels)

    def detect_photo(self, ref: str):
        return self.labels.get(ref, [])


if __name__ == "__main__":
    app()

"""Human-in-the-loop damage review: a checker confirms findings before the decision runs.

A detector can't flag damage it never saw, so by default every vehicle's findings go to a
human checker first. The request lists every area of the car (all panels, undercarriage,
engine) as damaged, to verify, or clear, and is written as JSON (the handoff) plus an HTML
sheet that highlights every damaged area. "risky" mode only asks when risk signals exist.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path as FsPath
from typing import Literal
from urllib.parse import quote

from pydantic import BaseModel, Field

from underscope import coverage
from underscope.config import Assumptions, default_assumptions
from underscope.decision import evaluate
from underscope.models import DamageFinding, DamageType, Panel, VehicleRecord


class ReviewMode(StrEnum):
    ALL = "all"
    RISKY = "risky"


class AreaStatus(StrEnum):
    DAMAGED = "damaged"
    VERIFY = "verify"  # high-risk area with nothing confirmed either way
    CLEAR = "clear"


# Areas where a miss is expensive and a detector sees poorly; always called out for checking.
HIGH_RISK_PANELS = (Panel.FRAME,)
EXTRA_AREAS = ("undercarriage", "engine")


class Area(BaseModel):
    name: str
    status: AreaStatus
    detail: str = ""


class ReviewRequest(BaseModel):
    vin: str
    status: Literal["pending", "confirmed"] = "pending"
    mode: ReviewMode = ReviewMode.ALL
    reasons: list[str] = Field(default_factory=list)
    vehicle: VehicleRecord
    findings: list[DamageFinding]
    checker: str | None = None
    confirmed_at: str | None = None
    # What the checker reviewed: vehicle data plus detector findings. If either changes, the
    # review no longer applies and the car goes back to the checker.
    source_fingerprint: str = ""
    # photo_ref -> view (front, left, rear_right, ...) when the detector reports it. An area no
    # photo shows is unknown, not clean, until the checker confirms it.
    photo_views: dict[str, str] = Field(default_factory=dict)
    # Folder the photo refs are in, so the sheet can show the photos next to the findings.
    photo_root: str | None = None
    # Each photo's own detections before merging, with boxes, to mark the spots on the photos.
    sightings: list[DamageFinding] = Field(default_factory=list)

    def _unseen(self, panel: Panel) -> list[str]:
        if not self.photo_views or self.status != "pending":
            return []
        return coverage.uncovered_sides(panel, list(self.photo_views.values()))

    def areas(self) -> list[Area]:
        out = []
        for panel in Panel:
            hits = [f for f in self.findings if f.panel == panel]
            unseen = self._unseen(panel)
            if hits:
                detail = "; ".join(_finding_text(f) for f in hits)
                sides = [s for s in unseen if s != "center"]
                if sides:
                    detail += f"; {' and '.join(sides)} side not photographed"
                out.append(Area(name=panel.value, status=AreaStatus.DAMAGED, detail=detail))
            elif unseen:
                what = ("not photographed" if unseen == ["center"]
                        else f"not photographed: {' and '.join(unseen)} side")  # fmt: skip
                out.append(Area(name=panel.value, status=AreaStatus.VERIFY, detail=what))
            elif panel in HIGH_RISK_PANELS and self.status == "pending":
                out.append(
                    Area(name=panel.value, status=AreaStatus.VERIFY,
                         detail="nothing detected; structural misses are costly, check it")
                )  # fmt: skip
            else:
                out.append(Area(name=panel.value, status=AreaStatus.CLEAR))
        for name, flag, what in (
            ("undercarriage", self.vehicle.undercarriage_damage, "undercarriage damage"),
            ("engine", self.vehicle.engine_audio_abnormal, "abnormal engine audio"),
        ):
            if flag:
                out.append(Area(name=name, status=AreaStatus.DAMAGED, detail=f"{what} flagged"))
            elif flag is None:
                out.append(Area(name=name, status=AreaStatus.VERIFY, detail="not inspected"))
            else:
                out.append(Area(name=name, status=AreaStatus.CLEAR))
        return out


def _finding_text(f: DamageFinding) -> str:
    src = "checker" if f.verified else f"conf {f.confidence:.2f}"
    photo = f", photo {f.photo_ref}" if f.photo_ref else ""
    side = f"{f.side} " if f.side else ""
    return f"{side}{f.damage_type.value} severity {f.severity:.2f} ({src}{photo})"


def risk_reasons(
    vehicle: VehicleRecord,
    findings: list[DamageFinding],
    a: Assumptions | None = None,
    views: dict[str, str] | None = None,
) -> list[str]:
    """Signals that the findings may be wrong or that a mistake would be costly.

    Reuses existing thresholds (simulation.low_confidence_threshold and the engine's own
    review flags) rather than adding new numbers.
    """
    a = a or default_assumptions()
    low = a["simulation"]["low_confidence_threshold"]
    out = []
    weak = [f for f in findings if not f.verified and f.confidence < low]
    if weak:
        out.append(f"{len(weak)} finding(s) below confidence {low:.2f}.")
    if vehicle.undercarriage_damage is None or vehicle.engine_audio_abnormal is None:
        out.append("Undercarriage or engine-audio inspection is missing.")
    if vehicle.undercarriage_damage:
        out.append("Undercarriage damage is flagged.")
    if any(f.panel in HIGH_RISK_PANELS for f in findings):
        out.append("Structural (frame) damage detected.")
    if not findings:
        out.append("No damage detected at all; confirm the car is really clean.")
    if views:
        gaps = coverage.missing_views(list(views.values()))
        if not coverage.covered(list(views.values())):
            out.append("Couldn't tell which side of the car any photo shows.")
        elif gaps:
            out.append(f"Photos don't show: {', '.join(gaps)}.")
    rec = evaluate(vehicle, findings, a)
    out += [f"Decision: {r}" for r in rec.review_reasons]
    return out


def fingerprint(vehicle: VehicleRecord, detected: list[DamageFinding]) -> str:
    payload = {
        "vehicle": vehicle.model_dump(mode="json", exclude={"findings"}),
        "detected": [f.model_dump(mode="json") for f in detected],
    }
    blob = json.dumps(payload, sort_keys=True).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def is_stale(req: ReviewRequest, vehicle: VehicleRecord, detected: list[DamageFinding]) -> bool:
    """True when the vehicle or its detector findings changed since the review was made."""
    return bool(req.source_fingerprint) and req.source_fingerprint != fingerprint(
        vehicle, detected
    )


def needs_confirmation(mode: ReviewMode, reasons: list[str]) -> bool:
    return mode == ReviewMode.ALL or bool(reasons)


def build_request(
    vehicle: VehicleRecord,
    findings: list[DamageFinding],
    mode: ReviewMode = ReviewMode.ALL,
    a: Assumptions | None = None,
    views: dict[str, str] | None = None,
    photo_root: str | FsPath | None = None,
    sightings: list[DamageFinding] | None = None,
) -> ReviewRequest:
    return ReviewRequest(
        vin=vehicle.vin,
        mode=mode,
        reasons=risk_reasons(vehicle, findings, a, views),
        photo_views=dict(views or {}),
        photo_root=str(FsPath(photo_root).resolve()) if photo_root is not None else None,
        sightings=list(sightings or []),
        vehicle=vehicle.model_copy(update={"findings": []}),
        findings=list(findings),
        source_fingerprint=fingerprint(vehicle, findings),
    )


# ------------------------------------------------------------------ checker edits


def add_finding(
    req: ReviewRequest, panel: str, damage_type: str, severity: float, side: str | None = None
) -> None:
    req.findings.append(
        DamageFinding(panel=Panel(panel), damage_type=DamageType(damage_type),
                      severity=severity, confidence=1.0, verified=True, side=side)
    )  # fmt: skip


def remove_finding(req: ReviewRequest, number: int) -> None:
    """number is 1-based, as shown to the checker."""
    if not 1 <= number <= len(req.findings):
        raise ValueError(f"no finding #{number}")
    del req.findings[number - 1]


def set_severity(req: ReviewRequest, number: int, severity: float) -> None:
    if not 1 <= number <= len(req.findings):
        raise ValueError(f"no finding #{number}")
    if not 0 <= severity <= 1:
        raise ValueError(f"severity must be from 0 to 1, not {severity}")
    f = req.findings[number - 1]
    req.findings[number - 1] = f.model_copy(update={"severity": severity, "verified": True})


def set_flag(req: ReviewRequest, area: str, value: bool) -> None:
    field = {"undercarriage": "undercarriage_damage", "engine": "engine_audio_abnormal"}[area]
    req.vehicle = req.vehicle.model_copy(update={field: value})


def confirm(req: ReviewRequest, checker: str) -> None:
    """Checker vouches for every finding: each becomes verified with confidence 1.0."""
    if not checker.strip():
        raise ValueError("checker name is required")
    req.findings = [f.model_copy(update={"verified": True, "confidence": 1.0})
                    for f in req.findings]  # fmt: skip
    req.status = "confirmed"
    req.checker = checker.strip()
    req.confirmed_at = datetime.now(UTC).isoformat(timespec="seconds")


# ------------------------------------------------------------------ files


def paths(req: ReviewRequest, directory: str | FsPath) -> tuple[FsPath, FsPath]:
    d = FsPath(directory)
    return d / f"{req.vin}.json", d / f"{req.vin}.html"


def save(
    req: ReviewRequest, directory: str | FsPath, json_path: FsPath | None = None
) -> tuple[FsPath, FsPath]:
    """Write the request JSON and its HTML sheet (same name, .html) and return both paths."""
    if json_path is None:
        json_path, html_path = paths(req, directory)
    else:
        html_path = json_path.with_suffix(".html")
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(req.model_dump_json(indent=2))
    html_path.write_text(render_html(req, html_dir=html_path.parent, json_ref=str(json_path)))
    return json_path, html_path


def load(path: str | FsPath) -> ReviewRequest:
    return ReviewRequest.model_validate_json(FsPath(path).read_text())


# ------------------------------------------------------------------ rendering

_MARK = {AreaStatus.DAMAGED: "!!", AreaStatus.VERIFY: "??", AreaStatus.CLEAR: "  "}


def render_text(req: ReviewRequest) -> str:
    v = req.vehicle
    lines = [
        f"DAMAGE REVIEW  VIN {req.vin}  {v.year} {v.make} {v.model}  [{req.status}]",
        "",
        "Every area of the car (!! damaged, ?? verify, blank = nothing detected):",
    ]
    for area in req.areas():
        detail = f"  {area.detail}" if area.detail else ""
        lines.append(f"  {_MARK[area.status]} {area.name:<14}{area.status.value:<8}{detail}")
    lines += ["", "Findings:"]
    lines += [f"  #{i} {f.panel.value}: {_finding_text(f)}" for i, f in enumerate(req.findings, 1)]
    if not req.findings:
        lines.append("  (none)")
    if req.reasons:
        lines += ["", "Why this needs a careful look:", *(f"  - {r}" for r in req.reasons)]
    if req.checker:
        lines += ["", f"Confirmed by {req.checker} at {req.confirmed_at}."]
    return "\n".join(lines)


# Top-down car, front at the top. Panels aren't sided in the model, so both sides share a
# status. (x, y, w, h) in a 240x460 viewBox.
_SHAPES: dict[str, list[tuple[int, int, int, int]]] = {
    "front_bumper": [(50, 20, 140, 26)],
    "hood": [(62, 50, 116, 86)],
    "fender": [(34, 50, 26, 86), (180, 50, 26, 86)],
    "windshield": [(66, 140, 108, 34)],
    "roof": [(66, 178, 108, 120)],
    "door": [(34, 140, 28, 160), (178, 140, 28, 160)],
    "quarter_panel": [(34, 304, 28, 100), (178, 304, 28, 100)],
    "rear_bumper": [(50, 412, 140, 26)],
}


def _severity_class(findings: list[DamageFinding]) -> str:
    worst = max(f.severity for f in findings)
    return "sev-high" if worst >= 0.66 else "sev-mid" if worst >= 0.33 else "sev-low"


def _photo_refs(req: ReviewRequest) -> list[str]:
    """The vehicle's photos, then any photo a finding cites that isn't in that list."""
    refs = list(req.vehicle.photo_refs)
    refs += [f.photo_ref for f in req.findings if f.photo_ref and f.photo_ref not in refs]
    return list(dict.fromkeys(refs))


def _photo_src(req: ReviewRequest, ref: str, html_dir: FsPath | None) -> str | None:
    """Link to the photo relative to the sheet, or None when the file isn't there."""
    if req.photo_root is None:
        return None
    photo = FsPath(req.photo_root) / ref
    if not photo.is_file():
        return None
    base = html_dir.resolve() if html_dir is not None else FsPath.cwd()
    return quote(FsPath(os.path.relpath(photo.resolve(), base)).as_posix())


def _key(f: DamageFinding) -> tuple:
    return (f.panel, f.side, f.damage_type)


def _marks(req: ReviewRequest, ref: str, numbers: dict[tuple, int]) -> str:
    """Boxes drawn over a photo where the detector saw damage, labeled with the finding #."""
    e = html.escape
    seen = req.sightings or req.findings
    out = []
    for f in seen:
        if f.photo_ref != ref or f.box is None:
            continue
        x0, y0, x1, y1 = f.box
        n = numbers.get(_key(f))
        label = f"#{n}" if n else "?"
        tip = f"{_area_label(f)} {f.damage_type.value}, severity {f.severity:.2f}"
        if n is None:
            tip += " (not in the current findings)"
        out.append(
            f'<span class="mark {_severity_class([f])}" title="{e(tip)}" style="left:{x0:.1%};'
            f'top:{y0:.1%};width:{x1 - x0:.1%};height:{y1 - y0:.1%}"><b>{label}</b></span>'
        )
    return "".join(out)


def _render_photos(req: ReviewRequest, html_dir: FsPath | None) -> str:
    e = html.escape
    numbered = list(enumerate(req.findings, 1))
    numbers = {}
    for n, f in numbered:
        numbers.setdefault(_key(f), n)
    cards = []
    for i, ref in enumerate(_photo_refs(req), 1):
        view = req.photo_views.get(ref)
        hits = [f"#{n} {_area_label(f)} {f.damage_type.value} {f.severity:.2f}"
                for n, f in numbered if f.photo_ref == ref]  # fmt: skip
        src = _photo_src(req, ref, html_dir)
        img = (f'<a class="shot" href="{e(src)}"><img src="{e(src)}" alt="Photo {e(ref)}" '
               f'loading="lazy">{_marks(req, ref, numbers)}</a>'
               if src else '<div class="nophoto">photo file not found</div>')  # fmt: skip
        view_text = f"view: {e(view.replace('_', ' '))}" if view else "view: not reported"
        found = "; ".join(e(h) for h in hits) or "no damage found in this photo"
        cards.append(
            f'<figure id="photo-{i}">{img}<figcaption><strong>{e(ref)}</strong>'
            f'<div class="muted">{view_text}</div><div>{found}</div></figcaption></figure>'
        )
    return f'<div class="photos">{"".join(cards)}</div>' if cards else "<p>None.</p>"


def _area_label(f: DamageFinding) -> str:
    return f"{f.side} {f.panel.value}" if f.side and f.side != "center" else f.panel.value


# The sheet's command builder; a file of its own so it reads as JavaScript.
_BUILDER_JS = (FsPath(__file__).parent / "review_confirm.js").read_text()


def _flag_text(value: bool | None) -> str:
    return "not inspected" if value is None else "yes" if value else "no"


def _builder(req: ReviewRequest, json_ref: str) -> str:
    """Form that writes the `underscope confirm` command for the checker's corrections. It
    only builds text; nothing is sent or saved from the page."""
    e = html.escape
    rows = "".join(
        f"<tr><td>#{n}</td><td>{e(_area_label(f))} {e(f.damage_type.value)}</td>"
        f'<td><input type="number" id="sev-{n}" min="0" max="1" step="0.05" '
        f'value="{f.severity:g}" aria-label="Severity of finding {n}"></td>'
        f'<td><input type="checkbox" id="rm-{n}" aria-label="Remove finding {n}"></td></tr>'
        for n, f in enumerate(req.findings, 1)
    ) or '<tr><td colspan="4">No findings to correct.</td></tr>'
    panels = "".join(f'<option value="{p.value}">{p.value}</option>' for p in Panel)
    types = "".join(f'<option value="{t.value}">{t.value}</option>' for t in DamageType)
    v = req.vehicle
    data = json.dumps({"json": json_ref, "findings": [
        {"n": n, "severity": f.severity} for n, f in enumerate(req.findings, 1)
    ]}).replace("</", "<\\/")  # fmt: skip
    flag = ('<option value="">as recorded: {now}</option><option value="yes">yes</option>'
            '<option value="no">no</option>')  # fmt: skip
    return f"""<h2>Confirm or correct</h2>
<p>Check each finding against the photos, mark corrections here, then run the command below.
This page only writes the command; nothing is saved until you run it.</p>
<form id="fix" class="fix">
<div class="table-wrap"><table>
<tr><th></th><th>Finding</th><th>Severity</th><th>Remove</th></tr>{rows}</table></div>
<fieldset><legend>Add damage the detector missed</legend><div class="row">
<label>Panel <select id="add-panel">{panels}</select></label>
<label>Side <select id="add-side"><option value="">unknown</option><option>left</option>
<option>right</option><option>center</option></select></label>
<label>Type <select id="add-type">{types}</select></label>
<label>Severity <input type="number" id="add-sev" min="0" max="1" step="0.05" value="0.3"></label>
<button type="button" id="add-btn">Add</button></div>
<div id="add-msg" class="muted" role="status"></div><ul id="added"></ul></fieldset>
<div class="row">
<label>Undercarriage damage <select id="uc">{flag.format(now=_flag_text(v.undercarriage_damage))}
</select></label>
<label>Abnormal engine audio <select id="eng">
{flag.format(now=_flag_text(v.engine_audio_abnormal))}</select></label>
<label>Checker name <input type="text" id="checker" autocomplete="name"></label></div>
<pre id="cmd" class="cmd"></pre>
<div class="row"><button type="button" id="copy">Copy command</button>
<span id="copied" class="muted" role="status"></span></div>
</form>
<script type="application/json" id="fix-data">{data}</script>
<script>{_BUILDER_JS}</script>"""


def render_html(
    req: ReviewRequest,
    standalone: bool = True,
    html_dir: FsPath | None = None,
    json_ref: str | None = None,
) -> str:
    """standalone=False leaves out the doctype/html/head/body wrapper, for hosts that add it.

    html_dir is where the sheet will be saved; photo links are relative to it. json_ref is
    how the confirm command names the review file (default <VIN>.json).
    """
    e = html.escape
    v = req.vehicle
    areas = {a.name: a for a in req.areas()}
    shapes = []
    frame = areas["frame"]
    frame_cls = (
        _severity_class([f for f in req.findings if f.panel == Panel.FRAME])
        if frame.status == AreaStatus.DAMAGED
        else frame.status.value
    )
    # Frame drawn as rails under the body so it reads as structure, not skin.
    shapes.append(
        f'<g class="area frame {frame_cls}"><title>frame: {e(frame.status.value)}'
        f' {e(frame.detail)}</title><rect x="20" y="12" width="200" height="434" rx="28"/></g>'
    )
    for name, rects in _SHAPES.items():
        panel = Panel(name)
        unseen = req._unseen(panel)
        # Sided panels are drawn left (first rect) and right; a finding without a side colors
        # both. Center panels have one rect.
        sides = ("left", "right") if len(rects) == 2 else ("center",)
        for side, (x, y, w, h) in zip(sides, rects, strict=True):
            hits = [f for f in req.findings if f.panel == panel
                    and (f.side is None or f.side == side or side == "center")]  # fmt: skip
            if hits:
                cls, state = _severity_class(hits), "damaged"
            elif side in unseen:
                cls, state = "verify", "not photographed"
            else:
                # This side is seen and undamaged, whatever the other side of the panel shows.
                cls, state = "clear", "clear"
            label = name if side == "center" else f"{side} {name}"
            detail = "; ".join(_finding_text(f) for f in hits)
            shapes.append(
                f'<g class="area {cls}"><title>{e(label)}: {e(state)} {e(detail)}</title>'
                f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6"/></g>'
            )
    svg = (
        '<svg viewBox="0 0 240 460" role="img" aria-label="Top-down car diagram, front at top">'
        + "".join(shapes)
        + "</svg>"
    )
    badge = {AreaStatus.DAMAGED: "Damaged", AreaStatus.VERIFY: "Verify", AreaStatus.CLEAR: "Clear"}
    rows = "".join(
        f'<tr class="row-{a.status.value}"><td>{e(a.name)}</td>'
        f'<td><span class="badge {a.status.value}">{badge[a.status]}</span></td>'
        f"<td>{e(a.detail)}</td></tr>"
        for a in req.areas()
    )
    photo_ids = {ref: i for i, ref in enumerate(_photo_refs(req), 1)}

    def _photo_cell(ref: str | None) -> str:
        return f'<a href="#photo-{photo_ids[ref]}">{e(ref)}</a>' if ref else ""

    findings = "".join(
        f"<tr><td>#{i}</td><td>{e(_area_label(f))}</td><td>{e(f.damage_type.value)}</td>"
        f"<td>{f.severity:.2f}</td><td>{'checker' if f.verified else f'{f.confidence:.2f}'}</td>"
        f"<td>{_photo_cell(f.photo_ref)}</td></tr>"
        for i, f in enumerate(req.findings, 1)
    ) or '<tr><td colspan="6">No findings.</td></tr>'
    reasons = "".join(f"<li>{e(r)}</li>" for r in req.reasons) or "<li>None.</li>"
    if req.status == "confirmed":
        status = f"Confirmed by {e(req.checker or '')} at {e(req.confirmed_at or '')}"
    else:
        status = "Awaiting checker confirmation"
    photos = _render_photos(req, html_dir)
    if req.status == "pending":
        confirm_html = _builder(req, json_ref or f"{req.vin}.json")
    else:
        confirm_html = ("<h2>Confirmed</h2><p>The decision uses these findings. To change them, "
                        "start a new review.</p>")  # fmt: skip
    head = f"""<title>Damage review {e(req.vin)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Layout: car diagram beside the area checklist; stacks to one column on phones. */
:root {{ --bg:#fbfbfd; --fg:#1b1c22; --muted:#62646f; --line:#d8dae3; --panel:#eef0f5;
  --low:#e9b931; --mid:#ee8a3a; --high:#d6383a; --on-high:#ffffff; --verify:#2f6fdf; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#15161b;
  --fg:#eceef3; --muted:#a2a5b2; --line:#363946; --panel:#232631; --low:#c9a43a;
  --mid:#d7813f; --high:#e25454; --on-high:#ffffff; --verify:#6b98f2; color-scheme:dark; }} }}
:root[data-theme="dark"] {{ --bg:#15161b; --fg:#eceef3; --muted:#a2a5b2; --line:#363946;
  --panel:#232631; --low:#c9a43a; --mid:#d7813f; --high:#e25454; --on-high:#ffffff;
  --verify:#6b98f2; color-scheme:dark; }}
body {{ margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }}
main {{ max-width:960px; margin:0 auto; padding-block:24px;
  padding-left:max(16px, env(safe-area-inset-left, 0px));
  padding-right:max(16px, env(safe-area-inset-right, 0px)); }}
h1 {{ font-size:20px; margin:0 0 4px; text-wrap:balance; }}
h2 {{ font-size:13px; margin:24px 0 8px; text-transform:uppercase; letter-spacing:.06em;
  color:var(--muted); }}
.muted {{ color:var(--muted); }}
.status {{ display:inline-block; margin-top:8px; padding:4px 10px; border-radius:999px;
  border:1px solid var(--line); }}
.grid {{ display:grid; grid-template-columns:minmax(200px,280px) 1fr; gap:24px;
  align-items:start; }}
.grid > div {{ min-width:0; }}
@media (max-width:640px) {{ .grid {{ grid-template-columns:1fr; }} }}
svg {{ width:100%; max-width:280px; height:auto; display:block; }}
.area rect {{ fill:var(--panel); stroke:var(--line); stroke-width:2; }}
.frame rect {{ fill:none; stroke-width:6; }}
.sev-low rect {{ fill:var(--low); }} .sev-mid rect {{ fill:var(--mid); }}
.sev-high rect {{ fill:var(--high); }}
.frame.sev-low rect {{ fill:none; stroke:var(--low); }}
.frame.sev-mid rect {{ fill:none; stroke:var(--mid); }}
.frame.sev-high rect {{ fill:none; stroke:var(--high); }}
.verify rect {{ stroke:var(--verify); stroke-dasharray:8 6; stroke-width:4; }}
table {{ width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }}
td, th {{ text-align:left; padding:6px 8px; border-bottom:1px solid var(--line);
  vertical-align:top; }}
th {{ font-weight:600; color:var(--muted); font-size:13px; }}
.badge {{ padding:2px 8px; border-radius:6px; font-size:13px; white-space:nowrap; }}
.badge.damaged {{ background:var(--high); color:var(--on-high); }}
.badge.verify {{ border:2px dashed var(--verify); }}
.badge.clear {{ color:var(--muted); }}
.legend {{ display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:8px; }}
.legend span {{ display:inline-block; width:12px; height:12px; border-radius:3px;
  margin-right:4px; vertical-align:-1px; }}
.table-wrap {{ overflow-x:auto; }}
.photos {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));
  gap:16px; }}
.photos figure {{ margin:0; border:1px solid var(--line); border-radius:8px; overflow:hidden;
  min-width:0; }}
.photos figure:target {{ outline:3px solid var(--verify); }}
.shot {{ position:relative; display:block; }}
.shot img {{ display:block; width:100%; height:auto; background:var(--panel); }}
.mark {{ position:absolute; border:3px solid var(--low); border-radius:4px;
  box-shadow:0 0 0 1px rgba(0,0,0,.45); }}
.mark.sev-mid {{ border-color:var(--mid); }} .mark.sev-high {{ border-color:var(--high); }}
.mark b {{ position:absolute; top:0; left:0; background:var(--high); color:var(--on-high);
  font-size:11px; line-height:1; padding:2px 4px; border-radius:3px; }}
.mark.sev-low b {{ background:var(--low); color:#1b1c22; }}
.mark.sev-mid b {{ background:var(--mid); color:#1b1c22; }}
.photos figcaption {{ padding:8px 10px; overflow-wrap:anywhere; }}
.nophoto {{ aspect-ratio:4/3; display:grid; place-items:center; background:var(--panel);
  color:var(--muted); font-size:13px; }}
.fix {{ display:grid; gap:12px; }}
.fix .row {{ display:flex; flex-wrap:wrap; gap:8px 16px; align-items:end; }}
.fix label {{ display:grid; gap:2px; font-size:13px; color:var(--muted); }}
.fix input, .fix select, .fix button {{ font:inherit; color:var(--fg); background:var(--bg);
  border:1px solid var(--line); border-radius:6px; padding:4px 8px; }}
.fix input[type=number] {{ width:5.5em; }}
.fix button {{ cursor:pointer; background:var(--panel); }}
.fix button:focus-visible, .fix input:focus-visible, .fix select:focus-visible {{
  outline:2px solid var(--verify); outline-offset:1px; }}
.fix fieldset {{ border:1px solid var(--line); border-radius:8px; margin:0; padding:8px 12px; }}
.fix ul {{ margin:6px 0 0; padding-left:18px; }}
.cmd {{ margin:0; padding:10px 12px; background:var(--panel); border-radius:6px;
  white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; }}
code {{ background:var(--panel); padding:1px 5px; border-radius:4px; overflow-wrap:anywhere; }}
</style>"""
    body = f"""<main>
<h1>Damage review: {e(f"{v.year} {v.make} {v.model} {v.trim}".strip())}</h1>
<div class="muted">VIN {e(req.vin)} · {e(v.region)} · {v.mileage:,} mi · {e(v.title_status.value)}
{" · insurance claim" if v.insurance_claim else ""}</div>
<div class="status">{status}</div>
<div class="grid">
<div><h2>Every area of the car</h2>{svg}
<div class="legend muted"><div><span style="background:var(--low)"></span>minor</div>
<div><span style="background:var(--mid)"></span>moderate</div>
<div><span style="background:var(--high)"></span>severe</div>
<div><span style="border:2px dashed var(--verify)"></span>verify</div></div>
<p class="muted">Front at top. Outer outline is the frame.</p></div>
<div><h2>Area checklist</h2><div class="table-wrap"><table>
<tr><th>Area</th><th>Status</th><th>Detail</th></tr>{rows}</table></div>
<h2>Findings</h2><div class="table-wrap"><table>
<tr><th></th><th>Panel</th><th>Type</th><th>Severity</th><th>Confidence</th><th>Photo</th></tr>
{findings}</table></div>
<h2>Why this needs a careful look</h2><ul>{reasons}</ul>
<h2>Photos</h2>{photos}
{confirm_html}
</div></div></main>
"""
    if not standalone:
        return head + "\n" + body
    return (
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        f"{head}</head><body>{body}</body></html>\n"
    )


# ------------------------------------------------------------------ queue


def list_reviews(directory: str | FsPath) -> list[tuple[FsPath, ReviewRequest]]:
    """Every review request in a directory, pending first, then by VIN."""
    d = FsPath(directory)
    found = [(p, load(p)) for p in sorted(d.glob("*.json"))] if d.is_dir() else []
    return sorted(found, key=lambda pr: (pr[1].status != "pending", pr[1].vin))


def render_queue_text(reviews: list[tuple[FsPath, ReviewRequest]]) -> str:
    if not reviews:
        return "No reviews."
    pending = sum(r.status == "pending" for _, r in reviews)
    lines = [f"{pending} pending, {len(reviews) - pending} confirmed", ""]
    lines.append(f"{'VIN':<20}{'Status':<11}{'Damaged':>8}{'Verify':>8}  Checker / reasons")
    for _path, r in reviews:
        areas = r.areas()
        damaged = sum(a.status == AreaStatus.DAMAGED for a in areas)
        verify = sum(a.status == AreaStatus.VERIFY for a in areas)
        who = r.checker or (r.reasons[0] if r.reasons else "")
        lines.append(f"{r.vin:<20}{r.status:<11}{damaged:>8}{verify:>8}  {who}")
    return "\n".join(lines)


def render_queue_html(reviews: list[tuple[FsPath, ReviewRequest]]) -> str:
    e = html.escape
    rows = []
    for path, r in reviews:
        v = r.vehicle
        areas = r.areas()
        damaged = ", ".join(a.name for a in areas if a.status == AreaStatus.DAMAGED) or "none"
        verify = ", ".join(a.name for a in areas if a.status == AreaStatus.VERIFY) or "none"
        who = e(f"{r.checker} at {r.confirmed_at}") if r.checker else "waiting for a checker"
        rows.append(
            f'<tr class="{r.status}"><td><a href="{e(path.with_suffix(".html").name)}">'
            f"{e(r.vin)}</a><div class=\"muted\">{e(f'{v.year} {v.make} {v.model}')}</div></td>"
            f'<td><span class="pill {r.status}">{r.status}</span></td>'
            f"<td>{e(damaged)}</td><td>{e(verify)}</td><td>{who}</td></tr>"
        )
    pending = sum(r.status == "pending" for _, r in reviews)
    body = "".join(rows) or '<tr><td colspan="5">No reviews yet.</td></tr>'
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Damage review queue</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
:root {{ --bg:#fbfbfd; --fg:#1b1c22; --muted:#62646f; --line:#d8dae3; --panel:#eef0f5;
  --pending:#b5520f; --done:#227a4a; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#15161b;
  --fg:#eceef3; --muted:#a2a5b2; --line:#363946; --panel:#232631; --pending:#f0a060;
  --done:#6cc995; color-scheme:dark; }} }}
:root[data-theme="dark"] {{ --bg:#15161b; --fg:#eceef3; --muted:#a2a5b2; --line:#363946;
  --panel:#232631; --pending:#f0a060; --done:#6cc995; color-scheme:dark; }}
body {{ margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }}
main {{ max-width:1100px; margin:0 auto; padding-block:24px;
  padding-left:max(16px, env(safe-area-inset-left, 0px));
  padding-right:max(16px, env(safe-area-inset-right, 0px)); }}
h1 {{ font-size:20px; margin:0 0 4px; }}
a {{ color:inherit; }}
.muted {{ color:var(--muted); font-size:13px; }}
.wrap {{ overflow-x:auto; margin-top:16px; }}
table {{ width:100%; border-collapse:collapse; }}
td, th {{ text-align:left; padding:8px; border-bottom:1px solid var(--line); vertical-align:top; }}
th {{ font-size:13px; color:var(--muted); font-weight:600; }}
.pill {{ padding:2px 8px; border-radius:999px; font-size:13px; border:1px solid currentColor; }}
.pill.pending {{ color:var(--pending); }} .pill.confirmed {{ color:var(--done); }}
</style></head><body><main>
<h1>Damage review queue</h1>
<div class="muted">{pending} pending, {len(reviews) - pending} confirmed. Open a VIN to see its
sheet; confirm with <code>underscope confirm &lt;VIN&gt;.json --checker NAME</code>.</div>
<div class="wrap"><table>
<tr><th>Vehicle</th><th>Status</th><th>Damaged areas</th><th>To verify</th><th>Checker</th></tr>
{body}</table></div></main></body></html>
"""


def write_queue_index(directory: str | FsPath) -> FsPath:
    d = FsPath(directory)
    d.mkdir(parents=True, exist_ok=True)
    out = d / "index.html"
    out.write_text(render_queue_html(list_reviews(d)))
    return out

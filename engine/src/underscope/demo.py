"""A pitchable walkthrough to open in a browser, no API key or dataset needed.

Builds, for the three fixture cars: drawn stand-in photos (SVG, labeled as drawings), review
sheets with detector-style sightings, boxes and photo views, the checker queue, and a
walkthrough page (index.html) with each car's recommendation. The damage is the fixtures'
own; positions and views are made up to show the sheet, not measured. Decisions shown assume
the checker confirms the findings as detected; the review sheets themselves stay pending.
"""

from __future__ import annotations

import html
import json
from pathlib import Path as FsPath

from underscope import review
from underscope.data import FIXTURE_DIR
from underscope.decision import LABEL, evaluate
from underscope.models import DamageFinding, Recommendation, VehicleRecord
from underscope.perception import merge_findings

Box = tuple[float, float, float, float]
# photo name, view, [(panel, side, damage type, severity, confidence, box)]
Photo = tuple[str, str, list[tuple[str, str | None, str, float, float, Box]]]

CARS: dict[str, list[Photo]] = {
    "dent_600.json": [
        ("dent_left.svg", "left", [("door", "left", "dent", 0.5, 0.92, (0.40, 0.42, 0.55, 0.60))]),
        ("dent_door_close.svg", "close_up",
         [("door", "left", "dent", 0.5, 0.95, (0.30, 0.30, 0.68, 0.70))]),
        ("dent_front.svg", "front", []),
        ("dent_rear.svg", "rear", []),
    ],  # no right-side or roof photo: the sheet asks the checker to verify those
    "borderline_writeoff.json": [
        ("border_front_left.svg", "front_left",
         [("door", "left", "dent", 0.6, 0.9, (0.44, 0.40, 0.62, 0.62)),
          ("frame", None, "crush", 0.4, 0.62, (0.10, 0.70, 0.36, 0.86))]),
        ("border_right.svg", "right", []),
        ("border_rear.svg", "rear", []),
    ],
    "total_loss.json": [
        ("total_front.svg", "front",
         [("hood", "center", "crush", 0.9, 0.9, (0.22, 0.30, 0.78, 0.52)),
          ("front_bumper", "center", "broken", 0.9, 0.95, (0.15, 0.62, 0.85, 0.80)),
          ("frame", None, "crush", 1.0, 0.85, (0.30, 0.80, 0.70, 0.92))]),
        ("total_front_left.svg", "front_left",
         [("hood", "center", "crush", 0.9, 0.88, (0.08, 0.30, 0.36, 0.50))]),
        ("total_left.svg", "left", []),
        ("total_right.svg", "right", []),
        ("total_rear.svg", "rear", []),
    ],
}

_W, _H = 800, 600


def _side_car() -> str:
    return (
        '<path d="M70 420 L90 330 Q110 300 170 296 L270 292 L340 210 Q360 192 400 192 '
        'L560 192 Q600 192 625 220 L680 290 Q740 300 750 340 L760 420 Z" fill="#8a96a3"/>'
        '<path d="M290 292 L350 222 Q362 210 390 210 L470 210 L470 292 Z" fill="#c7d6e3"/>'
        '<path d="M490 292 L490 210 L560 210 Q590 210 610 232 L655 292 Z" fill="#c7d6e3"/>'
        '<line x1="480" y1="200" x2="480" y2="420" stroke="#6d7884" stroke-width="3"/>'
        '<circle cx="200" cy="425" r="62" fill="#2b2f33"/><circle cx="200" cy="425" r="28" '
        'fill="#9aa3ab"/><circle cx="630" cy="425" r="62" fill="#2b2f33"/>'
        '<circle cx="630" cy="425" r="28" fill="#9aa3ab"/>'
    )


def _front_car() -> str:
    return (
        '<path d="M150 470 L160 300 Q170 250 230 240 L570 240 Q630 250 640 300 L650 470 Z" '
        'fill="#8a96a3"/>'
        '<path d="M240 240 L285 150 L515 150 L560 240 Z" fill="#c7d6e3"/>'
        '<rect x="185" y="300" width="110" height="45" rx="12" fill="#f2f0e6"/>'
        '<rect x="505" y="300" width="110" height="45" rx="12" fill="#f2f0e6"/>'
        '<rect x="320" y="380" width="160" height="50" rx="8" fill="#3c434a"/>'
        '<rect x="170" y="465" width="80" height="50" rx="10" fill="#2b2f33"/>'
        '<rect x="550" y="465" width="80" height="50" rx="10" fill="#2b2f33"/>'
    )


def _close_up() -> str:
    return ('<rect x="0" y="0" width="800" height="600" fill="#8a96a3"/>'
            '<path d="M0 380 Q400 340 800 380" stroke="#a7b2bd" stroke-width="18" '
            'fill="none"/>')  # fmt: skip


def _damage(box: Box, severity: float) -> str:
    x0, y0, x1, y1 = box[0] * _W, box[1] * _H, box[2] * _W, box[3] * _H
    cx, cy, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    dark = 0.35 + 0.5 * severity
    return (
        f'<ellipse cx="{cx:.0f}" cy="{cy:.0f}" rx="{rx * 0.85:.0f}" ry="{ry * 0.75:.0f}" '
        f'fill="#2a2420" opacity="{dark:.2f}"/>'
        f'<path d="M{x0 + rx * 0.3:.0f} {cy:.0f} Q{cx:.0f} {cy - ry * 0.6:.0f} '
        f'{x1 - rx * 0.3:.0f} {cy + ry * 0.2:.0f}" stroke="#f4f1ea" stroke-width="3" '
        f'fill="none" opacity="0.7"/>'
    )


def photo_svg(view: str, damage: list[tuple[Box, float]]) -> str:
    """A drawn stand-in photo of the car from this view, with the damage drawn in."""
    if view == "close_up":
        car = _close_up()
    elif view in ("front", "rear"):
        car = _front_car()
    else:
        car = _side_car()
    flip = ' transform="translate(800 0) scale(-1 1)"' if view in ("right", "rear_right") else ""
    spots = "".join(_damage(box, sev) for box, sev in damage)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_W} {_H}" width="{_W}" '
        f'height="{_H}"><rect width="{_W}" height="{_H}" fill="#dfe3e6"/>'
        f'<rect y="470" width="{_W}" height="130" fill="#b9bfc4"/>'
        f"<g{flip}>{car}</g>{spots}"
        f'<text x="16" y="34" font-family="sans-serif" font-size="22" fill="#3c434a">'
        f"DEMO DRAWING, {view.replace('_', ' ')} view</text></svg>"
    )


def build(out: str | FsPath = "demo") -> FsPath:
    """Write photos/, reviews/ and the walkthrough index.html under out; returns index.html."""
    out = FsPath(out)
    photos, reviews = out / "photos", out / "reviews"
    photos.mkdir(parents=True, exist_ok=True)
    cases = []
    for fixture, shots in CARS.items():
        car = json.loads((FIXTURE_DIR / fixture).read_text())
        sightings, views = [], {}
        for name, view, damage in shots:
            views[name] = view
            for panel, side, kind, sev, conf, box in damage:
                sightings.append(DamageFinding(
                    panel=panel, side=side, damage_type=kind, severity=sev, confidence=conf,
                    photo_ref=name, box=box,
                ))  # fmt: skip
            # Damage is drawn where it's boxed, so the marks land on it.
            (photos / name).write_text(photo_svg(view, [(d[5], d[3]) for d in damage]))
        vehicle = VehicleRecord(**{**car, "findings": [], "photo_refs": list(views)})
        findings = merge_findings(sightings)
        req = review.build_request(vehicle, findings, views=views, photo_root=photos,
                                   sightings=sightings)  # fmt: skip
        review.save(req, reviews)
        lead = next((name for name, _, damage in shots if damage), shots[0][0])
        cases.append((vehicle, req, evaluate(vehicle, findings), lead))
    review.write_queue_index(reviews)
    index = out / "index.html"
    index.write_text(walkthrough(cases))
    return index


def _money(cents: int) -> str:
    return f"{'-' if cents < 0 else ''}${abs(cents) / 100:,.0f}"


def _bars(rec: Recommendation) -> str:
    """Expected net per path with its P10-P90 range, on one scale that includes zero."""
    lo = min(0, *(o.p10_cents for o in rec.options))
    hi = max(0, *(o.p90_cents for o in rec.options))
    span = (hi - lo) or 1

    def at(cents: int) -> float:
        return (cents - lo) / span * 100

    rows = []
    for o in rec.options:
        start, end = sorted((at(0), at(o.expected_cents)))
        cls = "win" if o.path == rec.winner else "neg" if o.expected_cents < 0 else ""
        rows.append(
            f'<div class="path {cls}"><div class="pname">{html.escape(LABEL[o.path])}</div>'
            f'<div class="track"><span class="zero" style="left:{at(0):.1f}%"></span>'
            f'<span class="range" style="left:{at(o.p10_cents):.1f}%;'
            f'width:{at(o.p90_cents) - at(o.p10_cents):.1f}%"></span>'
            f'<span class="bar" style="left:{start:.1f}%;width:{end - start:.1f}%"></span></div>'
            f'<div class="pval">{_money(o.expected_cents)}</div></div>'
        )
    return "".join(rows)


Case = tuple[VehicleRecord, review.ReviewRequest, Recommendation, str]


def walkthrough(cases: list[Case]) -> str:
    e = html.escape
    cards = []
    for v, req, rec, lead in cases:
        adjuster = v.insurance_claim
        persona = "Insurance adjuster" if adjuster else "Dealer"
        question = ("Total it and send it to Copart, or not?" if adjuster
                    else "Does the repair pay back on ACV?")  # fmt: skip
        verify = sum(a.status == review.AreaStatus.VERIFY for a in req.areas())
        flip = f"<p class=\"flip\"><b>What would flip it:</b> {e(rec.flip_conditions[0])}</p>" if (
            rec.flip_conditions) else ""  # fmt: skip
        cards.append(f"""<article class="car">
<a class="thumb" href="reviews/{e(v.vin)}.html"><img src="photos/{e(lead)}" alt="Drawn photo of the
{e(v.make)} {e(v.model)}"></a>
<div class="body">
<div class="eyebrow">{persona} · {e(v.region)} · {v.mileage:,} mi · clean value
{_money(v.clean_value_cents or 0)}</div>
<h2>{v.year} {e(v.make)} {e(v.model)}</h2>
<p class="q">{e(question)}</p>
<p class="verdict">{e(LABEL[rec.winner]).capitalize()}</p>
<p>{e(rec.answer)}</p>
<div class="bars" role="img" aria-label="Expected net per path">{_bars(rec)}</div>
<p class="muted small">Bar: expected net. Thin line: 80% of outcomes (P10 to P90).</p>
{flip}
<p><a href="reviews/{e(v.vin)}.html">Open the checker's review sheet</a>: {len(req.findings)}
findings, {verify} areas to verify.</p>
</div></article>""")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>UnderScope Demo</title>
<style>
/* Layout: one column of car cases, photo beside the decision; stacks on phones. */
:root {{ --bg:#f4f5f2; --card:#ffffff; --fg:#1d2124; --muted:#5d6468; --line:#d5d9d6;
  --accent:#2f5fd0; --win:#1f8a5b; --neg:#c93636; --range:#9aa3ab; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg:#15181a;
  --card:#1e2225; --fg:#e8ebe9; --muted:#a0a8ab; --line:#343a3d; --accent:#7ea2f2;
  --win:#5cc796; --neg:#e86565; --range:#6c757a; color-scheme:dark; }} }}
:root[data-theme="dark"] {{ --bg:#15181a; --card:#1e2225; --fg:#e8ebe9; --muted:#a0a8ab;
  --line:#343a3d; --accent:#7ea2f2; --win:#5cc796; --neg:#e86565; --range:#6c757a;
  color-scheme:dark; }}
body {{ margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }}
main {{ max-width:1040px; margin:0 auto; padding-block:32px 56px;
  padding-left:max(16px, env(safe-area-inset-left, 0px));
  padding-right:max(16px, env(safe-area-inset-right, 0px)); display:grid; gap:28px; }}
h1 {{ font-size:clamp(28px, 5vw, 40px); line-height:1.1; margin:0; text-wrap:balance; }}
h2 {{ font-size:22px; margin:0; }}
p {{ margin:0; max-width:70ch; }}
a {{ color:var(--accent); }}
.muted {{ color:var(--muted); }} .small {{ font-size:13px; }}
.eyebrow {{ font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }}
.steps {{ display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px; }}
.steps div {{ background:var(--card); border:1px solid var(--line); border-radius:8px;
  padding:12px 14px; }}
.steps b {{ display:block; }}
.car {{ display:grid; grid-template-columns:minmax(0, 320px) minmax(0, 1fr); gap:20px;
  background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; }}
.thumb img {{ width:100%; height:auto; border-radius:6px; display:block; }}
.body {{ display:grid; gap:10px; align-content:start; min-width:0; }}
.q {{ font-style:italic; }}
.verdict {{ font-size:22px; font-weight:650; color:var(--win); }}
.bars {{ display:grid; gap:6px; }}
.path {{ display:grid; grid-template-columns:minmax(0, 170px) minmax(0, 1fr) 80px; gap:10px;
  align-items:center; font-size:14px; }}
.pval {{ text-align:right; font-variant-numeric:tabular-nums; }}
.track {{ position:relative; height:16px; }}
.zero {{ position:absolute; top:-2px; bottom:-2px; width:1px; background:var(--muted); }}
.range {{ position:absolute; top:7px; height:2px; background:var(--range); }}
.bar {{ position:absolute; top:3px; height:10px; border-radius:2px; background:var(--muted);
  opacity:.7; }}
.path.win .bar {{ background:var(--win); opacity:1; }} .path.win {{ font-weight:600; }}
.path.neg .bar {{ background:var(--neg); }}
.flip {{ font-size:14px; }}
footer {{ font-size:13px; color:var(--muted); border-top:1px solid var(--line);
  padding-top:14px; }}
@media (max-width:720px) {{ .car, .steps {{ grid-template-columns:1fr; }}
  .path {{ grid-template-columns:minmax(0, 1fr) 80px; }} .track {{ grid-column:1 / -1; }} }}
</style></head><body><main>
<header style="display:grid; gap:10px">
<div class="eyebrow">UnderScope demo</div>
<h1>Which exit makes the most money on a damaged car?</h1>
<p>UnderScope reads the photos and inspection data, has a person confirm the damage, then
compares four exits: repair then sell on ACV, sell as-is on ACV, sell as salvage on Copart, or
part it out. It recommends the one with the highest expected net and says what would change
the answer.</p></header>
<section class="steps" aria-label="How it works">
<div><b>1. Read the photos</b><span class="muted">Damage by panel, side, type and severity,
with a box on each photo.</span></div>
<div><b>2. A person confirms</b><span class="muted">The checker sees every area, including
the ones no photo shows, and corrects what's wrong.</span></div>
<div><b>3. Decide</b><span class="muted">Thousands of simulated outcomes per exit, in cents,
with the range and the tipping point.</span></div>
</section>
{"".join(cards)}
<p><a href="reviews/index.html">Checker queue</a>: all three cars waiting for confirmation.</p>
<footer>Demo data. Photos are drawings; cars, damage and every market number are synthetic
placeholders (config/assumptions.yaml), not real ACV or Copart figures. Decisions assume the
checker confirms the findings as shown. Rebuild with <code>underscope demo</code>.</footer>
</main></body></html>
"""

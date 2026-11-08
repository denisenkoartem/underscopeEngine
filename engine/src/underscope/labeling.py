"""Ground-truth labeling: a person records the damage in each photo.

Labels are saved in the MockDetector / detect-eval format ({photo_ref: [finding, ...]}),
with confidence 1.0, after every photo, so a session can stop and resume at any point.
"""

from __future__ import annotations

from pathlib import Path as FsPath

from underscope.models import DamageFinding, DamageType, Panel

PHOTO_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".gif")

HELP = f"""Commands:
  + panel side type severity   add a finding, e.g. + door left dent 0.4
                               panel: {", ".join(p.value for p in Panel)}
                               side: left, right, center or - (unknown)
                               type: {", ".join(t.value for t in DamageType)}
  - N                          remove finding #N
  n                            save this photo's findings (none = clean) and go on
  s                            skip this photo for now (nothing saved)
  q                            quit; labels saved so far are kept"""


def photos_to_label(photo_dir: str | FsPath, labeled: dict) -> list[str]:
    """Photo paths relative to photo_dir, sorted, minus those already labeled."""
    root = FsPath(photo_dir)
    refs = sorted(
        str(p.relative_to(root)) for p in root.rglob("*")
        if p.is_file() and p.suffix.lower() in PHOTO_SUFFIXES
    )  # fmt: skip
    return [r for r in refs if r not in labeled]


def apply(findings: list[DamageFinding], line: str, photo_ref: str) -> tuple[str, str]:
    """Apply one labeling command in place. Returns (action, message); action is one of
    edit, next, skip, quit, help. Raises ValueError for a command that can't be applied."""
    parts = line.strip().split()
    if not parts:
        return "help", ""
    cmd = parts[0]
    if cmd == "+" and len(parts) == 5:
        _, panel, side, damage_type, severity = parts
        sev = float(severity)
        if not 0 <= sev <= 1:
            raise ValueError("severity must be between 0 and 1")
        findings.append(DamageFinding(
            panel=Panel(panel), damage_type=DamageType(damage_type), severity=sev,
            confidence=1.0, side=None if side == "-" else side, photo_ref=photo_ref,
        ))  # fmt: skip
        return "edit", f"added #{len(findings)}"
    if cmd == "-" and len(parts) == 2:
        n = int(parts[1])
        if not 1 <= n <= len(findings):
            raise ValueError(f"no finding #{n}")
        del findings[n - 1]
        return "edit", f"removed #{n}"
    if cmd in ("n", "s", "q") and len(parts) == 1:
        return {"n": "next", "s": "skip", "q": "quit"}[cmd], ""
    return "help", HELP


def describe(findings: list[DamageFinding]) -> str:
    if not findings:
        return "  (no damage)"
    return "\n".join(
        f"  #{i} {f.panel.value} {f.side or '-'} {f.damage_type.value} {f.severity:.2f}"
        for i, f in enumerate(findings, 1)
    )

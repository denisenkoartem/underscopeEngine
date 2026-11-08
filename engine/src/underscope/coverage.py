"""Which parts of the car a set of photos actually shows.

A panel no photo shows isn't "undamaged", it's unknown. Each photo's view (reported by the
detector) maps to the panel sides it shows; anything left over goes to the checker to verify.
The frame and underbody are never counted as covered by exterior photos.
"""

from __future__ import annotations

from underscope.models import Panel

VIEWS = ("front", "rear", "left", "right", "front_left", "front_right", "rear_left",
         "rear_right", "top", "close_up", "interior", "unknown")  # fmt: skip

SIDED = (Panel.FENDER, Panel.DOOR, Panel.QUARTER_PANEL)
CENTER = (Panel.FRONT_BUMPER, Panel.REAR_BUMPER, Panel.HOOD, Panel.WINDSHIELD, Panel.ROOF)

Area = tuple[Panel, str]  # (panel, side): side is left, right or center

_FRONT: set[Area] = {(Panel.FRONT_BUMPER, "center"), (Panel.HOOD, "center"),
                     (Panel.WINDSHIELD, "center")}  # fmt: skip
_REAR: set[Area] = {(Panel.REAR_BUMPER, "center")}


def _side(side: str) -> set[Area]:
    return {(p, side) for p in SIDED}


SHOWS: dict[str, set[Area]] = {
    "front": _FRONT,
    "rear": _REAR,
    "left": _side("left"),
    "right": _side("right"),
    "front_left": _FRONT | {(Panel.FENDER, "left"), (Panel.DOOR, "left")},
    "front_right": _FRONT | {(Panel.FENDER, "right"), (Panel.DOOR, "right")},
    "rear_left": _REAR | {(Panel.QUARTER_PANEL, "left"), (Panel.DOOR, "left")},
    "rear_right": _REAR | {(Panel.QUARTER_PANEL, "right"), (Panel.DOOR, "right")},
    "top": {(Panel.ROOF, "center"), (Panel.HOOD, "center"), (Panel.WINDSHIELD, "center")},
    "close_up": set(),
    "interior": set(),
    "unknown": set(),
}

REQUIRED: set[Area] = {(p, s) for p in SIDED for s in ("left", "right")} | {
    (p, "center") for p in CENTER
}

# Plain-language names for the views a checker should ask for, and which views provide them.
_WANTED = (
    ("front", {"front", "front_left", "front_right"}),
    ("rear", {"rear", "rear_left", "rear_right"}),
    ("left side", {"left", "front_left", "rear_left"}),
    ("right side", {"right", "front_right", "rear_right"}),
    ("roof", {"top"}),
)


def covered(views: list[str]) -> set[Area]:
    out: set[Area] = set()
    for v in views:
        out |= SHOWS.get(v, set())
    return out


def missing(views: list[str]) -> set[Area]:
    """Areas no photo shows."""
    return REQUIRED - covered(views)


def missing_views(views: list[str]) -> list[str]:
    """Plain-language views no photo provides, e.g. ['left side', 'roof']."""
    have = set(views)
    return [name for name, provides in _WANTED if not have & provides]


def uncovered_sides(panel: Panel, views: list[str]) -> list[str]:
    """Sides of this panel no photo shows (empty when fully covered, or for the frame)."""
    gaps = missing(views)
    return sorted(side for p, side in gaps if p == panel)

from underscope import coverage
from underscope.models import Panel


def test_four_corners_cover_everything_but_roof():
    views = ["front_left", "front_right", "rear_left", "rear_right"]
    assert coverage.missing(views) == {(Panel.ROOF, "center")}
    assert coverage.missing_views(views) == ["roof"]


def test_single_left_photo_leaves_gaps():
    assert coverage.missing_views(["left"]) == ["front", "rear", "right side", "roof"]
    assert coverage.uncovered_sides(Panel.DOOR, ["left"]) == ["right"]
    assert coverage.uncovered_sides(Panel.HOOD, ["left"]) == ["center"]
    assert coverage.uncovered_sides(Panel.FRAME, ["left"]) == []


def test_close_ups_and_unknown_cover_nothing():
    assert coverage.covered(["close_up", "interior", "unknown", "nonsense"]) == set()


def test_every_view_listed_has_a_mapping():
    assert set(coverage.SHOWS) == set(coverage.VIEWS)
    assert all(area in coverage.REQUIRED for areas in coverage.SHOWS.values() for area in areas)

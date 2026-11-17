import pytest
from pydantic import ValidationError

from underscope.models import DamageFinding


def test_severity_bounds():
    with pytest.raises(ValidationError):
        DamageFinding(panel="door", damage_type="dent", severity=1.5, confidence=0.5)


def test_box_must_be_inside_the_photo():
    base = dict(panel="door", damage_type="dent", severity=0.3, confidence=0.9)
    assert DamageFinding(**base, box=(0.1, 0.2, 0.5, 0.6)).box == (0.1, 0.2, 0.5, 0.6)
    for bad in [(0.5, 0.2, 0.1, 0.6), (0.1, 0.2, 1.2, 0.6), (0.1, 0.2, 0.1, 0.6)]:
        with pytest.raises(ValidationError):
            DamageFinding(**base, box=bad)

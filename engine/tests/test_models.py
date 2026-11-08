import pytest
from pydantic import ValidationError

from underscope.models import DamageFinding, VehicleRecord
from underscope.perception import DamageDetector, MockDetector

LABELS = {"a.jpg": [{"panel": "door", "damage_type": "dent", "severity": 0.2, "confidence": 0.9}]}


def vehicle(**kw):
    base = dict(vin="V1", year=2019, make="Honda", model="Civic", mileage=50000, region="NY")
    return VehicleRecord(**{**base, **kw})


def test_severity_bounds():
    with pytest.raises(ValidationError):
        DamageFinding(panel="door", damage_type="dent", severity=1.5, confidence=0.5)


def test_mock_detector_reads_labels_and_inline():
    inline = {"panel": "hood", "damage_type": "crush", "severity": 0.5, "confidence": 0.8}
    v = vehicle(photo_refs=["a.jpg", "missing.jpg"], findings=[inline])
    det: DamageDetector = MockDetector(LABELS)
    out = det.detect(v)
    assert [f.panel for f in out] == ["hood", "door"]


def test_merge_findings_keeps_worst_view_per_area():
    from underscope.models import DamageFinding
    from underscope.perception import merge_findings

    def f(side, sev, conf, ref, t="dent"):
        return DamageFinding(panel="door", damage_type=t, severity=sev, confidence=conf,
                             side=side, photo_ref=ref)  # fmt: skip

    merged = merge_findings([f("left", 0.3, 0.9, "a"), f("left", 0.5, 0.6, "b"),
                             f("right", 0.2, 0.5, "a"), f("left", 0.2, 0.5, "a", "scratch")])
    key = {(m.side, m.damage_type.value): m for m in merged}
    assert len(merged) == 3
    assert (key["left", "dent"].severity, key["left", "dent"].confidence) == (0.5, 0.9)
    assert key["left", "dent"].photo_ref == "b"


def test_box_must_be_inside_the_photo():
    import pytest
    from pydantic import ValidationError

    from underscope.models import DamageFinding

    base = dict(panel="door", damage_type="dent", severity=0.3, confidence=0.9)
    assert DamageFinding(**base, box=(0.1, 0.2, 0.5, 0.6)).box == (0.1, 0.2, 0.5, 0.6)
    for bad in [(0.5, 0.2, 0.1, 0.6), (0.1, 0.2, 1.2, 0.6), (0.1, 0.2, 0.1, 0.6)]:
        with pytest.raises(ValidationError):
            DamageFinding(**base, box=bad)

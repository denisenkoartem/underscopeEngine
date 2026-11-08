import pytest

from underscope import review
from underscope.models import DamageFinding, Panel, VehicleRecord


def veh(**kw):
    base = dict(vin="V1", year=2021, make="X", model="Y", mileage=1000, region="NY",
                clean_value_cents=2_000_000, undercarriage_damage=False,
                engine_audio_abnormal=False)  # fmt: skip
    return VehicleRecord(**{**base, **kw})


def f(panel="door", sev=0.4, conf=0.9):
    return DamageFinding(panel=panel, damage_type="dent", severity=sev, confidence=conf)


def test_lists_every_area_and_marks_frame_to_verify():
    req = review.build_request(veh(), [f()])
    areas = {a.name: a.status for a in req.areas()}
    assert set(areas) == {p.value for p in Panel} | {"undercarriage", "engine"}
    assert areas["door"] == review.AreaStatus.DAMAGED
    assert areas["frame"] == review.AreaStatus.VERIFY
    assert areas["hood"] == review.AreaStatus.CLEAR


def test_missing_inspection_flags_need_verifying_and_are_risky():
    req = review.build_request(veh(undercarriage_damage=None), [f()])
    areas = {a.name: a.status for a in req.areas()}
    assert areas["undercarriage"] == review.AreaStatus.VERIFY
    assert any("inspection" in r for r in req.reasons)
    assert review.needs_confirmation(review.ReviewMode.RISKY, req.reasons)


def test_quiet_vehicle_only_skipped_in_risky_mode():
    req = review.build_request(veh(), [f(conf=0.95)])
    assert req.reasons == []
    assert review.needs_confirmation(review.ReviewMode.ALL, req.reasons)
    assert not review.needs_confirmation(review.ReviewMode.RISKY, req.reasons)


def test_no_findings_is_a_risk_signal():
    assert any("No damage" in r for r in review.risk_reasons(veh(), []))


def test_confirm_verifies_everything_and_needs_a_name():
    req = review.build_request(veh(), [f(conf=0.5)])
    with pytest.raises(ValueError):
        review.confirm(req, "  ")
    review.add_finding(req, "frame", "crush", 0.7)
    review.set_severity(req, 1, 0.6)
    review.confirm(req, "admin")
    assert req.status == "confirmed" and req.confirmed_at
    assert all(x.verified and x.confidence == 1.0 for x in req.findings)
    assert [x.severity for x in req.findings] == [0.6, 0.7]
    # Once confirmed, an undamaged frame is clear rather than "verify".
    assert {a.name: a.status for a in req.areas()}["frame"] == review.AreaStatus.DAMAGED


def test_bad_edits_rejected():
    req = review.build_request(veh(), [f()])
    with pytest.raises(ValueError):
        review.remove_finding(req, 2)
    with pytest.raises(ValueError):
        review.add_finding(req, "wing", "dent", 0.3)


def test_save_load_roundtrip_and_html_escapes(tmp_path):
    req = review.build_request(veh(make="<script>x</script>"), [f()])
    json_path, html_path = review.save(req, tmp_path)
    assert review.load(json_path) == req
    page = html_path.read_text()
    assert "<script>x" not in page and "&lt;script&gt;" in page
    assert page.count('class="area') == 12  # frame, 5 center panels, 3 sided panels x 2


def test_fragment_mode_has_no_document_wrapper():
    req = review.build_request(veh(), [f()])
    frag = review.render_html(req, standalone=False)
    assert frag.startswith("<title>") and "<html" not in frag and "<body" not in frag
    full = review.render_html(req)
    assert full.startswith("<!doctype html>")
    assert frag[frag.index("<main>"):] in full


def test_fingerprint_tracks_vehicle_and_detected_findings():
    v, fi = veh(), [f()]
    req = review.build_request(v, fi)
    assert req.source_fingerprint == review.fingerprint(v, fi)
    assert review.fingerprint(v.model_copy(update={"mileage": 9}), fi) != req.source_fingerprint
    assert review.fingerprint(v, [f(sev=0.9)]) != req.source_fingerprint
    # Checker edits don't change what the detector saw.
    review.add_finding(req, "roof", "dent", 0.2)
    review.confirm(req, "admin")
    assert req.source_fingerprint == review.fingerprint(v, fi)


def test_unphotographed_areas_go_to_verify():
    req = review.build_request(veh(), [f("door")], views={"a.jpg": "left"})
    areas = {a.name: a for a in req.areas()}
    assert areas["hood"].status == review.AreaStatus.VERIFY
    assert "not photographed" in areas["hood"].detail
    assert areas["fender"].status == review.AreaStatus.VERIFY
    assert "right side" in areas["fender"].detail
    # Damaged on the photographed side, the other side still unseen.
    assert areas["door"].status == review.AreaStatus.DAMAGED
    assert "right side not photographed" in areas["door"].detail
    assert any("Photos don't show: front, rear, right side, roof" in r for r in req.reasons)
    review.confirm(req, "admin")
    assert {a.name: a.status for a in req.areas()}["hood"] == review.AreaStatus.CLEAR


def test_full_coverage_and_no_views_change_nothing():
    four = {"a": "front_left", "b": "front_right", "c": "rear_left", "d": "rear_right", "e": "top"}
    req = review.build_request(veh(), [f()], views=four)
    assert {a.name: a.status for a in req.areas()}["hood"] == review.AreaStatus.CLEAR
    assert not any("Photos don't show" in r for r in req.reasons)
    plain = review.build_request(veh(), [f()])
    assert {a.name: a.status for a in plain.areas()}["hood"] == review.AreaStatus.CLEAR
    assert not any("Photos don't show" in r for r in plain.reasons)


def test_unknown_views_are_a_risk_signal():
    reasons = review.risk_reasons(veh(), [f()], views={"a": "unknown", "b": "close_up"})
    assert any("Couldn't tell which side" in r for r in reasons)


def test_diagram_colors_only_the_damaged_side():
    left = DamageFinding(panel="door", damage_type="dent", severity=0.8, confidence=0.9,
                         side="left")
    page = review.render_html(review.build_request(veh(), [left]))
    assert '<title>left door: damaged' in page and '<title>right door: clear' in page
    assert page.count('class="area sev-high"') == 1
    # A finding without a side colors both doors.
    page = review.render_html(review.build_request(veh(), [f("door", sev=0.8)]))
    assert page.count('class="area sev-high"') == 2


def test_diagram_marks_unphotographed_side():
    page = review.render_html(review.build_request(veh(), [], views={"a": "left"}))
    assert '<title>right door: not photographed' in page
    assert '<title>left door: clear' in page


def test_checker_can_add_sided_finding():
    req = review.build_request(veh(), [])
    review.add_finding(req, "fender", "dent", 0.3, "right")
    assert req.findings[0].side == "right"
    with pytest.raises(ValueError):
        review.add_finding(req, "fender", "dent", 0.3, "top")


def test_sheet_shows_each_photo_with_its_findings(tmp_path):
    photos = tmp_path / "photos"
    photos.mkdir()
    (photos / "front left.jpg").write_bytes(b"jpg")
    hit = DamageFinding(panel="fender", damage_type="dent", severity=0.5, confidence=0.9,
                        side="left", photo_ref="front left.jpg")
    req = review.build_request(veh(photo_refs=["front left.jpg", "rear.jpg"]), [hit],
                               views={"front left.jpg": "front_left"}, photo_root=photos)
    _, html_path = review.save(req, tmp_path / "reviews")
    page = html_path.read_text()
    # Linked relative to the sheet, with the space escaped; the missing file says so.
    assert 'src="../photos/front%20left.jpg"' in page
    assert "photo file not found" in page
    assert "view: front left" in page and "#1 left fender dent 0.50" in page
    assert '<a href="#photo-1">front left.jpg</a>' in page
    assert "no damage found in this photo" in page  # rear.jpg
    assert review.load(html_path.with_suffix(".json")).photo_root == str(photos.resolve())


def test_sheet_without_photo_root_still_lists_photos():
    page = review.render_html(review.build_request(veh(photo_refs=["a.jpg"]), []))
    assert "a.jpg" in page and "photo file not found" in page


def test_sheet_marks_every_sighting_on_its_photo(tmp_path):
    photos = tmp_path / "photos"
    photos.mkdir()
    for name in ("a.jpg", "b.jpg"):
        (photos / name).write_bytes(b"jpg")

    def seen(ref, box, sev=0.8, panel="door"):
        return DamageFinding(panel=panel, damage_type="dent", severity=sev, confidence=0.9,
                             side="left", photo_ref=ref, box=box)  # fmt: skip

    # The same dent in two photos merges to one finding, but both photos get a mark.
    sightings = [seen("a.jpg", (0.1, 0.2, 0.5, 0.6)), seen("b.jpg", (0.5, 0.5, 0.9, 0.9), 0.4),
                 seen("b.jpg", (0.0, 0.0, 0.2, 0.2), 0.2, panel="hood")]  # fmt: skip
    req = review.build_request(veh(photo_refs=["a.jpg", "b.jpg"]), [sightings[0]],
                               photo_root=photos, sightings=sightings)  # fmt: skip
    _, html_path = review.save(req, tmp_path / "rev")
    page = html_path.read_text()
    assert page.count('class="mark ') == 3
    assert 'class="mark sev-high"' in page
    assert "left:10.0%;top:20.0%;width:40.0%;height:40.0%" in page
    assert page.count("<b>#1</b>") == 2
    # A sighting the findings don't include (checker removed it, say) is marked "?".
    assert "<b>?</b>" in page and "not in the current findings" in page


def test_without_sightings_findings_with_boxes_are_marked(tmp_path):
    (tmp_path / "a.jpg").write_bytes(b"jpg")
    hit = DamageFinding(panel="hood", damage_type="dent", severity=0.2, confidence=0.9,
                        photo_ref="a.jpg", box=(0.1, 0.1, 0.2, 0.2))  # fmt: skip
    req = review.build_request(veh(photo_refs=["a.jpg"]), [hit], photo_root=tmp_path)
    assert 'class="mark sev-low"' in review.render_html(req, html_dir=tmp_path)


def test_pending_sheet_has_command_builder_confirmed_does_not():
    req = review.build_request(veh(), [f()])
    page = review.render_html(req, json_ref="reviews/V1.json")
    assert 'id="fix"' in page and '"json": "reviews/V1.json"' in page
    assert "underscope confirm" not in page.split('id="fix-data"')[0].split("<h2>Confirm")[0]
    with pytest.raises(ValueError):
        review.set_severity(req, 1, 1.5)
    review.confirm(req, "Lee")
    page = review.render_html(req)
    assert 'id="fix"' not in page and "<h2>Confirmed</h2>" in page

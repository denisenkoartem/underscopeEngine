import json

from typer.testing import CliRunner

from underscope.cli import app


def test_demo_writes_sheets_with_photos_and_marks(tmp_path):
    r = CliRunner().invoke(app, ["demo", "--out", str(tmp_path)])
    assert r.exit_code == 0, r.output
    reviews = tmp_path / "reviews"
    assert (reviews / "index.html").exists() and (tmp_path / "index.html").exists()
    assert len(list(reviews.glob("*.html"))) == 4  # three sheets and the index
    assert len(list((tmp_path / "photos").glob("*.svg"))) == 12
    sheet = (reviews / "FIXDENT0000000001.html").read_text()
    assert 'src="../photos/dent_left.svg"' in sheet and "photo file not found" not in sheet
    assert sheet.count("<b>#1</b>") == 2  # the same dent marked in two photos
    saved = json.loads((reviews / "FIXDENT0000000001.json").read_text())
    assert any("right side" in reason for reason in saved["reasons"])  # no right-side photo
    total = (reviews / "FIXTOTAL000000001.html").read_text()
    assert 'class="mark sev-high"' in total


def test_walkthrough_shows_each_car_decision_and_links_its_sheet(tmp_path):
    from underscope import demo

    page = demo.build(tmp_path).read_text()
    assert page.count('<article class="car">') == 3
    for vin in ("FIXDENT0000000001", "FIXBORDER00000001", "FIXTOTAL000000001"):
        assert f'href="reviews/{vin}.html"' in page
    assert "Does the repair pay back on ACV?" in page  # dealer
    assert page.count("Total it and send it to Copart, or not?") == 2  # adjusters
    assert page.count('class="path win"') == 3
    assert "synthetic" in page

"""OpenAI detector, real-input vehicle building, registry comps and learning from checkers.
No network or API calls: clients and HTTP are faked."""

import json
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from underscope import cli, review, vision
from underscope.config import load_assumptions
from underscope.models import DamageFinding, DamageType, Panel, VehicleRecord
from underscope.valuation import value_vehicle

runner = CliRunner()

ANSWER = {
    "view": "front_left",
    "findings": [{"panel": "hood", "damage_type": "dent", "side": "center", "severity": 0.4,
                  "confidence": 0.8, "box": {"x0": 0.1, "y0": 0.2, "x1": 0.5, "y1": 0.6}}],
    "unmapped_damage": ["cracked left mirror"],
}


class FakeOpenAI:
    """Stand-in with the chat.completions.create shape; records requests."""

    def __init__(self, content=None, finish="stop", refusal=None):
        content = json.dumps(ANSWER) if content is None else content
        self.calls = []
        msg = SimpleNamespace(content=content, refusal=refusal)
        resp = SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason=finish)],
                               usage=SimpleNamespace(prompt_tokens=1000, completion_tokens=500))
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))
        self._resp = resp

    def _create(self, **params):
        self.calls.append(params)
        return self._resp


def _photo(tmp_path):
    import base64

    p = tmp_path / "front.png"
    p.write_bytes(base64.b64decode(  # valid 1x1 PNG
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="))
    return p


def test_openai_detector_parses_findings_and_sends_a_strict_schema(tmp_path):
    _photo(tmp_path)
    fake = FakeOpenAI()
    det = vision.OpenAIVisionDetector(tmp_path, client=fake, model="gpt-5.5")
    found = det.detect_photo("front.png")
    assert [(f.panel, f.damage_type) for f in found] == [(Panel.HOOD, DamageType.DENT)]
    assert det.views["front.png"] == "front_left"
    assert det.notes["front.png"] == ["cracked left mirror"]
    params = fake.calls[0]
    assert params["response_format"]["json_schema"]["strict"] is True
    assert "reasoning_effort" in params and "temperature" not in params
    content = params["messages"][1]["content"]
    assert content[0]["image_url"]["url"].startswith("data:image/")
    assert det.spent_usd() > 0


def test_openai_detector_uses_temperature_for_non_reasoning_models(tmp_path):
    _photo(tmp_path)
    fake = FakeOpenAI()
    vision.OpenAIVisionDetector(tmp_path, client=fake, model="gpt-4o").detect_photo("front.png")
    assert fake.calls[0]["temperature"] == 0 and "reasoning_effort" not in fake.calls[0]


@pytest.mark.parametrize("kwargs, msg", [
    ({"refusal": "no"}, "declined"),
    ({"finish": "length"}, "cut off"),
    ({"content": ""}, "no content"),
    ({"content": "not json"}, "unusable"),
])
def test_openai_detector_reports_unusable_answers(tmp_path, kwargs, msg):
    _photo(tmp_path)
    det = vision.OpenAIVisionDetector(tmp_path, client=FakeOpenAI(**kwargs))
    with pytest.raises(vision.DetectionError, match=msg):
        det.detect_photo("front.png")


def test_openai_detector_caches_answers(tmp_path):
    _photo(tmp_path)
    fake = FakeOpenAI()
    det = vision.OpenAIVisionDetector(tmp_path, client=fake, cache_dir=tmp_path / "cache")
    det.detect_photo("front.png")
    det.detect_photo("front.png")
    assert len(fake.calls) == 1 and det.cache_hits == 1


def test_salvage_comps_set_the_salvage_band():
    a = load_assumptions()
    base = dict(vin="X" * 17, year=2018, make="Bmw", model="330i", mileage=50000, region="NY",
                clean_value_cents=1_100_000)
    plain = value_vehicle(VehicleRecord(**base), [], a)
    comps = value_vehicle(VehicleRecord(**base, salvage_comps_cents=[262_500, 487_500,
                                                                     532_500, 772_500]), [], a)
    assert comps.salvage_value == (262_500, 532_500, 772_500)
    assert plain.salvage_value != comps.salvage_value


def test_vehicle_from_vin_uses_nhtsa_and_the_registry(tmp_path, monkeypatch):
    def fake_get(url):
        if "vpic.nhtsa" in url:
            return {"Results": [{"Make": "BMW", "Model": "330i", "ModelYear": "2018",
                                 "Trim": "", "Series": "3-Series"}]}
        return {"registered": True, "title_status": "flood", "source": "online_listing",
                "clean_wholesale": 11000, "salvage_comps": [2625, 4875]}

    monkeypatch.setattr(cli, "_get_json", fake_get)
    _photo(tmp_path)
    rec, notes = cli.vehicle_from_vin("wba8b9c51jee81681", tmp_path, 60000, "NY", "http://x")
    assert rec["vin"] == "WBA8B9C51JEE81681" and rec["year"] == 2018 and rec["make"] == "Bmw"
    assert rec["title_status"] == "salvage"  # flood is a salvage brand in the engine
    assert rec["clean_value_cents"] == 1_100_000
    assert rec["salvage_comps_cents"] == [262_500, 487_500]
    assert rec["photo_refs"] == ["front.png"]
    VehicleRecord(**rec)  # valid record
    assert any("registry" in n for n in notes)


def test_vehicle_from_vin_works_without_the_registry(monkeypatch):
    def fake_get(url):
        if "vpic.nhtsa" in url:
            return {"Results": [{"Make": "MAZDA", "Model": "CX-30", "ModelYear": "2021"}]}
        raise OSError("offline")

    monkeypatch.setattr(cli, "_get_json", fake_get)
    rec, notes = cli.vehicle_from_vin("3MVDMBBL2MM311522", None, 0, "NY", "http://x")
    assert "clean_value_cents" not in rec and any("not reachable" in n for n in notes)


def test_learn_fits_calibration_from_confirmed_reviews(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    v = VehicleRecord(vin="L" * 17, year=2020, make="X", model="Y", mileage=1, region="NY")
    seen = [DamageFinding(panel=Panel.HOOD, damage_type=DamageType.DENT, severity=0.4,
                          confidence=0.9, photo_ref="a.jpg"),
            DamageFinding(panel=Panel.ROOF, damage_type=DamageType.SCRATCH, severity=0.1,
                          confidence=0.9, photo_ref="a.jpg")]
    req = review.build_request(v, seen, review.ReviewMode.ALL, sightings=seen)
    req.findings = [seen[0]]  # checker removed the roof scratch: a false alarm
    review.confirm(req, "tim")
    review.save(req, tmp_path / "reviews")
    result = runner.invoke(cli.app, ["learn", "--min-count", "1"])
    assert result.exit_code == 0, result.output
    assert "detector reported 2 damages, checkers confirmed 1" in result.output
    assert (tmp_path / cli.LEARNED_CALIBRATION).is_file()


def test_learn_without_reviews_explains_what_to_do(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(cli.app, ["learn"])
    assert result.exit_code == 1 and "underscope check" in result.output

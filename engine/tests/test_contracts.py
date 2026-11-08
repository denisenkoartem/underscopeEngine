import json

from typer.testing import CliRunner

from underscope import contracts
from underscope.cli import app
from underscope.data import FIXTURE_DIR
from underscope.models import VehicleRecord


def test_published_contracts_match_the_code():
    assert contracts.stale() == [], "run: underscope contracts"


def test_fixtures_meet_the_vehicle_contract():
    required = set(json.loads((contracts.CONTRACTS_DIR / "vehicle.schema.json").read_text())
                   ["required"])  # fmt: skip
    for path in FIXTURE_DIR.glob("*.json"):
        data = json.loads(path.read_text())
        assert required <= set(data), path
        VehicleRecord(**data)


def test_evaluate_json_output_has_every_required_field():
    schema = json.loads((contracts.CONTRACTS_DIR / "recommendation.schema.json").read_text())
    r = CliRunner().invoke(app, ["evaluate", str(FIXTURE_DIR / "dent_600.json"), "--json",
                                 "--skip-confirm"])  # fmt: skip
    out = json.loads(r.output)
    assert set(schema["required"]) <= set(out)
    assert set(out) <= set(schema["properties"])


def test_check_flag_reports_drift(tmp_path, monkeypatch):
    monkeypatch.setattr(contracts, "CONTRACTS_DIR", tmp_path)
    assert set(contracts.stale(tmp_path)) == set(contracts.SCHEMAS)
    contracts.write(tmp_path)
    assert contracts.stale(tmp_path) == []

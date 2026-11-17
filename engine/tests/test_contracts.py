from underscope import contracts


def test_published_contracts_match_the_code():
    assert contracts.stale() == [], "run: underscope contracts"


def test_check_flag_reports_drift(tmp_path, monkeypatch):
    monkeypatch.setattr(contracts, "CONTRACTS_DIR", tmp_path)
    assert set(contracts.stale(tmp_path)) == set(contracts.SCHEMAS)
    contracts.write(tmp_path)
    assert contracts.stale(tmp_path) == []

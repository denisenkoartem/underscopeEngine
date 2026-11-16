import pytest


@pytest.fixture(autouse=True)
def _isolated_vision_cache(tmp_path, monkeypatch):
    """Keep the Claude answer cache out of the repo and separate per test."""
    import underscope.vision as vision

    monkeypatch.setattr(vision, "DEFAULT_CACHE_DIR", tmp_path / "vision-cache")


@pytest.fixture(autouse=True)
def _no_router_model(monkeypatch):
    """Tests decide by the dollar simulation unless they pass a router model themselves."""
    monkeypatch.setenv("UNDERSCOPE_ROUTER_MODEL", "off")

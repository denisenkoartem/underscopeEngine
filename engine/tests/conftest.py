import pytest


@pytest.fixture(autouse=True)
def _isolated_vision_cache(tmp_path, monkeypatch):
    """Keep the Claude answer cache out of the repo and separate per test."""
    import underscope.vision as vision

    monkeypatch.setattr(vision, "DEFAULT_CACHE_DIR", tmp_path / "vision-cache")

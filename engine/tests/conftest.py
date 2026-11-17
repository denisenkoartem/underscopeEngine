import pytest


@pytest.fixture(autouse=True)
def _no_router_model(monkeypatch):
    """Tests decide by the dollar simulation unless they pass a router model themselves."""
    monkeypatch.setenv("UNDERSCOPE_ROUTER_MODEL", "off")


@pytest.fixture(scope="session", autouse=True)
def _few_threads():
    """Keep the suite to a few cores so two sessions can run tests on one machine."""
    from threadpoolctl import threadpool_limits

    with threadpool_limits(limits=2):
        yield

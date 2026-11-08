PY ?= .venv/bin/python

test:
	$(PY) -m pytest -q

lint:
	$(PY) -m ruff check src tests

.PHONY: test lint

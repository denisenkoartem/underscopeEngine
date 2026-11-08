#!/bin/sh
# Container entry (see Dockerfile): the Python functions (api/*.py) on 127.0.0.1:$PY_API_PORT, then the
# Node server on $PORT, which serves public/ and api/*.ts and forwards api/*.py requests to Python.
set -e
python3 scripts/py-api.py &
exec tsx scripts/dev-server.ts

"""Serve the Python Vercel functions (api/*.py) locally, the way Vercel runs them.

Each api/<name>.py that defines a `handler` class (a BaseHTTPRequestHandler) answers /api/<name>.
scripts/dev-server.ts forwards requests for those functions here (PY_API_URL), so the page works the
same locally and in Docker as on Vercel.

    python3 scripts/py-api.py            # 127.0.0.1:3001 (PY_API_PORT to change)
"""

import importlib.util
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

API = Path(__file__).resolve().parents[1] / "api"


def load_handlers() -> dict[str, type[BaseHTTPRequestHandler]]:
    handlers = {}
    for path in sorted(API.glob("*.py")):
        if path.name.startswith("_"):
            continue
        spec = importlib.util.spec_from_file_location(f"api_{path.stem}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls = getattr(module, "handler", None)
        if isinstance(cls, type) and issubclass(cls, BaseHTTPRequestHandler):
            handlers[path.stem] = cls
    return handlers


HANDLERS = load_handlers()


class Dispatch(BaseHTTPRequestHandler):
    """Reads the request line, then hands the request to that function's own handler class."""

    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        name = urlsplit(self.path).path.removeprefix("/api/").strip("/")
        cls = HANDLERS.get(name)
        if cls is None:
            body = json.dumps({"error": f"No Python function /api/{name}"}).encode()
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return False
        self.__class__ = cls  # its do_GET / do_POST / do_OPTIONS answer from here on
        return True


if __name__ == "__main__":
    port = int(os.environ.get("PY_API_PORT", "3001"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Dispatch)
    names = ", ".join(f"/api/{n}" for n in HANDLERS) or "none"
    print(f"Python functions on http://127.0.0.1:{port}: {names}", file=sys.stderr, flush=True)
    server.serve_forever()

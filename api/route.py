"""POST /api/route: send the web app's inputs to the engine; get back where to send the car.

Body: { vin, vehicle, title_status, grades, flags, codes, values, mileage?, region? }
(the same data the page already sends to /api/decide, plus the decoded vehicle).
Returns the engine's destination (ACV, Copart or a parts buyer), all four exits ranked with
P10/P50/P90 net proceeds, the explanation and what would flip it. No AI here.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "engine" / "src"))

from underscope.bridge import route  # noqa: E402

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}
USAGE = {
    "endpoint": "POST /api/route",
    "body": "{ vin, vehicle, title_status, grades, flags, codes, values, mileage?, region? }",
    "returns": "destination (ACV | Copart | Parts buyer), options[4], explanation, notes",
}


class handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict | None) -> None:
        self.send_response(code)
        for k, v in CORS.items():
            self.send_header(k, v)
        if body is None:
            self.end_headers()
            return
        data = json.dumps(body).encode()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self._send(204, None)

    def do_GET(self) -> None:
        self._send(200, USAGE)

    def do_POST(self) -> None:
        try:
            n = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._send(400, {"error": "body must be JSON"})
        try:
            self._send(200, route(payload))
        except (ValueError, KeyError, TypeError) as err:
            self._send(400, {"error": str(err)})
        except Exception as err:  # keep the page informed instead of a bare 500
            self._send(500, {"error": f"engine failed: {type(err).__name__}: {err}"})

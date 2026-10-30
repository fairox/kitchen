#!/usr/bin/env python3
"""
Local server for the kitchen configurator.

Serves the static web app and bridges it to Archicad. Archicad's JSON API sends
no CORS headers, so the browser cannot call it directly; this server receives
the generated model from the page and runs archicad/build_kitchen.py.

  python3 serve.py            -> http://localhost:8000
  python3 serve.py --port 8080 --allow-origin http://192.168.1.20:8000

Endpoints
  GET  /api/status  Archicad / Tapir connection summary
  POST /api/build   {"model": {...}, "options": {"walls", "replace", "floorIndex"}}
  POST /api/test    {"model": {...}}  place one element of each type, verify, delete

Only one build runs at a time. Requests are accepted from localhost origins only,
unless more are passed with --allow-origin.
"""
import argparse
import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "archicad"))
import build_kitchen  # noqa: E402

BUILD_LOCK = threading.Lock()
ALLOWED = set()
MAX_BODY = 20 * 1024 * 1024


def origin_ok(origin):
    if not origin:
        return True  # same-origin GETs and non-browser clients send none
    if origin in ALLOWED:
        return True
    host = urlparse(origin).hostname
    return host in ("localhost", "127.0.0.1", "::1")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/status":
            if not origin_ok(self.headers.get("Origin")):
                return self._json(403, {"error": "origin not allowed"})
            try:
                info = build_kitchen.status()
            except Exception as e:  # report, don't crash the page
                info = {"archicad": False, "error": str(e)}
            info["bridge"] = True
            info["busy"] = BUILD_LOCK.locked()
            return self._json(200, info)
        # keep local state out of the static server
        if path.startswith("/archicad/last_build") or path.startswith("/.git"):
            return self._json(404, {"error": "not found"})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/build", "/api/test"):
            return self._json(404, {"error": "not found"})
        if not origin_ok(self.headers.get("Origin")):
            return self._json(403, {"error": "origin not allowed"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return self._json(400, {"error": "bad request size"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            model = body["model"]
            assert isinstance(model.get("boxes"), list)
        except Exception:
            return self._json(400, {"error": "expected {\"model\": {...}} from the configurator"})
        if not BUILD_LOCK.acquire(blocking=False):
            return self._json(409, {"error": "a build is already running"})
        lines = []
        try:
            if path == "/api/build":
                res = build_kitchen.build(model, body.get("options") or {}, log=lines.append)
            else:
                res = build_kitchen.test_placement(model, log=lines.append)
            res["log"] = lines
            return self._json(200, res)
        except Exception as e:
            return self._json(500, {"error": str(e), "log": lines})
        finally:
            BUILD_LOCK.release()


def main():
    ap = argparse.ArgumentParser(description="Kitchen configurator local server")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--allow-origin", action="append", default=[], help="extra allowed Origin (repeatable)")
    a = ap.parse_args()
    ALLOWED.update(a.allow_origin)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"Kitchen configurator: http://localhost:{a.port}  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

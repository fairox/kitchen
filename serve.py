#!/usr/bin/env python3
"""
Local server for the kitchen configurator.

Serves the static web app and bridges it to Archicad. Archicad's JSON API sends
no CORS headers, so the browser cannot call it directly; this server receives
the generated model from the page and runs archicad/build_kitchen.py.

  python3 serve.py                 -> http://localhost:8000 (next free port if taken)
  python3 serve.py --open          -> also opens the browser
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
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

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
    # Windows takes MIME types from the registry, where .js is sometimes text/plain
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map, **{
        ".js": "text/javascript", ".css": "text/css", ".html": "text/html",
        ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
    })

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
        url = urlparse(self.path)
        path = url.path
        if path == "/api/status":
            if not origin_ok(self.headers.get("Origin")):
                return self._json(403, {"error": "origin not allowed"})
            try:
                port = (parse_qs(url.query).get("port") or [""])[0]
                info = build_kitchen.status(int(port) if port.isdigit() else None)
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
                res = build_kitchen.test_placement(model, log=lines.append, options=body.get("options") or {})
            res["log"] = lines
            return self._json(200, res)
        except Exception as e:
            return self._json(500, {"error": str(e), "log": lines})
        finally:
            BUILD_LOCK.release()


def main():
    if sys.version_info < (3, 8):
        sys.exit("Python 3.8 or newer is required.")
    for stream in (sys.stdout, sys.stderr):  # Windows consoles may not encode the log's dashes/arrows
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Kitchen configurator local server")
    ap.add_argument("--port", type=int, default=8000, help="first port to try (default 8000)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--open", action="store_true", help="open the app in the default browser")
    ap.add_argument("--allow-origin", action="append", default=[], help="extra allowed Origin (repeatable)")
    a = ap.parse_args()
    ALLOWED.update(a.allow_origin)
    srv = None
    for port in range(a.port, a.port + 20):
        try:
            srv = ThreadingHTTPServer((a.host, port), Handler)
            break
        except OSError:
            continue
    if srv is None:
        sys.exit(f"No free port between {a.port} and {a.port + 19}.")
    url = f"http://localhost:{port}/"
    print("")
    print("  Kitchen Configurator is running")
    print(f"  Open {url} in your browser")
    print("  Open a project in Archicad (Tapir add-on installed) to use 'Send to Archicad'.")
    print("  Close this window or press Ctrl+C to stop.")
    print("")
    if a.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

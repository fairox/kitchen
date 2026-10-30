#!/usr/bin/env python3
"""
Activate the kitchen configurator from Archicad.

  1. Select the kitchen's Zone in Archicad (optional).
  2. Run this script: from Tapir's script palette, by double-clicking
     "Open web app" in the Build Kitchen window, or:  python3 archicad/launch_configurator.py

It starts the local configurator server (or reuses one that is already
running), reads the selected Zone through Tapir and opens the configurator in
your browser with that room as the fixed site: width, depth and height from the
zone, placed at the zone's position on its story. The room's own walls are not
rebuilt, since they already exist in the project. Doors, windows and thresholds
are added in the configurator's Openings panel.

Without Archicad or without a selected zone it simply opens the configurator.
Only the Python standard library is used.

Options:
  --no-zone     do not read the selection, just open the configurator
  --port N      first port for the configurator server (default 8000)
  --no-browser  print the link instead of opening it
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import build_kitchen  # noqa: E402  (Archicad / Tapir connection)

LOG = os.path.join(HERE, "server.log")


def say(msg):
    print(msg, flush=True)


# ----------------------------------------------------------------------------- configurator server

def running_server(first_port):
    """Port of a configurator bridge that is already running, if any."""
    for port in range(first_port, first_port + 20):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=1.5) as r:
                if json.loads(r.read().decode()).get("bridge"):
                    return port
        except (urllib.error.URLError, OSError, ValueError):
            continue
    return None


def start_server(first_port):
    """Start serve.py in the background, detached from this script (and from Archicad)."""
    kwargs = {"cwd": ROOT, "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    with open(LOG, "w", encoding="utf-8") as log:
        subprocess.Popen([sys.executable, os.path.join(ROOT, "serve.py"), "--port", str(first_port)],
                         stdout=log, stderr=subprocess.STDOUT, **kwargs)
    for _ in range(40):  # up to ~10 s
        time.sleep(0.25)
        port = running_server(first_port)
        if port:
            return port
    raise RuntimeError(f"The configurator server did not start; see {LOG}")


# ----------------------------------------------------------------------------- room from Archicad

def selected_zone_room(ac):
    """(site params, description) from the single selected Zone, or (None, reason)."""
    selected = {e["elementId"]["guid"] for e in ac.tapir("GetSelectedElements").get("elements", [])}
    zones = [e["elementId"]["guid"] for e in ac.tapir("GetElementsByType", {"elementType": "Zone"}).get("elements", [])
             if "elementId" in e]
    picked = [g for g in zones if g in selected]
    if not picked:
        return None, "no Zone is selected"
    if len(picked) > 1:
        return None, f"{len(picked)} Zones are selected - select only the kitchen"
    res = ac.tapir("Get3DBoundingBoxes", {"elements": [{"elementId": {"guid": picked[0]}}]})
    bb = (res.get("boundingBoxes3D") or [{}])[0].get("boundingBox3D")
    if not bb:
        return None, "Archicad returned no geometry for the selected Zone"
    w = round((bb["xMax"] - bb["xMin"]) * 1000)
    d = round((bb["yMax"] - bb["yMin"]) * 1000)
    h = round((bb["zMax"] - bb["zMin"]) * 1000)
    floor = 0
    try:  # the story whose level matches the zone's bottom
        stories = ac.tapir("GetStories").get("stories", [])
        floor = min(stories, key=lambda s: abs(s.get("level", 0) - bb["zMin"])).get("index", 0) if stories else 0
    except build_kitchen.ArchicadError:
        pass
    site = {
        "roomW": w, "roomD": d, "wallH": min(max(h, 2200), 5000),
        "originX": round(bb["xMin"] * 1000), "originY": round(bb["yMin"] * 1000), "acFloor": floor,
        "acWalls": False, "openEnds": False, "openings": [], "siteFixed": True, "siteSource": "Archicad zone",
    }
    return site, f"{w} x {d} mm, {h} mm high, at ({site['originX']}, {site['originY']}) on story {floor}"


def link(port, params):
    """Configurator URL; the hash carries parameters as base64 JSON, as the web app writes it."""
    url = f"http://localhost:{port}/"
    if params:
        url += "#" + urllib.parse.quote(base64.b64encode(json.dumps(params).encode()).decode())
    return url


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Open the kitchen configurator for the selected Archicad zone")
    ap.add_argument("--no-zone", action="store_true", help="do not read the Archicad selection")
    ap.add_argument("--port", type=int, default=8000, help="first port for the configurator server")
    ap.add_argument("--no-browser", action="store_true", help="print the link instead of opening it")
    a = ap.parse_args()

    port = running_server(a.port)
    if port:
        say(f"Configurator already running on port {port}")
    else:
        say("Starting the configurator server...")
        port = start_server(a.port)
        say(f"Configurator running on port {port} (log: {os.path.relpath(LOG, ROOT)})")

    params = None
    if not a.no_zone:
        ac_port = build_kitchen.Archicad.find_port()
        if ac_port is None:
            say("Archicad not found - opening the configurator without a room from the project.")
        else:
            try:
                ac = build_kitchen.Archicad(ac_port)
                version = ac.tapir("GetAddOnVersion").get("version")
                say(f"Archicad on port {ac_port}, Tapir {version}")
                params, info = selected_zone_room(ac)
                if params:
                    say(f"Room from the selected Zone: {info}")
                    say("  Its walls already exist, so 'Include room walls' starts unticked; add doors and windows in Openings.")
                    say("  The bounding box is used: draw the zone as an axis-aligned rectangle for an exact fit.")
                else:
                    say(f"Opening without a room from the project: {info}.")
            except (build_kitchen.ArchicadError, urllib.error.URLError, OSError) as e:
                say(f"Tapir did not answer ({e}) - opening the configurator without a room from the project.")

    url = link(port, params)
    if a.no_browser:
        say(url)
    else:
        say("Opening the configurator in your browser...")
        webbrowser.open(url)
    return 0


if __name__ == "__main__":
    sys.exit(main())

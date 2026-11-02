#!/usr/bin/env python3
"""
Open the kitchen configurator for the Zone selected in Archicad, without the Build Kitchen window.

  1. Select the kitchen's Zone in Archicad (optional).
  2. python3 archicad/launch_configurator.py [--port N]

It starts the local configurator server (or reuses a running one), reads the selected Zone through
Tapir and opens the browser with that room as the fixed site: width, depth and height from the zone,
placed at the zone's position and story, room walls off (they already exist).

With several Archicads open the project is never guessed: give --port N, or select the Zone in exactly
one of them (that selection identifies the project). Without Archicad or a selected Zone it simply
opens the configurator. The same functions back "Open web app" in the Build Kitchen window.
"""
import argparse
import sys
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_kitchen as B  # noqa: E402
import kitchen_gui as K  # noqa: E402  (zone -> site, local server; tkinter is only loaded by the window)


def pick_site(port, log):
    """(site or None). With several Archicads, only a Zone selected in exactly one of them is used."""
    found = [B.probe(port)] if port else B.discover()
    found = [f for f in found if f]
    if not found:
        log("Archicad not found - opening the configurator without a room from the project.")
        return None
    sites = []
    for f in found:
        try:
            site, info = K.zone_site(B.Archicad(f["port"]))
        except (B.ArchicadError, OSError) as e:
            site, info = None, f"Tapir did not answer ({e})"
        log(f"Archicad on port {f['port']}, Tapir {f.get('tapir')}: " + (f"selected Zone {info}" if site else info))
        if site:
            sites.append(site)
    if len(sites) == 1:
        return sites[0]
    if len(sites) > 1:
        log("A Zone is selected in several Archicads - give --port N to choose; opening without a room from the project.")
    return None


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Open the kitchen configurator for the selected Archicad zone")
    ap.add_argument("--port", type=int, help="Archicad port, when several Archicads are open")
    ap.add_argument("--no-zone", action="store_true", help="do not read the Archicad selection")
    ap.add_argument("--no-browser", action="store_true", help="print the link instead of opening it")
    a = ap.parse_args()
    site = None if a.no_zone else pick_site(a.port, print)
    if site:
        print("  Its walls already exist, so 'Include room walls' starts unticked; add doors and windows in Openings.")
    url = K.web_app_url(site)
    print(url if a.no_browser else "Opening the configurator in your browser...")
    if not a.no_browser:
        webbrowser.open(url)
    return 0


if __name__ == "__main__":
    sys.exit(main())

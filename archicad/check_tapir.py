#!/usr/bin/env python3
"""
Check that Archicad is running and the Tapir add-on is active and ready for the kitchen build.

  python3 archicad/check_tapir.py            every Archicad on ports 19723-19744
  python3 archicad/check_tapir.py --port 19724

Read-only: it uses the builder's own discovery and status (build_kitchen.py), so the commands it
checks are exactly the ones the build needs. Only the Python standard library is used.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_kitchen as B  # noqa: E402


def report(port):
    st = B.status(port)
    if not st["connected"]:
        print(f"[X] {st['error']}")
        return False
    pj = st.get("project") or {}
    print(f"[OK] Archicad {st['archicadVersion']} on port {st['port']} · "
          f"{'Untitled project' if pj.get('isUntitled') else pj.get('projectName') or '?'}")
    print(f"[OK] Tapir {st['tapir']} is active" if st["writable"] else f"[X] {st.get('message')}")
    required = [c for c in st["missing"] if c in B.REQUIRED]
    optional = [c for c in st["missing"] if c not in B.REQUIRED]
    if required:
        print(f"[X] Missing commands the build needs: {', '.join(required)} - update Tapir.")
    if optional:
        print(f"[!]  Missing optional commands: {', '.join(optional)} - those parts are skipped or simplified.")
    if not st["missing"]:
        print(f"[OK] All {len(B.REQUIRED) + len(B.OPTIONAL)} commands the kitchen build uses are available")
    names = ", ".join(f"{s['index']}: {s['name']} ({s['level']:.2f} m)" for s in st.get("stories", []))
    print(f"[OK] Project stories: {names or 'none reported'}")
    if pj.get("token"):
        print(f"[OK] Kitchen builds in this project: {len(B.project_runs(pj))} (project token {pj['token']})")
    return st["writable"] and not required


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Check Archicad + Tapir for the kitchen configurator")
    ap.add_argument("--port", type=int, help="check only this port")
    a = ap.parse_args()
    ports = [a.port] if a.port else [f["port"] for f in B.discover()]
    if not ports:
        print(f"[X] No Archicad with Tapir found on ports {B.PORTS.start}-{B.PORTS.stop - 1}.")
        print("    Start Archicad and open a project (no dialog open); install Tapir from")
        print("    https://github.com/ENZYME-APD/tapir-archicad-automation/releases and add it in Options > Add-On Manager.")
        return 1
    ok = all([report(p) for p in ports])
    print("\nReady - use the Build Kitchen window (or Send to Archicad)." if ok else "\nNot ready - see the messages above.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

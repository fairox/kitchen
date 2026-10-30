#!/usr/bin/env python3
"""
Check that Archicad is running and the Tapir add-on is active and ready.

  python3 archicad/check_tapir.py            scan ports 19723-19744
  python3 archicad/check_tapir.py --port 19724

It does not change your project: it asks Archicad whether it is alive, asks
Tapir for its version, checks every command the kitchen build uses and reads
the project's stories. Only the Python standard library is needed.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

PORTS = range(19723, 19745)  # Archicad's JSON API: first instance on 19723, the next on 19724, ...
NEEDED = ["GetAddOnVersion", "CreateWalls", "CreateDoors", "CreateWindows", "CreateBeams", "CreateMorphs",
          "CreateLayers", "GetAttributesByType", "SetDetailsOfElements", "DeleteElements",
          "GetStories", "Get3DBoundingBoxes"]


def post(port, command, parameters=None, timeout=3.0):
    """One call to Archicad's JSON API: POST {"command", "parameters"} to localhost:<port>."""
    body = {"command": command}
    if parameters is not None:
        body["parameters"] = parameters
    req = urllib.request.Request(f"http://127.0.0.1:{port}", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def tapir(port, name, parameters=None):
    """Tapir's commands run through Archicad's API.ExecuteAddOnCommand, namespace 'TapirCommand'."""
    params = {"addOnCommandId": {"commandNamespace": "TapirCommand", "commandName": name}}
    if parameters is not None:
        params["addOnCommandParameters"] = parameters
    res = post(port, "API.ExecuteAddOnCommand", params, timeout=10)
    if not res.get("succeeded"):
        raise RuntimeError(res.get("error", {}).get("message", res))
    return res["result"]["addOnCommandResponse"]


def available(port, name):
    res = post(port, "API.IsAddOnCommandAvailable",
               {"addOnCommandId": {"commandNamespace": "TapirCommand", "commandName": name}})
    return bool(res.get("succeeded") and res["result"].get("available"))


def find_archicad(ports):
    found = []
    for port in ports:
        try:
            res = post(port, "API.IsAlive", timeout=0.6)
            if res.get("succeeded") and res["result"].get("isAlive"):
                found.append(port)
        except (urllib.error.URLError, OSError, ValueError):
            pass
    return found


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="Check Archicad + Tapir for the kitchen configurator")
    ap.add_argument("--port", type=int, help="check only this port")
    a = ap.parse_args()

    ports = find_archicad([a.port] if a.port else PORTS)
    if not ports:
        print("[X] Archicad not found on ports 19723-19744.")
        print("    Start Archicad and open (or create) a project - the JSON API only answers with a project open.")
        return 1
    ok = True
    for port in ports:
        print(f"[OK] Archicad is running on port {port}")
        try:
            version = tapir(port, "GetAddOnVersion").get("version")
        except Exception:
            print("[X] Tapir is not active in this Archicad.")
            print("    Install it from https://github.com/ENZYME-APD/tapir-archicad-automation/releases,")
            print("    then add it in Archicad: Options > Add-On Manager, restart Archicad if asked.")
            ok = False
            continue
        print(f"[OK] Tapir {version} is active")
        missing = [c for c in NEEDED if not available(port, c)]
        if missing:
            print(f"[!]  Missing commands: {', '.join(missing)} - update Tapir to the latest release.")
            ok = ok and not ({"CreateMorphs", "CreateLayers", "SetDetailsOfElements", "DeleteElements"} & set(missing))
        else:
            print(f"[OK] All {len(NEEDED)} commands the kitchen build uses are available")
        try:
            stories = tapir(port, "GetStories").get("stories", [])
            names = ", ".join(f"{s.get('index')}: {s.get('name', '')} ({s.get('level', 0):.2f} m)" for s in stories)
            print(f"[OK] Project stories: {names or 'none reported'}")
        except Exception as e:
            print(f"[!]  Could not read stories: {e}")
    print("\nReady - use 'Send to Archicad' in the configurator." if ok else "\nNot ready - see the messages above.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Regression tests for the Archicad side, against tools/mock_archicad.py (never a real Archicad).

  python3 tools/check_archicad.py

The mocks run on ports 29723-29725 (KITCHEN_ARCHICAD_PORTS), journals go to a temporary folder.
Covers what went wrong or nearly went wrong on real projects:
- every element verified by read-back; rotated builds measure the morph axis convention first
  (the mock reads axes as rows, like Archicad 29 / Tapir 1.7.0, which mirrored the first real build)
- Replace: first falls back to Append; then deletes exactly the previous run; keeps edited elements
- Remove run; unique element IDs; a configurator-coloured surface on every morph
- several Archicads: never guess the project (connect, status, the launcher's zone pick)
- build files: strict validation, placement and story read back from the file
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT_A, PORT_B = 29723, 29724
os.environ["KITCHEN_ARCHICAD_PORTS"] = f"{PORT_A}-{PORT_A + 2}"
sys.path.insert(0, str(ROOT / "archicad"))
import build_kitchen as B  # noqa: E402
import launch_configurator as L  # noqa: E402

failures = []


def check(cond, msg):
    print(("  ok    " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


def mock(port, *args):
    p = subprocess.Popen([sys.executable, str(ROOT / "tools" / "mock_archicad.py"), str(port), *args])
    for _ in range(40):
        if B.probe(port, 0.3):
            return p
        time.sleep(0.1)
    p.terminate()
    sys.exit(f"mock Archicad did not start on port {port}")


def model_for(params):
    with tempfile.TemporaryDirectory() as d:
        src, out = Path(d) / "p.json", Path(d) / "m.json"
        src.write_text(json.dumps(params))
        subprocess.run(["node", str(ROOT / "tools" / "export.js"), str(src), str(out)], check=True, capture_output=True)
        return json.loads(out.read_text())


def main():
    quiet = lambda *a: None  # noqa: E731
    params = {"layout": "four-wall", "roomW": 5754, "roomD": 4704, "island": False, "styleRight": "tall",
              "frontColor": "#b08f6e", "wallFrontColor": "#ddd4c6", "tallFrontColor": "#a9876a", "counterColor": "#e4ddd2",
              "openings": [{"type": "door", "wall": "front", "from": "start", "offset": 2300, "width": 900},
                           {"type": "window", "wall": "back", "from": "start", "offset": 1800, "width": 1200, "sill": 1050},
                           {"type": "threshold", "wall": "left", "from": "start", "offset": 600, "width": 1200, "height": 2200}]}
    model = model_for(params)
    with tempfile.TemporaryDirectory() as journal:
        B.JOURNAL = Path(journal)
        a = mock(PORT_A, "Oak Street")
        try:
            ac = B.Archicad(PORT_A)
            count = lambda: ac.tapir("_Count")["count"]  # noqa: E731

            print("build, verify, replace")
            r1 = B.build(model, {"mode": "replace", "story": 0, "port": PORT_A}, log=quiet)
            check(r1["ok"] and r1["verification"].startswith(f"{r1['created']}/{r1['created']}"), f"first build verified: {r1['verification']}")
            check(r1["replaced"] is None, "first Replace falls back to Append (nothing to replace)")
            r2 = B.build(model, {"mode": "replace", "story": 0, "port": PORT_A}, log=quiet)
            check(r2["ok"] and r2["replaced"]["summary"].startswith(f"{r1['created']} deleted"), f"second build replaces exactly the first: {r2['replaced']['summary']}")
            check(count() == r2["created"], "only the new build is left in the project")
            j2 = B.load_journal(r2["runId"])
            ac.tapir("_Edit", {"guid": j2["elements"][-1]["guid"]})
            lines = []
            r3 = B.build(model, {"mode": "replace", "story": 1, "port": PORT_A, "origin": [10, 5, 0], "rotationDeg": 30}, log=lines.append)
            check(r3["ok"], f"rotated 30 deg build on story 1 verified: {r3['verification']}")
            check("1 kept" in r3["replaced"]["summary"], f"an element edited by the user is kept: {r3['replaced']['summary']}")
            check(any("rows convention" in x for x in lines), "the rotated build measured the axis convention first (rows, like Archicad 29)")

            print("identity and colours")
            dump = ac.tapir("_Dump")
            mine = [e for e in dump["elements"].values() if e["id"].startswith(f"KC-{r3['runId'][-6:]}-")]
            ids = [e["id"] for e in mine]
            check(len(ids) == r3["created"] and len(set(ids)) == len(ids), f"{len(ids)} unique element IDs KC-<run>-<key>")
            surf = {s["attributeId"]["guid"]: s["name"] for s in dump["surfaces"]}
            morphs = [e for e in mine if e["type"] == "Morph"]
            check(all(e["surface"] for e in morphs), "every morph has a surface")
            check(any("Base fronts #b08f6e" in surf.get(e["surface"], "") for e in morphs), "base fronts carry the configurator colour #b08f6e")
            check(any("Worktop #e4ddd2" in surf.get(e["surface"], "") for e in morphs), "worktop carries #e4ddd2")

            print("recovery")
            runs = B.project_runs(B.project_identity(ac))
            check(len(runs) == 1 and runs[0]["runId"] == r3["runId"], "superseded runs are not offered again")
            rm = B.remove_run(r3["runId"], PORT_A, log=quiet)
            check(rm["summary"].endswith("0 already gone") and count() == 1, f"remove run leaves only the user's edited element: {rm['summary']}")

            print("build file")
            doc = {"format": B.BUILD_FORMAT, "version": 1, "name": "test", "mode": "append", "walls": False,
                   "placement": {"origin": [12, 3.5, 0], "rotationDeg": 0, "story": 1}, "model": model}
            m2, s2 = B.from_build_file(json.loads(json.dumps(doc)))
            check(s2["story"] == 1 and s2["origin"] == [12.0, 3.5, 0.0] and s2["walls"] is False and s2["mode"] == "append", "placement, story, walls and mode come from the file")
            bad = json.loads(json.dumps(doc))
            bad["model"]["boxes"][0]["kind"] = "rm -rf"
            try:
                B.from_build_file(bad)
                check(False, "an unknown element kind is refused")
            except ValueError:
                check(True, "an unknown element kind is refused")
            check(len(B.dry_run(m2, {"walls": True})["CreateMorphs"]["morphsData"]) == len(m2["boxes"]), "dry run writes one morph per box")

            print("several Archicads: never guess")
            b = mock(PORT_B, "Riverside")
            try:
                try:
                    B.connect()
                    check(False, "connect() refuses to pick one of two Archicads")
                except B.ArchicadError:
                    check(True, "connect() refuses to pick one of two Archicads")
                st = B.status()
                check(st["multiple"] and len(st["instances"]) == 2 and not st["connected"], "status() lists both projects instead of choosing")
                check(B.status(PORT_B)["project"]["projectName"] == "Riverside", "status(port) reads the chosen project")
                check(L.pick_site(None, quiet) is None, "launcher: a Zone selected in two Archicads is not guessed")
                check(L.pick_site(PORT_B, quiet)["originX"] == 12000, "launcher: --port picks that project's Zone")
            finally:
                b.terminate()
            c = mock(PORT_B, "Riverside", "--no-zone")
            try:
                site = L.pick_site(None, quiet)
                check(site is not None and site["acWalls"] is False, "launcher: the one Archicad with a selected Zone identifies the project")
            finally:
                c.terminate()
        finally:
            a.terminate()
    print(f"\n{len(failures)} failure(s)" if failures else "\nAll Archicad checks passed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

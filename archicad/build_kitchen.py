#!/usr/bin/env python3
"""
Build a generated kitchen in Archicad through the Tapir add-on.

Input is the model JSON produced by generator.js (the web app's
"Export > Model JSON", or `node tools/export.js params.json`). Everything is
created as native Archicad elements:

  room walls      -> Wall        (TapirCommand.CreateWalls)
  door / window   -> Door/Window (TapirCommand.CreateDoors / CreateWindows)
  every box       -> Morph box   (TapirCommand.CreateMorphs, oriented with x/y/z axes)

Elements are put on layers named "KITCHEN - <category>", created when missing.
The GUIDs of each build are written to archicad/last_build.json so the next
build can replace it.

Only the Python standard library is used. Archicad's JSON API listens on
localhost:19723 (the next free port up to 19744 when several Archicads run).

Usage:
  python3 archicad/build_kitchen.py model.json              # build
  python3 archicad/build_kitchen.py model.json --test       # place one of each type, verify, delete
  python3 archicad/build_kitchen.py model.json --dry-run out.json   # write the Tapir payloads only
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LAST_BUILD = os.path.join(HERE, "last_build.json")
PORTS = range(19723, 19745)
BATCH = 200
LAYER_PREFIX = "KITCHEN - "

REQUIRED = ["GetAddOnVersion", "CreateMorphs", "SetDetailsOfElements", "DeleteElements",
            "GetAttributesByType", "CreateLayers"]
OPTIONAL = ["CreateWalls", "CreateDoors", "CreateWindows", "GetStories", "Get3DBoundingBoxes"]


class ArchicadError(RuntimeError):
    pass


# ----------------------------------------------------------------------------- connection

class Archicad:
    def __init__(self, port: int | None = None, timeout: float = 60.0):
        self.timeout = timeout
        self.port = port or self.find_port()
        if self.port is None:
            raise ArchicadError("Archicad is not reachable on ports 19723-19744. Is a project open?")

    @staticmethod
    def _post(port: int, payload: dict, timeout: float) -> dict:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}", data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    @classmethod
    def find_port(cls) -> int | None:
        for port in PORTS:
            try:
                res = cls._post(port, {"command": "API.IsAlive"}, 0.6)
                if res.get("succeeded") and res.get("result", {}).get("isAlive"):
                    return port
            except (urllib.error.URLError, OSError, ValueError):
                continue
        return None

    def api(self, command: str, parameters: dict | None = None) -> dict:
        payload = {"command": command}
        if parameters is not None:
            payload["parameters"] = parameters
        res = self._post(self.port, payload, self.timeout)
        if not res.get("succeeded"):
            err = res.get("error", {})
            raise ArchicadError(f"{command}: {err.get('message', err)}")
        return res.get("result", {})

    def tapir(self, name: str, parameters: dict | None = None) -> dict:
        params = {"addOnCommandId": {"commandNamespace": "TapirCommand", "commandName": name}}
        if parameters is not None:
            params["addOnCommandParameters"] = parameters
        out = self.api("API.ExecuteAddOnCommand", params).get("addOnCommandResponse", {})
        if isinstance(out, dict) and out.get("success") is False and "error" in out:
            raise ArchicadError(f"{name}: {out['error'].get('message', out['error'])}")
        if isinstance(out, dict) and set(out.keys()) == {"error"}:
            raise ArchicadError(f"{name}: {out['error'].get('message', out['error'])}")
        return out

    def available(self, name: str) -> bool:
        try:
            r = self.api("API.IsAddOnCommandAvailable",
                         {"addOnCommandId": {"commandNamespace": "TapirCommand", "commandName": name}})
            return bool(r.get("available"))
        except ArchicadError:
            return False


def status(port: int | None = None) -> dict:
    """Connection summary used by serve.py's /api/status."""
    port = port or Archicad.find_port()
    if port is None:
        return {"archicad": False, "ports": "19723-19744"}
    ac = Archicad(port)
    info = {"archicad": True, "port": port}
    try:
        info["tapir"] = ac.tapir("GetAddOnVersion").get("version")
    except ArchicadError as e:
        info["tapir"] = None
        info["error"] = f"Tapir not responding: {e}"
    info["missing"] = [c for c in REQUIRED + OPTIONAL if not ac.available(c)] if info.get("tapir") else REQUIRED
    return info


# ----------------------------------------------------------------------------- payloads

MM = 0.001


def morph_payload(b: dict, z_base: float) -> dict:
    """Oriented box -> Tapir CreateMorphs item. Archicad works in metres."""
    ux, uy = b["ux"], b["uy"]
    vx, vy = -uy, ux  # local y axis, 90 deg CCW from u (right-handed with z up)
    L, D, H = b["L"], b["D"], b["H"]
    x0 = b["cx"] - ux * L / 2 - vx * D / 2
    y0 = b["cy"] - uy * L / 2 - vy * D / 2
    return {
        "basePoint": {"x": x0 * MM, "y": y0 * MM, "z": z_base + b["z"] * MM},
        "size": {"x": L * MM, "y": D * MM, "z": H * MM},
        "xAxis": {"x": ux, "y": uy, "z": 0.0},
        "yAxis": {"x": vx, "y": vy, "z": 0.0},
        "zAxis": {"x": 0.0, "y": 0.0, "z": 1.0},
    }


def wall_payload(w: dict, floor_index: int) -> dict:
    return {
        "begCoordinate": {"x": w["x1"] * MM, "y": w["y1"] * MM},
        "endCoordinate": {"x": w["x2"] * MM, "y": w["y2"] * MM},
        "floorIndex": floor_index,
        "zCoordinate": 0.0,
        "height": w["h"] * MM,
        "thickness": w["t"] * MM,
        "structureType": "Basic",
        "referenceLineLocation": "Center",
    }


def wall_payload_minimal(w: dict) -> dict:
    """For older Tapir versions whose CreateWalls schema rejects the optional fields."""
    return {"begCoordinate": {"x": w["x1"] * MM, "y": w["y1"] * MM},
            "endCoordinate": {"x": w["x2"] * MM, "y": w["y2"] * MM}}


def opening_payload(o: dict, wall_guid: str) -> dict:
    return {"ownerWallId": {"guid": wall_guid}, "centerOffset": o["offset"] * MM,
            "width": o["w"] * MM, "height": o["h"] * MM, "sillHeight": o["sill"] * MM}


def expected_aabb(b: dict, z_base: float) -> tuple:
    hx = abs(b["ux"]) * b["L"] / 2 + abs(b["nx"]) * b["D"] / 2
    hy = abs(b["uy"]) * b["L"] / 2 + abs(b["ny"]) * b["D"] / 2
    return ((b["cx"] - hx) * MM, (b["cy"] - hy) * MM, z_base + b["z"] * MM,
            (b["cx"] + hx) * MM, (b["cy"] + hy) * MM, z_base + (b["z"] + b["H"]) * MM)


# ----------------------------------------------------------------------------- helpers

def guids_of(result: dict) -> tuple[list, list]:
    ok, errors = [], []
    for item in result.get("elements", []):
        if "elementId" in item:
            ok.append(item["elementId"]["guid"])
        else:
            ok.append(None)
            errors.append(item.get("error", {}).get("message", str(item)))
    return ok, errors


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def story_level(ac: Archicad, floor_index: int, log) -> float:
    try:
        stories = ac.tapir("GetStories").get("stories", [])
        for s in stories:
            if s.get("index") == floor_index:
                return float(s.get("level", 0.0))
        log(f"  story {floor_index} not found, using level 0")
    except ArchicadError as e:
        log(f"  GetStories unavailable ({e}); assuming story level 0")
    return 0.0


def ensure_layers(ac: Archicad, names: list[str], log) -> dict:
    def existing():
        res = ac.tapir("GetAttributesByType", {"attributeType": "Layer"})
        return {a["name"]: a["index"] for a in res.get("attributes", [])}

    have = existing()
    missing = [n for n in names if n not in have]
    if missing:
        ac.tapir("CreateLayers", {"layerDataArray": [{"name": n} for n in missing]})
        log(f"  created layers: {', '.join(missing)}")
        have = existing()
    return {n: have[n] for n in names if n in have}


def set_layers(ac: Archicad, pairs: list[tuple[str, int]], log):
    items = [{"elementId": {"guid": g}, "details": {"layerIndex": idx}} for g, idx in pairs if g]
    for part in chunks(items, BATCH):
        try:
            ac.tapir("SetDetailsOfElements", {"elementsWithDetails": part})
        except ArchicadError as e:
            log(f"  ! layer assignment failed: {e}")
            return


def delete(ac: Archicad, guids: list[str], log):
    guids = [g for g in guids if g]
    for part in chunks(guids, BATCH):
        try:
            ac.tapir("DeleteElements", {"elements": [{"elementId": {"guid": g}} for g in part]})
        except ArchicadError as e:
            log(f"  ! delete failed: {e}")


def create_walls(ac: Archicad, walls: list, floor_index: int, log) -> list:
    try:
        res = ac.tapir("CreateWalls", {"wallsData": [wall_payload(w, floor_index) for w in walls]})
    except ArchicadError as e:
        log(f"  CreateWalls rejected full payload ({e}); retrying with coordinates only")
        res = ac.tapir("CreateWalls", {"wallsData": [wall_payload_minimal(w) for w in walls]})
    guids, errors = guids_of(res)
    for err in errors:
        log(f"  ! wall: {err}")
    return guids


def create_openings(ac: Archicad, model: dict, wall_guids: dict, log) -> list:
    created = []
    for kind, cmd, key in (("door", "CreateDoors", "doorsData"), ("window", "CreateWindows", "windowsData")):
        items = [o for o in model["openings"] if o["kind"] == kind and wall_guids.get(o["wall"])]
        if not items:
            continue
        if not ac.available(cmd):
            log(f"  {cmd} not available in this Tapir version — skipped {kind}s")
            continue
        res = ac.tapir(cmd, {key: [opening_payload(o, wall_guids[o["wall"]]) for o in items]})
        guids, errors = guids_of(res)
        for err in errors:
            log(f"  ! {kind}: {err}")
        created += [g for g in guids if g]
    return created


def create_morphs(ac: Archicad, boxes: list, z_base: float, log) -> list:
    guids = []
    for part in chunks(boxes, BATCH):
        res = ac.tapir("CreateMorphs", {"morphsData": [morph_payload(b, z_base) for b in part]})
        g, errors = guids_of(res)
        for err in errors[:5]:
            log(f"  ! morph: {err}")
        guids += g
    return guids


# ----------------------------------------------------------------------------- commands

def check_commands(ac: Archicad, log) -> str:
    version = ac.tapir("GetAddOnVersion").get("version", "?")
    log(f"Archicad on port {ac.port}, Tapir {version}")
    missing = [c for c in REQUIRED if not ac.available(c)]
    if missing:
        raise ArchicadError(f"Tapir {version} lacks required commands: {', '.join(missing)}. Update Tapir.")
    return version


def build(model: dict, options: dict | None = None, log=print, port: int | None = None) -> dict:
    opts = {"walls": True, "replace": True, "floorIndex": 0}
    opts.update(options or {})
    ac = Archicad(port)
    check_commands(ac, log)
    floor = int(opts["floorIndex"])
    t0 = time.time()

    if opts["replace"] and os.path.exists(LAST_BUILD):
        with open(LAST_BUILD, encoding="utf-8") as f:
            prev = json.load(f).get("guids", [])
        if prev:
            log(f"Removing previous build ({len(prev)} elements)…")
            delete(ac, prev, log)

    cats = sorted({b["cat"] for b in model["boxes"]} | ({"Walls"} if opts["walls"] else set()))
    layers = ensure_layers(ac, [LAYER_PREFIX + c for c in cats], log)
    z_base = story_level(ac, floor, log)

    created, layer_pairs, failed = [], [], 0

    if opts["walls"] and model.get("walls"):
        if ac.available("CreateWalls"):
            log(f"Creating {len(model['walls'])} walls…")
            wg = create_walls(ac, model["walls"], floor, log)
            wall_guids = {w["id"]: g for w, g in zip(model["walls"], wg) if g}
            failed += sum(1 for g in wg if not g)
            op = create_openings(ac, model, wall_guids, log)
            created += [g for g in wg if g] + op
            layer = layers.get(LAYER_PREFIX + "Walls")
            if layer is not None:
                layer_pairs += [(g, layer) for g in wg if g]
        else:
            log("CreateWalls not available in this Tapir version — walls skipped")

    log(f"Creating {len(model['boxes'])} morph boxes…")
    mg = create_morphs(ac, model["boxes"], z_base, log)
    failed += sum(1 for g in mg if not g)
    created += [g for g in mg if g]
    for b, g in zip(model["boxes"], mg):
        idx = layers.get(LAYER_PREFIX + b["cat"])
        if g and idx is not None:
            layer_pairs.append((g, idx))

    log("Assigning layers…")
    set_layers(ac, layer_pairs, log)

    with open(LAST_BUILD, "w", encoding="utf-8") as f:
        json.dump({"time": time.strftime("%Y-%m-%d %H:%M:%S"), "layout": model["params"]["layout"],
                   "guids": created}, f, indent=1)
    log(f"Built {len(created)} elements in {time.time() - t0:.1f}s ({failed} failed).")
    return {"created": len(created), "failed": failed}


def test_placement(model: dict, log=print, port: int | None = None) -> dict:
    """Place one element of each type, read the geometry back, compare, delete."""
    ac = Archicad(port)
    check_commands(ac, log)
    z_base = story_level(ac, 0, log)
    made = []
    try:
        if model.get("walls") and ac.available("CreateWalls"):
            wg = create_walls(ac, model["walls"][:1], 0, log)
            made += [g for g in wg if g]
            log(f"  wall: {'ok' if wg and wg[0] else 'FAILED'}")
        samples = {}
        for b in model["boxes"]:
            # one per kind, preferring rotated ones so orientation gets verified
            if b["kind"] not in samples or (abs(b["ux"]) < 0.5 and abs(samples[b["kind"]]["ux"]) > 0.5):
                samples[b["kind"]] = b
        boxes = list(samples.values())
        mg = create_morphs(ac, boxes, z_base, log)
        made += [g for g in mg if g]
        if ac.available("Get3DBoundingBoxes"):
            res = ac.tapir("Get3DBoundingBoxes", {"elements": [{"elementId": {"guid": g}} for g in mg if g]})
            bbs = iter(res.get("boundingBoxes3D", []))
            worst = 0.0
            for b, g in zip(boxes, mg):
                if not g:
                    log(f"  {b['kind']}: FAILED to create")
                    continue
                bb = next(bbs, {}).get("boundingBox3D")
                if not bb:
                    log(f"  {b['kind']}: no bounding box returned")
                    continue
                got = (bb["xMin"], bb["yMin"], bb["zMin"], bb["xMax"], bb["yMax"], bb["zMax"])
                err = max(abs(a - e) for a, e in zip(got, expected_aabb(b, z_base)))
                worst = max(worst, err)
                log(f"  {b['kind']:<10} {'ok' if err < 0.002 else 'MISMATCH'}  (max deviation {err * 1000:.1f} mm)")
            log(f"Geometry check: {'PASS' if worst < 0.002 else 'FAIL'} (worst {worst * 1000:.1f} mm)")
        else:
            log(f"  created {sum(1 for g in mg if g)}/{len(boxes)} sample morphs (Get3DBoundingBoxes unavailable, not verified)")
    finally:
        delete(ac, made, log)
        log(f"Removed {len(made)} test elements.")
    return {"created": 0, "tested": len(made)}


def dry_run(model: dict, options: dict | None = None) -> dict:
    opts = {"walls": True, "floorIndex": 0}
    opts.update(options or {})
    return {
        "CreateWalls": {"wallsData": [wall_payload(w, opts["floorIndex"]) for w in model["walls"]]} if opts["walls"] else None,
        "CreateDoors/Windows": [{"wall": o["wall"], **opening_payload(o, "<wall guid>")} for o in model["openings"]],
        "CreateMorphs": {"morphsData": [morph_payload(b, 0.0) for b in model["boxes"]]},
        "layers": sorted({LAYER_PREFIX + b["cat"] for b in model["boxes"]}),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", help="model JSON exported from the configurator")
    ap.add_argument("--test", action="store_true", help="test placement only (creates and removes samples)")
    ap.add_argument("--dry-run", metavar="OUT", help="write Tapir payloads to OUT instead of building")
    ap.add_argument("--no-walls", action="store_true", help="skip room walls, door and window")
    ap.add_argument("--keep", action="store_true", help="do not delete the previous build")
    ap.add_argument("--floor", type=int, default=0, help="story index (default 0)")
    ap.add_argument("--port", type=int, help="Archicad JSON API port (default: scan 19723-19744)")
    a = ap.parse_args(argv)

    with open(a.model, encoding="utf-8") as f:
        model = json.load(f)
    if "boxes" not in model:
        sys.exit("Not a model file — export 'Model JSON' from the configurator (or run tools/export.js).")
    options = {"walls": not a.no_walls, "replace": not a.keep, "floorIndex": a.floor}
    try:
        if a.dry_run:
            with open(a.dry_run, "w", encoding="utf-8") as f:
                json.dump(dry_run(model, options), f, indent=1)
            print(f"Wrote payloads to {a.dry_run}")
        elif a.test:
            test_placement(model, port=a.port)
        else:
            build(model, options, port=a.port)
    except (ArchicadError, urllib.error.URLError) as e:
        sys.exit(f"Error: {e}")


if __name__ == "__main__":
    main()

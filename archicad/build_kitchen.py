#!/usr/bin/env python3
"""
Build a Kitchen Configurator design in Archicad through the Tapir add-on.

Input is a build file exported by the web app ("Send to Archicad > Download build
file", `<name>.kitchen-build.json`) or a model JSON (Export > Model JSON,
`node tools/export.js`). Everything is created as native Archicad elements:

  room walls      -> Wall        (CreateWalls), split at thresholds
  door / window   -> Door/Window (CreateDoors / CreateWindows), in the wall segment
                                 that contains it, at its exact centre offset
  threshold beam  -> Beam        (CreateBeams, hung from the ceiling;
                                 a header wall when CreateBeams is missing)
  every box       -> Morph box   (CreateMorphs, oriented with x/y/z axes)

Safety, as in the Parkform builder this follows:
* Talks only to Archicad on 127.0.0.1:19723-19744. With several Archicads open the
  target must be chosen; it is never guessed.
* Project identity = a project token kept in the source field of an app-owned
  "Kitchen Configurator" classification system (created on the first build), plus
  the project path when the project is saved.
* Every run is journalled (Documents/Kitchen Configurator/journal/<run>.json) after
  each batch, so a crash leaves a recoverable list of GUIDs.
* Every element is verified by read-back: type, story, layer and 3D bounding box.
  The as-built state is recorded.
* Replace runs only after the new build is created and verified, in the same
  identified project, and deletes only the previous run's elements that still pass
  every ownership check (still there, same type, same layer, geometry unchanged).
  Nothing is ever deleted by type or layer query.

Only the Python standard library is used.

Usage:
  python3 archicad/build_kitchen.py BUILD.kitchen-build.json [--mode append|replace] [--story N] [--yes]
  python3 archicad/build_kitchen.py BUILD.json --test            place one of each type, verify, delete
  python3 archicad/build_kitchen.py BUILD.json --dry-run OUT     write the Tapir payloads only
  python3 archicad/build_kitchen.py --status | --builds | --remove RUN_ID
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
LAST_BUILD = os.path.join(HERE, "last_build.json")  # read once for builds made before journals existed
JOURNAL = Path.home() / "Documents" / "Kitchen Configurator" / "journal"
def _ports():
    # KITCHEN_ARCHICAD_PORTS="29723-29725" points the tests at a mock instead of a real Archicad
    lo, _, hi = os.environ.get("KITCHEN_ARCHICAD_PORTS", "19723-19744").partition("-")
    return range(int(lo), int(hi or lo) + 1)


PORTS = _ports()
BATCH = 200
LAYER_PREFIX = "KITCHEN - "
MIN_TAPIR = (1, 4, 0)  # CreateWalls, CreateBeams, CreateMorphs with axes, CreateDoors/Windows
XY_TOL = 0.005
Z_TOL = 0.012
CLASS_SYSTEM = "Kitchen Configurator"
CLASS_ITEM = "KC"
TOKEN_PREFIX = "Kitchen Configurator; project token "

REQUIRED = ["GetAddOnVersion", "CreateMorphs", "SetDetailsOfElements", "DeleteElements",
            "GetAttributesByType", "CreateLayers", "GetStories", "GetDetailsOfElements", "Get3DBoundingBoxes"]
OPTIONAL = ["CreateWalls", "CreateDoors", "CreateWindows", "CreateBeams", "CreateSurfaces", "CreateClassificationSystems",
            "UpdateClassificationSystems", "GetProjectInfo"]


class ArchicadError(RuntimeError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def version_tuple(v):
    try:
        return tuple(int(x) for x in str(v).split(".")[:3])
    except ValueError:
        return (0, 0, 0)


# ----------------------------------------------------------------------------- connection

class Archicad:
    def __init__(self, port: int | None = None, timeout: float = 60.0):
        self.timeout = timeout
        if port is not None and port not in PORTS:
            raise ArchicadError("Port outside the Archicad range 19723-19744.")
        self.port = port or self.find_port()
        if self.port is None:
            raise ArchicadError(f"Archicad is not reachable on ports {PORTS.start}-{PORTS.stop - 1}. Is a project open?")

    @staticmethod
    def _post(port: int, payload: dict, timeout: float) -> dict:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}", data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    @classmethod
    def find_port(cls) -> int | None:
        found = discover()
        return found[0]["port"] if found else None

    def api(self, command: str, parameters: dict | None = None, timeout: float | None = None) -> dict:
        payload = {"command": command}
        if parameters is not None:
            payload["parameters"] = parameters
        res = self._post(self.port, payload, timeout or self.timeout)
        if not res.get("succeeded"):
            err = res.get("error", {})
            raise ArchicadError(f"{command}: {err.get('message', err)}")
        return res.get("result", {})

    def tapir(self, name: str, parameters: dict | None = None, timeout: float | None = None) -> dict:
        params = {"addOnCommandId": {"commandNamespace": "TapirCommand", "commandName": name}}
        if parameters is not None:
            params["addOnCommandParameters"] = parameters
        out = self.api("API.ExecuteAddOnCommand", params, timeout).get("addOnCommandResponse", {})
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


def probe(port: int, timeout: float = 0.6):
    """{port, tapir, archicad, build, language} when an Archicad with Tapir answers on this port."""
    try:
        ac = Archicad(port, timeout)
        if not ac.api("API.IsAlive", timeout=timeout).get("isAlive"):
            return None
        v = ac.tapir("GetAddOnVersion", timeout=timeout).get("version")
        info = {}
        try:
            info = ac.api("API.GetProductInfo", timeout=timeout)
        except Exception:  # noqa: BLE001 - version info is optional
            pass
        return {"port": port, "tapir": v, "archicad": info.get("version"), "build": info.get("buildNumber"), "language": info.get("languageCode")}
    except Exception:  # noqa: BLE001 - anything else on that port is simply "not Archicad"
        return None


def discover():
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        return [r for r in pool.map(probe, PORTS) if r]


def connect(port: int | None = None):
    """(Archicad, info). With several Archicads running an explicit port is required: never guess the project."""
    if port is not None:
        f = probe(int(port))
        if not f:
            raise ArchicadError(f"No Archicad with Tapir answers on port {port}.")
        return Archicad(f["port"]), f
    found = discover()
    if not found:
        raise ArchicadError("No Archicad with the Tapir add-on found on ports 19723-19744.")
    if len(found) > 1:
        raise ArchicadError(f"{len(found)} Archicad instances are running ({', '.join(str(f['port']) for f in found)}). "
                            "Choose the project explicitly (--port N), or close the others.")
    return Archicad(found[0]["port"]), found[0]


def writable(info) -> tuple[bool, str]:
    if version_tuple(info.get("tapir")) < MIN_TAPIR:
        return False, f"Tapir {info.get('tapir')} is too old: {'.'.join(map(str, MIN_TAPIR))} or newer is needed (update the add-on)."
    return True, ""


# ----------------------------------------------------------------------------- project identity

def _class_system(ac):
    systems = ac.api("API.GetAllClassificationSystems").get("classificationSystems", [])
    return next((s for s in systems if s.get("name") == CLASS_SYSTEM), None)


def project_identity(ac) -> dict:
    """Name/path from GetProjectInfo; the token lives in our own classification system's source field
    (the user's project info fields are never touched)."""
    try:
        info = ac.tapir("GetProjectInfo")
    except ArchicadError:
        info = {}
    token, readable = None, True
    try:
        src = (_class_system(ac) or {}).get("source") or ""
        if src.startswith(TOKEN_PREFIX):
            token = src[len(TOKEN_PREFIX):].strip() or None
    except ArchicadError:
        readable = False
    return {"isUntitled": info.get("isUntitled"), "isTeamwork": info.get("isTeamwork"), "projectName": info.get("projectName"),
            "projectPath": info.get("projectPath") or info.get("projectLocation"), "token": token, "tokenReadable": readable}


def ensure_token(ac, ident) -> tuple[str, bool]:
    if ident["token"]:
        return ident["token"], False
    if not ident["tokenReadable"]:
        raise ArchicadError("Classification systems cannot be read, so the project cannot be identified.")
    token = "kc-" + secrets.token_hex(8)
    cs = _class_system(ac)
    if cs is None:
        ac.tapir("CreateClassificationSystems", {"classificationSystemsWithItems": [{
            "classificationSystem": {"name": CLASS_SYSTEM, "description": "Elements generated by the Kitchen Configurator.",
                                     "source": TOKEN_PREFIX + token, "version": "1", "date": datetime.now().strftime("%Y-%m-%d")},
            "classificationItems": [{"id": CLASS_ITEM, "name": "Kitchen Configurator element",
                                     "description": "Created by the Kitchen Configurator; replaced only by it."}]}]})
    else:
        ac.tapir("UpdateClassificationSystems", {"classificationSystems": [{"classificationSystemId": cs["classificationSystemId"], "source": TOKEN_PREFIX + token}]})
    again = project_identity(ac)
    if again["token"] != token:
        raise ArchicadError("The project token could not be written and read back, so the project cannot be identified.")
    return token, True


def same_project(journal_project, ident) -> tuple[bool, str]:
    if not ident.get("token") or (journal_project or {}).get("token") != ident["token"]:
        return False, "project token differs (or is missing): this is not the project of that build"
    jp, ip = journal_project.get("projectPath"), ident.get("projectPath")
    if jp and ip and jp != ip:
        return False, f"project path differs ({ip} vs {jp}): a copy of the project? Replacement refused"
    return True, "same project token" + (" and path" if jp and ip else "")


def instances(found=None):
    out = []
    for f in (discover() if found is None else found):
        try:
            i = project_identity(Archicad(f["port"], 3))
        except Exception:  # noqa: BLE001
            i = {}
        out.append(dict(f, **{k: i.get(k) for k in ("isUntitled", "projectName", "projectPath", "token")}))
    return out


def status(port: int | None = None) -> dict:
    """Connection summary: used by serve.py's /api/status and the Archicad window.
    The ports are scanned once; with several Archicads and no port given it lists them instead of guessing."""
    ports = f"{PORTS.start}-{PORTS.stop - 1}"
    if port is None:
        found = discover()
        if len(found) != 1:
            inst = instances(found)
            err = (f"{len(found)} Archicad projects are open: choose one." if found
                   else f"No Archicad with the Tapir add-on found on ports {ports}.")
            return {"archicad": False, "connected": False, "multiple": len(found) > 1, "instances": inst, "error": err, "ports": ports}
        port = found[0]["port"]
    try:
        ac, f = connect(port)
    except ArchicadError as e:
        return {"archicad": False, "connected": False, "multiple": False, "instances": [], "error": str(e), "ports": ports}
    ok, why = writable(f)
    out = {"archicad": True, "connected": True, "port": f["port"], "tapir": f["tapir"],
           "archicadVersion": f"{f.get('archicad')} (build {f.get('build')}, {f.get('language')})", "writable": ok}
    if not ok:
        out["message"] = why
    out["missing"] = [c for c in REQUIRED + OPTIONAL if not ac.available(c)]
    try:
        st = ac.tapir("GetStories")
        out["stories"] = [{"index": s["index"], "name": s.get("name") or f"Story {s['index']}", "level": s.get("level", 0.0)} for s in st.get("stories", [])]
        out["actStory"] = st.get("actStory")
    except ArchicadError as e:
        out["stories"] = []
        out["error"] = str(e)
    out["project"] = project_identity(ac)
    return out


# ----------------------------------------------------------------------------- journal

def _jpath(run_id: str) -> Path:
    if not run_id or not all(c.isalnum() or c in "-_" for c in run_id):
        raise ValueError("invalid run id")
    return JOURNAL / f"{run_id}.json"


def save_journal(j):
    JOURNAL.mkdir(parents=True, exist_ok=True)
    j["updatedAt"] = now()
    tmp = _jpath(j["runId"]).with_suffix(".tmp")
    tmp.write_text(json.dumps(j, indent=1), encoding="utf-8")
    os.replace(tmp, _jpath(j["runId"]))


def load_journal(run_id):
    return json.loads(_jpath(run_id).read_text(encoding="utf-8"))


def list_builds():
    if not JOURNAL.exists():
        return []
    out = []
    for p in sorted(JOURNAL.glob("*.json"), key=lambda q: q.stat().st_mtime, reverse=True):
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
            out.append({"runId": j["runId"], "status": j["status"], "createdAt": j.get("createdAt"), "count": len(j.get("elements", [])),
                        "project": j.get("project"), "layout": j.get("layout"), "placement": j.get("placement"),
                        "verification": (j.get("verification") or {}).get("summary"), "error": j.get("error"),
                        "replaced": j.get("replaced"), "removed": (j.get("removal") or {}).get("summary")})
        except Exception as e:  # noqa: BLE001 - a damaged journal is listed, never silently dropped
            out.append({"runId": p.stem, "status": "unreadable journal", "error": str(e), "count": 0})
    return out


REPLACEABLE = ("verified", "created-with-problems")


def previous_build(ident):
    """The newest replaceable run in this identified project, if any. A run 'created with problems' can be
    replaced too: its elements are still deleted only when they are exactly as that run built them."""
    return next((b for b in list_builds() if b["status"] in REPLACEABLE and b.get("project") and same_project(b["project"], ident)[0]), None)


# ----------------------------------------------------------------------------- payloads

MM = 0.001


def axis_aligned(b: dict) -> bool:
    return abs(abs(b["ux"]) - 1) < 1e-6 or abs(abs(b["uy"]) - 1) < 1e-6


def morph_payload(b: dict, z_base: float, convention: str = "columns") -> dict:
    """Oriented box -> Tapir CreateMorphs item (metres).

    A box square to the project axes is sent as its plain extent with identity axes, so the result
    does not depend on how the axes are read. Archicad 29 / Tapir 1.7.0 turned boxes given with
    rotated axes the opposite way (the axes act as rows of the placement matrix, not columns), so
    other angles use the convention measured by probe_morph_convention().
    """
    L, D, H = b["L"], b["D"], b["H"]
    z = {"z": z_base + b["z"] * MM}
    ident = {"xAxis": {"x": 1.0, "y": 0.0, "z": 0.0}, "yAxis": {"x": 0.0, "y": 1.0, "z": 0.0}, "zAxis": {"x": 0.0, "y": 0.0, "z": 1.0}}
    if axis_aligned(b):
        sx = abs(b["ux"]) * L + abs(b["nx"]) * D
        sy = abs(b["uy"]) * L + abs(b["ny"]) * D
        return dict({"basePoint": dict({"x": (b["cx"] - sx / 2) * MM, "y": (b["cy"] - sy / 2) * MM}, **z),
                     "size": {"x": sx * MM, "y": sy * MM, "z": H * MM}}, **ident)
    ux, uy = b["ux"], b["uy"]
    vx, vy = -uy, ux  # local y axis, 90 deg CCW from u (right-handed with z up)
    x0 = b["cx"] - ux * L / 2 - vx * D / 2
    y0 = b["cy"] - uy * L / 2 - vy * D / 2
    if convention == "rows":  # send the transpose, so the effective columns are (u, v)
        xa, ya = {"x": ux, "y": vx, "z": 0.0}, {"x": uy, "y": vy, "z": 0.0}
    else:
        xa, ya = {"x": ux, "y": uy, "z": 0.0}, {"x": vx, "y": vy, "z": 0.0}
    return {"basePoint": dict({"x": x0 * MM, "y": y0 * MM}, **z), "size": {"x": L * MM, "y": D * MM, "z": H * MM},
            "xAxis": xa, "yAxis": ya, "zAxis": {"x": 0.0, "y": 0.0, "z": 1.0}}


def probe_morph_convention(ac, z_base: float, log) -> str:
    """Place one 30-degree probe morph, read its extent back, delete it: 'columns' or 'rows'."""
    if getattr(ac, "_morph_convention", None):
        return ac._morph_convention
    a = math.radians(30)
    probe = {"cx": 0.0, "cy": 0.0, "z": 0.0, "L": 1000.0, "D": 100.0, "H": 100.0,
             "ux": math.cos(a), "uy": math.sin(a), "nx": -math.sin(a), "ny": math.cos(a)}
    want = expected_aabb(probe, z_base)
    res = ac.tapir("CreateMorphs", {"morphsData": [morph_payload(probe, z_base, "columns")]})
    g = (guids_of(res)[0] or [None])[0]
    if not g:
        raise ArchicadError("The orientation probe morph could not be created.")
    try:
        bb = (ac.tapir("Get3DBoundingBoxes", {"elements": [{"elementId": {"guid": g}}]}).get("boundingBoxes3D") or [{}])[0].get("boundingBox3D")
    finally:
        ac.tapir("DeleteElements", {"elements": [{"elementId": {"guid": g}}]})
    if not bb:
        raise ArchicadError("The orientation probe morph could not be read back.")
    got = (bb["xMin"], bb["yMin"], bb["zMin"], bb["xMax"], bb["yMax"], bb["zMax"])
    flipped = dict(probe, ux=math.cos(-a), uy=math.sin(-a), nx=-math.sin(-a), ny=math.cos(-a))
    # under the 'rows' reading the probe turns -30 degrees about its base corner
    c0x, c0y = probe["cx"] - probe["ux"] * 500 - probe["nx"] * 50, probe["cy"] - probe["uy"] * 500 - probe["ny"] * 50
    flipped["cx"], flipped["cy"] = c0x + flipped["ux"] * 500 + flipped["nx"] * 50, c0y + flipped["uy"] * 500 + flipped["ny"] * 50
    dev = lambda e: max(abs(x - y) for x, y in zip(got, e))  # noqa: E731
    d_cols, d_rows = dev(want), dev(expected_aabb(flipped, z_base))
    if min(d_cols, d_rows) > XY_TOL * 2:
        raise ArchicadError(f"Rotated morphs do not land where expected in this Archicad (probe off by {min(d_cols, d_rows) * 1000:.0f} mm). "
                            "Use a rotation that is a multiple of 90 degrees.")
    ac._morph_convention = "columns" if d_cols <= d_rows else "rows"
    log(f"  Rotated morph axes measured: {ac._morph_convention} convention")
    return ac._morph_convention


def wall_segments(model: dict) -> list:
    """Every wall split at its thresholds -> [{wall, d0, x1, y1, x2, y2, t, h}] (mm)."""
    out = []
    for w in model.get("walls", []):
        length = math.hypot(w["x2"] - w["x1"], w["y2"] - w["y1"])
        ux, uy = (w["x2"] - w["x1"]) / length, (w["y2"] - w["y1"]) / length
        for d0, d1 in w.get("segments") or [[0, length]]:
            out.append({"wall": w["id"], "d0": d0, "d1": d1, "t": w["t"], "h": w["h"], "zoff": w.get("zoff", 0),
                        "x1": w["x1"] + ux * d0, "y1": w["y1"] + uy * d0,
                        "x2": w["x1"] + ux * d1, "y2": w["y1"] + uy * d1})
    return out


def segment_for(opening: dict, segments: list):
    """The wall segment that hosts an opening, and the opening's centre offset within it."""
    for i, sg in enumerate(segments):
        if sg["wall"] == opening["wall"] and sg["d0"] - 1e-6 <= opening["offset"] - opening["w"] / 2 \
                and opening["offset"] + opening["w"] / 2 <= sg["d1"] + 1e-6:
            return i, opening["offset"] - sg["d0"]
    return None, None


def beam_payload(b: dict, z_base: float) -> dict:
    # TopCenter anchor: the reference line runs along the top of the beam, at the ceiling
    return {"begCoordinate": {"x": b["x1"] * MM, "y": b["y1"] * MM},
            "endCoordinate": {"x": b["x2"] * MM, "y": b["y2"] * MM},
            "zCoordinate": z_base + b["top"] * MM, "width": b["w"] * MM, "height": b["d"] * MM,
            "anchorPoint": "TopCenter", "isWidthAndHeightLinked": False}


def wall_payload(w: dict, floor_index: int) -> dict:
    return {
        "begCoordinate": {"x": w["x1"] * MM, "y": w["y1"] * MM},
        "endCoordinate": {"x": w["x2"] * MM, "y": w["y2"] * MM},
        "floorIndex": floor_index,
        "zCoordinate": w.get("zoff", 0) * MM,
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

def placed(model: dict, origin=None, rotation: float = 0.0) -> dict:
    """The model moved to where its room sits in the project.

    origin is (x, y, z) in mm (default: params.originX/Y, z 0); rotation is in degrees,
    counter-clockwise about the origin. The room's own corner (0, 0) lands on the origin.
    """
    p = model.get("params", {})
    ox, oy, oz = origin if origin is not None else (float(p.get("originX") or 0), float(p.get("originY") or 0), 0.0)
    if not ox and not oy and not oz and not rotation:
        return model
    c, s_ = math.cos(math.radians(rotation)), math.sin(math.radians(rotation))
    pt = lambda x, y: (ox + c * x - s_ * y, oy + s_ * x + c * y)  # noqa: E731
    vec = lambda x, y: (c * x - s_ * y, s_ * x + c * y)  # noqa: E731
    m = json.loads(json.dumps(model))
    for b in m["boxes"]:
        b["cx"], b["cy"] = pt(b["cx"], b["cy"])
        b["ux"], b["uy"] = vec(b["ux"], b["uy"])
        b["nx"], b["ny"] = vec(b["nx"], b["ny"])
        b["z"] += oz
    for w in m.get("walls", []) + m.get("beams", []):
        w["x1"], w["y1"] = pt(w["x1"], w["y1"])
        w["x2"], w["y2"] = pt(w["x2"], w["y2"])
        w["zoff"] = oz
    for b in m.get("beams", []):
        b["z"] += oz
        b["top"] += oz
    return m


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
    set_details(ac, [(g, idx, None) for g, idx in pairs], log)


def set_details(ac: Archicad, items: list, log):
    """items: (guid, layerIndex or None, element ID or None)."""
    data = []
    for g, idx, eid in items:
        d = {}
        if idx is not None:
            d["layerIndex"] = idx
        if eid:
            d["id"] = eid
        if g and d:
            data.append({"elementId": {"guid": g}, "details": d})
    for part in chunks(data, BATCH):
        try:
            ac.tapir("SetDetailsOfElements", {"elementsWithDetails": part})
        except ArchicadError as e:
            log(f"  ! layer / element ID assignment failed: {e}")
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


def create_openings(ac: Archicad, model: dict, segments: list, seg_guids: list, log) -> list:
    created = []
    for kind, cmd, key in (("door", "CreateDoors", "doorsData"), ("window", "CreateWindows", "windowsData")):
        items = []
        for o in model["openings"]:
            if o["kind"] != kind:
                continue
            i, offset = segment_for(o, segments)
            if i is None or not seg_guids[i]:
                log(f"  ! {o['id']}: no host wall segment — skipped")
                continue
            items.append(opening_payload(dict(o, offset=offset), seg_guids[i]))
            log(f"  {o['id']}: {kind} {o['w']:.0f}×{o['h']:.0f} on {o['wall']} wall, "
                f"{o['fromStart']:.0f} / {o['fromEnd']:.0f} mm from the corners")
        if not items:
            continue
        if not ac.available(cmd):
            log(f"  {cmd} not available in this Tapir version — skipped {kind}s")
            continue
        res = ac.tapir(cmd, {key: items})
        guids, errors = guids_of(res)
        for err in errors:
            log(f"  ! {kind}: {err}")
        created += [g for g in guids if g]
    return created


def create_beams(ac: Archicad, model: dict, z_base: float, floor_index: int, log) -> list:
    beams = model.get("beams") or []
    if not beams:
        return []
    if ac.available("CreateBeams"):
        try:
            res = ac.tapir("CreateBeams", {"beamsData": [beam_payload(b, z_base) for b in beams]})
        except ArchicadError as e:
            log(f"  CreateBeams rejected full payload ({e}); retrying without anchor settings")
            res = ac.tapir("CreateBeams", {"beamsData": [
                {k: v for k, v in beam_payload(b, z_base).items() if k not in ("anchorPoint", "isWidthAndHeightLinked")}
                for b in beams]})
        guids, errors = guids_of(res)
        for err in errors:
            log(f"  ! beam: {err}")
        for b in beams:
            log(f"  {b['id']}: beam {b['w']:.0f}×{b['d']:.0f} over {b['opening']}, soffit at {b['z']:.0f} mm")
        return guids
    log("  CreateBeams not available — threshold heads built as walls")
    headers = [dict(wall_payload({"x1": b["x1"], "y1": b["y1"], "x2": b["x2"], "y2": b["y2"], "t": b["w"], "h": b["d"]}, floor_index),
                    zCoordinate=b["z"] * MM) for b in beams]
    res = ac.tapir("CreateWalls", {"wallsData": headers})
    return guids_of(res)[0]


def create_morphs(ac: Archicad, boxes: list, z_base: float, log, surfaces: dict | None = None) -> list:
    guids = []
    conv = probe_morph_convention(ac, z_base, log) if any(not axis_aligned(b) for b in boxes) else "columns"

    def payload(b):
        d = morph_payload(b, z_base, conv)
        sid = (surfaces or {}).get(b.get("surface"))
        if sid:
            d["surfaceId"] = sid
        return d
    for part in chunks(boxes, BATCH):
        res = ac.tapir("CreateMorphs", {"morphsData": [payload(b) for b in part]})
        g, errors = guids_of(res)
        for err in errors[:5]:
            log(f"  ! morph: {err}")
        guids += g
    return guids


def segment_aabb(x1, y1, x2, y2, width, z0, z1):
    """Bounding box (m) of a straight element of the given width around its axis (mm in, z in m)."""
    length = math.hypot(x2 - x1, y2 - y1) or 1.0
    nx, ny = -(y2 - y1) / length * width / 2, (x2 - x1) / length * width / 2
    xs = [x1 + nx, x1 - nx, x2 + nx, x2 - nx]
    ys = [y1 + ny, y1 - ny, y2 + ny, y2 - ny]
    return (min(xs) * MM, min(ys) * MM, z0, max(xs) * MM, max(ys) * MM, z1)


def create_openings_tracked(ac: Archicad, model: dict, segments: list, seg_guids: list, log) -> list:
    """Doors and windows in their host segments -> [(guid or None, opening)]."""
    out = []
    for kind, cmd, key in (("door", "CreateDoors", "doorsData"), ("window", "CreateWindows", "windowsData")):
        items, ops = [], []
        for o in model["openings"]:
            if o["kind"] != kind:
                continue
            i, offset = segment_for(o, segments)
            if i is None or not seg_guids[i]:
                log(f"  ! {o['id']}: no host wall segment - skipped")
                continue
            items.append(opening_payload(dict(o, offset=offset), seg_guids[i]))
            ops.append(o)
        if not items:
            continue
        if not ac.available(cmd):
            log(f"  {cmd} not available in this Tapir version - {kind}s skipped")
            continue
        guids, errors = guids_of(ac.tapir(cmd, {key: items}))
        for err in errors:
            log(f"  ! {kind}: {err}")
        out += list(zip(guids, ops))
        for o in ops:
            log(f"  {o['id']}: {kind} {o['w']:.0f}x{o['h']:.0f} on the {o['wall']} wall, {o['fromStart']:.0f} / {o['fromEnd']:.0f} mm from the corners")
    return out


# ----------------------------------------------------------------------------- surfaces (colours)

STEEL, HANDLE = "#c4c7ca", "#77756f"


def material_of(b: dict, p: dict) -> tuple:
    """(surface name, #rrggbb, Archicad material type) of a box, matching the web app's 3D view."""
    base = p.get("frontColor", "#e8e2d6")
    group = {"base": base, "wall": p.get("wallFrontColor", base), "tall": p.get("tallFrontColor", base)}
    groupname = {"base": "Base fronts", "wall": "Wall unit fronts", "tall": "Tall unit fronts"}
    k = b["kind"]
    if k == "front":
        if b.get("finish") == "steel":
            return "Appliance steel", "#d2d5d8", "Metal"
        if b.get("finish") == "oven":
            return "Oven glass", "#202122", "Plastic"
        g = b.get("group") or "base"
        return groupname[g], group[g], "Matte"
    by_kind = {
        "base": ("Base carcass", group["base"]), "corner": ("Base carcass", group["base"]), "sinkBase": ("Base carcass", group["base"]),
        "cookBase": ("Base carcass", group["base"]), "dishwasher": ("Base carcass", group["base"]), "filler": ("Base carcass", group["base"]),
        "wallCab": ("Wall unit carcass", group["wall"]), "wallFiller": ("Wall unit fronts", group["wall"]),
        "pantry": ("Tall unit carcass", group["tall"]), "shelf": ("Tall unit fronts", group["tall"]),
        "counter": ("Worktop", p.get("counterColor", "#3d3b38")), "plinth": ("Plinth", "#3f3e3b"),
        "panel": ("Stone", "#ece8e0") if b.get("finish") == "stone" else ("Base fronts", group["base"]),
        "stool": ("Stools", "#8a6a4c"), "cooktop": ("Cooktop glass", "#141414"),
    }
    if k in by_kind:
        return by_kind[k] + ("Matte",)
    if k in ("fridge", "hood", "tap", "sinkBowl"):
        return "Steel", STEEL, "Metal"
    if k == "handle":
        return "Handles", HANDLE, "Metal"
    return "Base fronts", group["base"], "Matte"


def surface_name(name, hexcolor):
    # the colour is part of the name, so a later build in another finish never recolours an earlier one
    return f"KITCHEN {name} {hexcolor}"


def ensure_surfaces(ac, wanted: dict, log) -> dict:
    """wanted: {surface name: (#rrggbb, type)} -> {name: AttributeId}; creates only the missing ones."""
    def existing():
        return {a["name"]: a["attributeId"] for a in ac.tapir("GetAttributesByType", {"attributeType": "Surface"}).get("attributes", [])}
    have = existing()
    missing = [n for n in wanted if n not in have]
    if missing:
        if not ac.available("CreateSurfaces"):
            log("  CreateSurfaces not available in this Tapir version - morphs keep the default surface")
            return {}
        data = []
        for n in missing:
            hexcolor, typ = wanted[n]
            rgb = [int(hexcolor[i:i + 2], 16) / 255 for i in (1, 3, 5)]
            data.append({"name": n, "materialType": typ, "surfaceColor": {"red": rgb[0], "green": rgb[1], "blue": rgb[2]},
                         "ambientReflection": 60, "diffuseReflection": 80, "specularReflection": 30 if typ == "Metal" else 10})
        try:
            ac.tapir("CreateSurfaces", {"surfaceDataArray": data, "overwriteExisting": False})
        except ArchicadError as e:
            log(f"  ! surfaces could not be created ({e}) - morphs keep the default surface")
            return {}
        log(f"  created {len(missing)} surfaces")
        have = existing()
    return {n: have[n] for n in wanted if n in have}


# ----------------------------------------------------------------------------- build file

BUILD_FORMAT = "kitchen-configurator-build"
BUILD_SUFFIX = ".kitchen-build.json"
LIMITS = {"boxes": 20000, "coord": 1e7, "label": 120}
BOX_KINDS = {"base", "corner", "sinkBase", "cookBase", "dishwasher", "filler", "fridge", "pantry", "wallCab", "wallFiller", "plinth",
             "counter", "panel", "sinkBowl", "tap", "cooktop", "hood", "stool", "front", "handle", "shelf"}
CATS = {"Walls", "Cabinets", "Worktops", "Appliances", "Furniture"}
WALL_IDS = {"back", "front", "left", "right"}


def _num(v, what, lo=-LIMITS["coord"], hi=LIMITS["coord"]):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError(f"{what}: number out of range")
    return float(v)


def _str(v, what, n=LIMITS["label"], default=""):
    if v is None:
        return default
    if not isinstance(v, str) or len(v) > n:
        raise ValueError(f"{what}: text of up to {n} characters expected")
    return v


def validate_model(m) -> dict:
    """Strict whitelist copy of a generator model received in a file."""
    if not isinstance(m, dict) or not isinstance(m.get("boxes"), list) or not isinstance(m.get("params"), dict):
        raise ValueError("Not a kitchen model (boxes / params missing).")
    if not 0 < len(m["boxes"]) <= LIMITS["boxes"]:
        raise ValueError("Element count out of range.")
    boxes = []
    for i, b in enumerate(m["boxes"]):
        w = f"box {i}"
        if not isinstance(b, dict) or b.get("kind") not in BOX_KINDS or b.get("cat") not in CATS:
            raise ValueError(f"{w}: unknown kind or category")
        c = {k: _num(b.get(k), f"{w}.{k}") for k in ("cx", "cy", "z")}
        c.update({k: _num(b.get(k), f"{w}.{k}", 0.01, 1e5) for k in ("L", "D", "H")})
        c.update({k: _num(b.get(k), f"{w}.{k}", -1.0001, 1.0001) for k in ("ux", "uy", "nx", "ny")})
        c.update(kind=b["kind"], cat=b["cat"], id=_str(b.get("id"), w + ".id", 60) or f"box-{i}", label=_str(b.get("label"), w + ".label"),
                 group=b.get("group") if b.get("group") in ("base", "wall", "tall") else None,
                 finish=b.get("finish") if b.get("finish") in ("front", "steel", "oven", "stone") else None)
        boxes.append(c)
    walls = []
    for i, wl in enumerate(m.get("walls") or []):
        w = f"wall {i}"
        if not isinstance(wl, dict) or wl.get("id") not in WALL_IDS:
            raise ValueError(f"{w}: unknown wall")
        c = {k: _num(wl.get(k), f"{w}.{k}") for k in ("x1", "y1", "x2", "y2")}
        c.update(id=wl["id"], t=_num(wl.get("t"), w + ".t", 10, 2000), h=_num(wl.get("h"), w + ".h", 100, 20000))
        segs = wl.get("segments") or [[0, math.hypot(c["x2"] - c["x1"], c["y2"] - c["y1"])]]
        c["segments"] = [[_num(a, w + ".segments"), _num(b, w + ".segments")] for a, b in segs]
        walls.append(c)
    openings = []
    for i, o in enumerate(m.get("openings") or []):
        w = f"opening {i}"
        if not isinstance(o, dict) or o.get("kind") not in ("door", "window", "threshold") or o.get("wall") not in WALL_IDS:
            raise ValueError(f"{w}: unknown kind or wall")
        c = {k: _num(o.get(k, 0), f"{w}.{k}") for k in ("offset", "w", "h", "sill", "a0", "a1", "fromStart", "fromEnd")}
        c.update(kind=o["kind"], wall=o["wall"], id=_str(o.get("id"), w + ".id", 30) or f"O{i + 1}")
        openings.append(c)
    beams = []
    for i, bm in enumerate(m.get("beams") or []):
        w = f"beam {i}"
        c = {k: _num(bm.get(k), f"{w}.{k}") for k in ("x1", "y1", "x2", "y2", "z", "top")}
        c.update(w=_num(bm.get("w"), w + ".w", 10, 3000), d=_num(bm.get("d"), w + ".d", 10, 10000),
                 id=_str(bm.get("id"), w + ".id", 30) or f"B{i + 1}", opening=_str(bm.get("opening"), w, 30), wall=_str(bm.get("wall"), w, 10))
        beams.append(c)
    p = m["params"]
    params = {"layout": _str(p.get("layout"), "params.layout", 30) or "kitchen"}
    for k in ("roomW", "roomD", "wallH", "wallT", "originX", "originY", "acFloor"):
        if k in p:
            params[k] = _num(p[k], f"params.{k}")
    params["acWalls"] = p.get("acWalls") is not False
    for k in ("frontColor", "wallFrontColor", "tallFrontColor", "counterColor", "wallColor", "floorColor"):
        if isinstance(p.get(k), str) and re.fullmatch(r"#[0-9a-fA-F]{6}", p[k]):
            params[k] = p[k].lower()
    stats = m.get("stats") if isinstance(m.get("stats"), dict) else {}
    checks = [c for c in (m.get("checks") or []) if isinstance(c, dict) and c.get("level") in ("error", "warn")][:30]
    return {"params": params, "boxes": boxes, "walls": walls, "openings": openings, "beams": beams, "stats": stats,
            "checks": [{"level": c["level"], "msg": _str(c.get("msg"), "check", 400)} for c in checks]}


def from_build_file(doc) -> tuple[dict, dict]:
    """(model, settings) from a build file (or a plain model JSON); everything validated.
    settings: origin (m), rotationDeg, story, mode, walls, name."""
    if isinstance(doc, dict) and doc.get("format") == BUILD_FORMAT:
        if doc.get("version") != 1:
            raise ValueError(f"Unsupported build file version {doc.get('version')!r} (this script reads version 1).")
        model = validate_model(doc.get("model"))
        pl = doc.get("placement") or {}
        o = (list(pl.get("origin") or [0, 0, 0]) + [0, 0, 0])[:3]
        settings = {"origin": [_num(v, "placement.origin") for v in o], "rotationDeg": _num(pl.get("rotationDeg", 0), "placement.rotationDeg", -360, 360),
                    "story": int(pl["story"]) if isinstance(pl.get("story"), int) and not isinstance(pl.get("story"), bool) else None,
                    "mode": doc.get("mode") if doc.get("mode") in ("append", "replace") else "replace",
                    "walls": doc.get("walls") is not False, "name": _str(doc.get("name"), "name", 200)}
        return model, settings
    model = validate_model(doc)
    p = model["params"]
    return model, {"origin": [p.get("originX", 0) / 1000, p.get("originY", 0) / 1000, 0.0], "rotationDeg": 0.0,
                   "story": int(p["acFloor"]) if "acFloor" in p else None, "mode": "replace", "walls": p.get("acWalls", True),
                   "name": p.get("layout", "kitchen")}


def summarize(model) -> list:
    """[(element, count, Archicad layers)] for display."""
    rows = []
    segs = sum(len(w["segments"]) for w in model["walls"])
    if segs:
        rows.append(("Wall segments", segs, LAYER_PREFIX + "Walls"))
    for kind, label in (("door", "Doors"), ("window", "Windows")):
        n = sum(1 for o in model["openings"] if o["kind"] == kind)
        if n:
            rows.append((label, n, "(Archicad default for openings)"))
    if model["beams"]:
        rows.append(("Beams over thresholds", len(model["beams"]), LAYER_PREFIX + "Walls"))
    groups = {}
    for b in model["boxes"]:
        g = "Fronts & handles" if b["kind"] in ("front", "handle") else b["cat"]
        groups.setdefault(g, [0, set()])
        groups[g][0] += 1
        groups[g][1].add(LAYER_PREFIX + b["cat"])
    for g, (n, layers) in sorted(groups.items()):
        rows.append((f"{g} (morphs)", n, ", ".join(sorted(layers))))
    return rows


# ----------------------------------------------------------------------------- verification & ownership

def read_back(ac, guids):
    ids = [{"elementId": {"guid": g}} for g in guids]
    det, bbs = [], []
    for part in chunks(ids, BATCH):
        det += ac.tapir("GetDetailsOfElements", {"elements": part, "fields": ["type", "id", "floorIndex", "layerIndex"]}).get("detailsOfElements", [])
        bbs += ac.tapir("Get3DBoundingBoxes", {"elements": part}).get("boundingBoxes3D", [])
    return det, bbs


def verify(ac, elements) -> dict:
    """Check type, story, layer and 3D extent of every journalled element against what was planned."""
    det, bbs = read_back(ac, [e["guid"] for e in elements])
    fails = []
    for e, d, b in zip(elements, det, bbs):
        exp, why = e["expect"], []
        if not isinstance(d, dict) or "error" in d:
            fails.append({"key": e["key"], "guid": e["guid"], "why": ["not found when read back"]})
            continue
        if d.get("type") != exp["type"]:
            why.append(f"type {d.get('type')} != {exp['type']}")
        if exp.get("floorIndex") is not None and int(d.get("floorIndex", -999)) != exp["floorIndex"]:
            why.append(f"story {d.get('floorIndex')} != {exp['floorIndex']}")
        if exp.get("layerIndex") is not None and int(d.get("layerIndex", -1)) != exp["layerIndex"]:
            why.append(f"layer {d.get('layerIndex')} != {exp['layerIndex']}")
        if e.get("elementId") and d.get("id") is not None and d.get("id") != e["elementId"]:
            why.append(f"element ID {d.get('id')!r} != {e['elementId']!r}")
        bb = (b or {}).get("boundingBox3D") if isinstance(b, dict) else None
        if exp.get("bbox3"):
            if not bb:
                why.append("no 3D bounding box")
            else:
                x0, y0, z0, x1, y1, z1 = exp["bbox3"]
                off = max(abs(bb["xMin"] - x0), abs(bb["yMin"] - y0), abs(bb["xMax"] - x1), abs(bb["yMax"] - y1))
                if off > XY_TOL:
                    why.append(f"plan extent off by {off * 1000:.1f} mm")
                if abs(bb["zMin"] - z0) > Z_TOL or abs(bb["zMax"] - z1) > Z_TOL:
                    why.append(f"Z {bb['zMin']:.3f}..{bb['zMax']:.3f} m, expected {z0:.3f}..{z1:.3f} m")
        if bb:
            e["bbox"] = bb  # the state as built: later ownership checks compare against it
        if "layerIndex" in d:
            e["layerIndex"] = int(d["layerIndex"])
        if why:
            fails.append({"key": e["key"], "guid": e["guid"], "why": why})
    ok = len(elements) - len(fails)
    return {"checked": len(elements), "failed": fails, "summary": f"{ok}/{len(elements)} elements verified" + (f", {len(fails)} failed" if fails else "")}


def ownership_check(ac, journal):
    """Which of a journal's elements are still exactly as this script built them."""
    els = journal.get("elements", [])
    if not els:
        return [], []
    det, bbs = read_back(ac, [e["guid"] for e in els])
    owned, refused = [], []
    for e, d, b in zip(els, det, bbs):
        if not isinstance(d, dict) or "error" in d:
            refused.append({"guid": e["guid"], "key": e["key"], "why": "already gone"})
            continue
        why = []
        if d.get("type") != e["expect"]["type"]:
            why.append("type changed")
        if "layerIndex" in e and int(d.get("layerIndex", -1)) != e["layerIndex"]:
            why.append("moved to another layer")
        bb, fb = (b or {}).get("boundingBox3D") if isinstance(b, dict) else None, e.get("bbox")
        if fb and bb and max(abs(bb[k] - fb[k]) for k in fb) > 0.002:
            why.append("geometry edited since the build")
        (refused if why else owned).append({"guid": e["guid"], "key": e["key"], "why": "; ".join(why)})
    return owned, refused


def delete_owned(ac, guids):
    out = []
    for part in chunks(guids, BATCH):
        res = ac.tapir("DeleteElements", {"elements": [{"elementId": {"guid": g}} for g in part]}).get("executionResults", [])
        out += [{"guid": g, "ok": bool((r or {}).get("success")), "error": ((r or {}).get("error") or {}).get("message")} for g, r in zip(part, res)]
    return out


def project_runs(ident):
    """Runs of this identified project that still have elements in it (newest first)."""
    return [b for b in list_builds() if b["status"] in ("verified", "created-with-problems", "failed", "started")
            and b.get("project") and same_project(b["project"], ident)[0] and b["count"]]


def removal_summary(res, refused):
    gone = sum(1 for r in refused if r["why"] == "already gone")
    return f"{sum(1 for r in res if r['ok'])} deleted, {len(refused) - gone} kept (edited since the build), {gone} already gone"


# ----------------------------------------------------------------------------- build

def build(model: dict, options: dict | None = None, log=print, port: int | None = None) -> dict:
    """Build a validated model. options:
      mode        'append' | 'replace' (replace = remove this script's previous verified build of this
                  project, only after the new one is verified); legacy 'replace': True/False is accepted
      story       story index (legacy name: floorIndex)
      origin      (x, y, z) metres where the room's interior corner goes (default: the model's originX/Y)
      rotationDeg degrees, counter-clockwise about the origin
      walls       build the room walls, doors, windows and threshold beams
    """
    o = dict(options or {})
    mode = o.get("mode") or ("replace" if o.get("replace", True) else "append")
    if mode not in ("append", "replace"):
        raise ValueError("mode must be append or replace")
    model = validate_model(model)
    p = model["params"]
    origin = o.get("origin")
    origin_mm = (origin[0] * 1000, origin[1] * 1000, origin[2] * 1000) if origin else (p.get("originX", 0), p.get("originY", 0), 0.0)
    rot = float(o.get("rotationDeg") or o.get("rotation") or 0)
    walls = o.get("walls", True) and bool(model["walls"])
    ac, found = connect(port or o.get("port"))
    ok_write, why = writable(found)
    if not ok_write:
        raise ArchicadError(why)
    missing = [c for c in REQUIRED if not ac.available(c)]
    if missing:
        raise ArchicadError(f"Tapir {found['tapir']} lacks {', '.join(missing)}. Update Tapir.")
    stories = ac.tapir("GetStories").get("stories", [])
    story_i = int(o.get("story", o.get("floorIndex", p.get("acFloor", 0))) or 0)
    story = next((s for s in stories if s["index"] == story_i), None)
    if story is None:
        raise ValueError(f"Story {story_i} does not exist in this project.")
    z_base = float(story.get("level", 0.0))
    ident = project_identity(ac)
    previous = None
    if mode == "replace":
        prev = previous_build(ident)
        if prev:
            previous = load_journal(prev["runId"])
        else:
            log("No verified previous build of this project in the journal: building without replacing anything.")
            mode = "append"
    model = placed(model, origin_mm, rot)

    run_id = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    j = {"runId": run_id, "status": "started", "createdAt": now(), "mode": mode, "archicad": found, "layout": p.get("layout"),
         "placement": {"story": {"index": story["index"], "name": story.get("name"), "level": z_base},
                       "origin": [v / 1000 for v in origin_mm], "rotationDeg": rot, "walls": walls},
         "elements": [], "failures": [], "steps": []}
    save_journal(j)

    def step(s):
        j["steps"].append({"at": now(), "step": s})
        save_journal(j)
        log(s)

    def record(pairs, kind, typ, layer, expect_fn):
        for g, item in pairs:
            if not g:
                j["failures"].append({"kind": kind, "key": item.get("id") or item.get("key"), "error": "not created"})
                continue
            j["elements"].append({"guid": g, "key": item.get("id") or item.get("key"), "kind": kind, "layer": layer,
                                  "expect": {"type": typ, "floorIndex": story["index"], "layerIndex": None, "bbox3": expect_fn(item)}})
        save_journal(j)  # after every batch: a crash leaves a recoverable list

    t0 = time.time()
    try:
        token, created_token = ensure_token(ac, ident)
        ident = project_identity(ac)
        j["project"] = {"token": token, "isUntitled": ident["isUntitled"], "projectName": ident["projectName"],
                        "projectPath": ident["projectPath"], "tokenCreated": created_token}
        step("Project identified" + (" (token created)" if created_token else ""))
        cats = sorted({b["cat"] for b in model["boxes"]} | ({"Walls"} if walls else set()))
        layers = ensure_layers(ac, [LAYER_PREFIX + c for c in cats], log)
        j["layers"] = layers
        step(f"{len(layers)} layers ready")

        planned = len(model["boxes"])
        if walls:
            if not ac.available("CreateWalls"):
                log("CreateWalls not available in this Tapir version - walls skipped")
            else:
                segments = wall_segments(model)
                for sg in segments:
                    sg["key"] = f"wall:{sg['wall']}:{sg['d0']:.0f}"
                planned += len(segments)
                wg = create_walls(ac, segments, story["index"], log)
                record(zip(wg, segments), "wall", "Wall", LAYER_PREFIX + "Walls",
                       lambda sg: segment_aabb(sg["x1"], sg["y1"], sg["x2"], sg["y2"], sg["t"], z_base + sg["zoff"] * MM, z_base + (sg["zoff"] + sg["h"]) * MM))
                ops = create_openings_tracked(ac, model, segments, wg, log)
                planned += sum(1 for x in model["openings"] if x["kind"] in ("door", "window"))
                for kind in ("door", "window"):
                    record([(g, op) for g, op in ops if op["kind"] == kind], kind, kind.capitalize(), None, lambda op: None)
                if model["beams"]:
                    planned += len(model["beams"])
                    typ = "Beam" if ac.available("CreateBeams") else "Wall"
                    bg = create_beams(ac, model, z_base, story["index"], log)
                    record(zip(bg, model["beams"]), "beam", typ, LAYER_PREFIX + "Walls",
                           lambda b: segment_aabb(b["x1"], b["y1"], b["x2"], b["y2"], b["w"], z_base + b["z"] * MM, z_base + b["top"] * MM))
                    for e in j["elements"]:  # a beam hung from the ceiling may belong to the story above
                        if e["kind"] == "beam":
                            e["expect"]["floorIndex"] = None
        # one surface per configurator colour
        wanted = {}
        for b in model["boxes"]:
            name, hexcolor, typ = material_of(b, p)
            b["surface"] = surface_name(name, hexcolor)
            wanted[b["surface"]] = (hexcolor, typ)
        surfaces = ensure_surfaces(ac, wanted, log)
        j["surfaces"] = sorted(surfaces)
        log(f"Creating {len(model['boxes'])} morph boxes...")
        mg = create_morphs(ac, model["boxes"], z_base, log, surfaces)
        record(zip(mg, model["boxes"]), "box", "Morph", None, lambda b: expected_aabb(b, z_base))
        for e, b in zip([e for e in j["elements"] if e["kind"] == "box"], [b for b, g in zip(model["boxes"], mg) if g]):
            e["layer"] = LAYER_PREFIX + b["cat"]
        step(f"{len(j['elements'])} elements created, {len(j['failures'])} failures")

        # every element gets its own Element ID, naming the run that built it: KC-<run>-<key>
        for e in j["elements"]:
            e["elementId"] = f"KC-{run_id[-6:]}-" + re.sub(r"[^A-Za-z0-9_-]+", "-", str(e["key"])).strip("-")
            if e["layer"]:
                e["expect"]["layerIndex"] = layers[e["layer"]]
        set_details(ac, [(e["guid"], layers[e["layer"]] if e["layer"] else None, e["elementId"]) for e in j["elements"]], log)
        save_journal(j)
        step(f"Layers and element IDs set on {len(j['elements'])} elements ({len(surfaces)} surfaces)")

        ver = verify(ac, j["elements"])
        j["verification"] = ver
        ok = not ver["failed"] and not j["failures"] and len(j["elements"]) == planned
        j["status"] = "verified" if ok else "created-with-problems"
        step("Verified by read-back: " + ver["summary"])
        for f in ver["failed"][:10]:
            log(f"  ! {f['key']}: {'; '.join(f['why'])}")

        if mode == "replace" and previous is not None:
            if not ok:
                j["replaced"] = {"runId": previous["runId"], "done": False, "why": "new build not verified - previous build kept"}
            else:
                same, why_not = same_project(previous["project"], project_identity(ac))
                if not same:
                    j["replaced"] = {"runId": previous["runId"], "done": False, "why": why_not}
                else:
                    owned, refused = ownership_check(ac, previous)
                    res = delete_owned(ac, [x["guid"] for x in owned])
                    previous["status"] = "superseded"
                    previous["removal"] = {"by": run_id, "at": now(), "deleted": res, "refused": refused, "summary": removal_summary(res, refused)}
                    save_journal(previous)
                    j["replaced"] = {"runId": previous["runId"], "done": True, "summary": previous["removal"]["summary"]}
            step("Replace " + previous["runId"] + ": " + (j["replaced"].get("summary") or j["replaced"].get("why")))
        save_journal(j)
        created = len(j["elements"])
        log(f"Built {created} elements in {time.time() - t0:.1f} s · {ver['summary']}")
        return {"ok": ok, "runId": run_id, "status": j["status"], "created": created, "planned": planned, "failed": len(j["failures"]) + len(ver["failed"]),
                "verification": ver["summary"], "verificationFailures": ver["failed"][:20], "failures": j["failures"][:20],
                "replaced": j.get("replaced"), "project": j["project"], "story": story, "journal": str(_jpath(run_id))}
    except Exception as e:
        j["status"] = "failed"
        j["error"] = str(e)
        save_journal(j)
        raise ArchicadError(f"Build {run_id} failed: {e}. {len(j['elements'])} elements were created and are listed in "
                            f"the journal; use --remove {run_id} to take them out again.")


def remove_run(run_id, port=None, log=print):
    """Recovery: delete a run's elements that are still exactly as built, in the same identified project."""
    ac, _ = connect(port)
    j = load_journal(run_id)
    if j.get("status") in ("superseded", "removed"):
        raise ValueError(f"Run {run_id} is already {j['status']}.")
    if not j.get("project"):
        raise ArchicadError("This run never identified its project, so nothing can be removed safely. Its GUIDs are listed in the journal.")
    same, why = same_project(j["project"], project_identity(ac))
    if not same:
        raise ArchicadError("Removal refused: " + why)
    owned, refused = ownership_check(ac, j)
    res = delete_owned(ac, [o["guid"] for o in owned])
    j["status"] = "removed"
    j["removal"] = {"at": now(), "deleted": res, "refused": refused, "summary": removal_summary(res, refused)}
    save_journal(j)
    log(j["removal"]["summary"])
    return {"ok": True, "runId": run_id, "summary": j["removal"]["summary"], "kept": [r for r in refused if r["why"] != "already gone"][:50]}


def test_placement(model: dict, log=print, port: int | None = None, options: dict | None = None) -> dict:
    """Place one element of each kind (and one wall), verify it by read-back, delete it again."""
    o = dict(options or {})
    model = validate_model(model)
    ac, found = connect(port or o.get("port"))
    ok_write, why = writable(found)
    if not ok_write:
        raise ArchicadError(why)
    stories = ac.tapir("GetStories").get("stories", [])
    story_i = int(o.get("story", o.get("floorIndex", model["params"].get("acFloor", 0))) or 0)
    story = next((s for s in stories if s["index"] == story_i), stories[0] if stories else {"index": 0, "level": 0.0})
    z_base = float(story.get("level", 0.0))
    origin = o.get("origin")
    origin_mm = (origin[0] * 1000, origin[1] * 1000, origin[2] * 1000) if origin else None
    model = placed(model, origin_mm, float(o.get("rotationDeg") or 0))
    samples = {}
    for b in model["boxes"]:
        # one per kind, preferring rotated ones so orientation gets verified
        if b["kind"] not in samples or (abs(b["ux"]) < 0.5 <= abs(samples[b["kind"]]["ux"])):
            samples[b["kind"]] = b
    boxes = list(samples.values())
    els = []
    try:
        mg = create_morphs(ac, boxes, z_base, log)
        els += [{"guid": g, "key": b["kind"], "expect": {"type": "Morph", "floorIndex": story["index"], "bbox3": expected_aabb(b, z_base)}}
                for g, b in zip(mg, boxes) if g]
        if model["walls"] and ac.available("CreateWalls"):
            sg = wall_segments(model)[:1]
            wg = create_walls(ac, sg, story["index"], log)
            els += [{"guid": g, "key": "wall", "expect": {"type": "Wall", "floorIndex": story["index"],
                                                          "bbox3": segment_aabb(s["x1"], s["y1"], s["x2"], s["y2"], s["t"], z_base + s["zoff"] * MM, z_base + (s["zoff"] + s["h"]) * MM)}}
                    for g, s in zip(wg, sg) if g]
        ver = verify(ac, els)
        bad = {f["key"]: f["why"] for f in ver["failed"]}
        for e in els:
            log(f"  {e['key']:<11} {'ok' if e['key'] not in bad else 'MISMATCH: ' + '; '.join(bad[e['key']])}")
        log(f"Geometry check: {'PASS' if not bad else 'FAIL'} ({ver['summary']})")
    finally:
        delete_owned(ac, [e["guid"] for e in els])
        log(f"Removed {len(els)} test elements.")
    return {"created": 0, "tested": len(els), "ok": not ver["failed"] if els else False}


def dry_run(model: dict, options: dict | None = None) -> dict:
    o = dict(options or {})
    origin = o.get("origin")
    origin_mm = (origin[0] * 1000, origin[1] * 1000, origin[2] * 1000) if origin else None
    model = placed(model, origin_mm, float(o.get("rotationDeg") or 0))
    segs = wall_segments(model)
    return {
        "CreateWalls": {"wallsData": [wall_payload(w, o.get("story", 0)) for w in segs]} if o.get("walls", True) else None,
        "CreateDoors/Windows": [{"id": x["id"], "kind": x["kind"], "segment": segment_for(x, segs)[0],
                                 **opening_payload(dict(x, offset=segment_for(x, segs)[1] or 0), "<segment guid>")}
                                for x in model["openings"] if x["kind"] in ("door", "window")],
        "CreateBeams": {"beamsData": [beam_payload(b, 0.0) for b in model.get("beams", [])]},
        "CreateMorphs": {"morphsData": [morph_payload(b, 0.0) for b in model["boxes"]]},
        "layers": sorted({LAYER_PREFIX + b["cat"] for b in model["boxes"]}),
    }


# ----------------------------------------------------------------------------- command line

def load_file(path) -> tuple[dict, dict]:
    path = Path(path)
    if path.stat().st_size > 60 * 1024 * 1024:
        raise ValueError("File too large.")
    return from_build_file(json.loads(path.read_text(encoding="utf-8")))


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):  # Windows consoles may not encode every character
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="build file (.kitchen-build.json) or model JSON")
    ap.add_argument("--mode", choices=["append", "replace"])
    ap.add_argument("--story", type=int, help="story index (default: from the file, else 0)")
    ap.add_argument("--x", type=float); ap.add_argument("--y", type=float); ap.add_argument("--z", type=float)  # noqa: E702
    ap.add_argument("--rot", type=float, help="rotation in degrees")
    ap.add_argument("--no-walls", action="store_true", help="skip room walls, doors, windows and beams")
    ap.add_argument("--port", type=int, help="Archicad port when several Archicads are open")
    ap.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    ap.add_argument("--test", action="store_true", help="test placement only")
    ap.add_argument("--dry-run", metavar="OUT", help="write the Tapir payloads to OUT, do not connect")
    ap.add_argument("--status", action="store_true"); ap.add_argument("--builds", action="store_true")  # noqa: E702
    ap.add_argument("--remove", metavar="RUN_ID")
    ap.add_argument("--journal", help="journal folder (default: Documents/Kitchen Configurator/journal)")
    a = ap.parse_args(argv)
    global JOURNAL
    if a.journal:
        JOURNAL = Path(a.journal)
    try:
        if a.status:
            st = status(a.port)
            if not st["connected"]:
                print(st["error"])
                for i in st.get("instances", []):
                    print(f"  port {i['port']}: {i.get('projectName') or 'Untitled'}")
                return 1
            pj = st["project"]
            print(f"Archicad {st['archicadVersion']} · Tapir {st['tapir']} · {pj.get('projectName') or 'Untitled'}" + (f" · token {pj['token']}" if pj.get("token") else " · no kitchen build yet"))
            for s in st["stories"]:
                print(f"  story {s['index']:>3}: {s['name']} at {s['level']:.3f} m")
            return 0
        if a.builds:
            for b in list_builds():
                print(f"  {b['runId']}  {b['status']:<22} {b['count']:>5} elements  {b.get('layout') or ''}  {b.get('verification') or ''}")
            print(f"(journal: {JOURNAL})")
            return 0
        if a.remove:
            if not a.yes and input(f"Remove the elements of run {a.remove} that are still exactly as built? [y/N] ").strip().lower() not in ("y", "yes"):
                print("Cancelled.")
                return 1
            remove_run(a.remove, a.port)
            return 0
        if not a.file:
            ap.error("give a build file, or --status / --builds / --remove")
        model, s = load_file(a.file)
        origin = [a.x if a.x is not None else s["origin"][0], a.y if a.y is not None else s["origin"][1], a.z if a.z is not None else s["origin"][2]]
        opts = {"mode": a.mode or s["mode"], "story": a.story if a.story is not None else (s["story"] or 0), "origin": origin,
                "rotationDeg": a.rot if a.rot is not None else s["rotationDeg"], "walls": s["walls"] and not a.no_walls, "port": a.port}
        if a.dry_run:
            with open(a.dry_run, "w", encoding="utf-8") as f:
                json.dump(dry_run(model, opts), f, indent=1)
            print(f"Wrote payloads to {a.dry_run}")
            return 0
        if a.test:
            return 0 if test_placement(model, port=a.port, options=opts)["ok"] else 2
        print(f"{model['params']['layout']}: {len(model['boxes'])} boxes, {sum(len(w['segments']) for w in model['walls'])} wall segments, "
              f"{len(model['openings'])} openings · story {opts['story']} · origin {origin} m · rotation {opts['rotationDeg']}° · {opts['mode']}")
        if not a.yes and input("Build in Archicad now? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Cancelled - nothing was written.")
            return 1
        r = build(model, opts)
        return 0 if r["ok"] else 2
    except (ArchicadError, ValueError, urllib.error.URLError, OSError) as e:
        print(f"Error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())

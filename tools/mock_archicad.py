"""Mock of Archicad's JSON API + Tapir 1.7.x for testing the kitchen builder (tools/check_archicad.py).

  python3 tools/mock_archicad.py PORT [PROJECT_NAME] [--no-zone]

Element store with types, stories, layers, element IDs, surfaces and bounding boxes; a classification
system; selection with one selected Zone; DeleteElements results. It behaves like the real
Archicad 29 / Tapir 1.7.0 where that was measured: morph xAxis/yAxis act as ROWS of the placement
matrix (rotated morphs turn the opposite way), which mirrored the first real build.
Test hooks: _Edit {guid} moves an element as a user would; _Count; _Dump.
"""
import json
import math
import sys
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
PORT = int(ARGS[0]) if ARGS else 19723
ZONE_SELECTED = "--no-zone" not in sys.argv
STORIES = [{"index": 0, "level": 0.0, "name": "Ground"}, {"index": 1, "level": 3.0, "name": "First"}]
store = {}  # guid -> dict(type, floor, layer, bbox)
layers = [{"attributeId": {"guid": "L0"}, "index": 1, "name": "Archicad Layer"}]
classes = []
surfaces = [{"attributeId": {"guid": "S0"}, "index": 1, "name": "Generic"}]
TYPE = {"CreateWalls": "Wall", "CreateBeams": "Beam", "CreateMorphs": "Morph", "CreateDoors": "Door", "CreateWindows": "Window"}
PROJECT = {"isUntitled": False, "isTeamwork": False, "projectLocation": f"C:/Projects/Oak Street {PORT}.pln",
           "projectPath": f"C:/Projects/Oak Street {PORT}.pln", "projectName": ARGS[1] if len(ARGS) > 1 else "Oak Street"}


def floor_of(z):
    return max((s for s in STORIES if s["level"] <= z + 1e-6), key=lambda s: s["level"], default=STORIES[0])["index"]


def bbox_of(kind, d):
    if kind in ("CreateWalls", "CreateBeams"):
        b0, b1 = d["begCoordinate"], d["endCoordinate"]
        L = math.hypot(b1["x"] - b0["x"], b1["y"] - b0["y"]) or 1
        wd = d.get("thickness", d.get("width", 0.2)) / 2
        nx, ny = -(b1["y"] - b0["y"]) / L * wd, (b1["x"] - b0["x"]) / L * wd
        xs = [b0["x"] + nx, b0["x"] - nx, b1["x"] + nx, b1["x"] - nx]
        ys = [b0["y"] + ny, b0["y"] - ny, b1["y"] + ny, b1["y"] - ny]
        if kind == "CreateWalls":
            lvl = STORIES[d.get("floorIndex", 0)]["level"]
            z0 = lvl + d.get("zCoordinate", 0); z1 = z0 + d.get("height", 2.7)
        else:
            z1 = d["zCoordinate"]; z0 = z1 - d["height"]
        return {"xMin": min(xs), "yMin": min(ys), "zMin": z0, "xMax": max(xs), "yMax": max(ys), "zMax": z1}
    if kind == "CreateMorphs":
        bp, sz, Xs, Ys = d["basePoint"], d["size"], d["xAxis"], d["yAxis"]
        # like Archicad 29 / Tapir 1.7.0: the given axes act as rows of the placement matrix
        X, Y = {"x": Xs["x"], "y": Ys["x"]}, {"x": Xs["y"], "y": Ys["y"]}
        pts = [(bp["x"] + X["x"] * i * sz["x"] + Y["x"] * j * sz["y"], bp["y"] + X["y"] * i * sz["x"] + Y["y"] * j * sz["y"]) for i in (0, 1) for j in (0, 1)]
        return {"xMin": min(p[0] for p in pts), "yMin": min(p[1] for p in pts), "zMin": bp["z"], "xMax": max(p[0] for p in pts), "yMax": max(p[1] for p in pts), "zMax": bp["z"] + sz["z"]}
    return {"xMin": 0, "yMin": 0, "zMin": 0, "xMax": 1, "yMax": 1, "zMax": 2}


def floor_for(kind, d):
    if "floorIndex" in d:
        return d["floorIndex"]
    if kind == "CreateMorphs":
        return floor_of(d["basePoint"]["z"])
    if kind == "CreateBeams":
        return floor_of(d["zCoordinate"] - 0.001)
    if kind in ("CreateDoors", "CreateWindows"):
        return store.get(d["ownerWallId"]["guid"], {}).get("floor", 0)
    return 0


def tapir(name, a):
    if name == "GetAddOnVersion": return {"version": "1.7.3"}
    if name == "GetStories": return {"firstStory": 0, "lastStory": 1, "actStory": 0, "skipNullFloor": False, "stories": STORIES}
    if name == "GetProjectInfo": return PROJECT
    if name == "GetAttributesByType": return {"attributes": surfaces if a.get("attributeType") == "Surface" else layers}
    if name == "CreateSurfaces":
        for d in a["surfaceDataArray"]:
            assert 0 <= d["surfaceColor"]["red"] <= 1
            surfaces.append({"attributeId": {"guid": uuid.uuid4().hex}, "index": len(surfaces) + 1, "name": d["name"], "color": d["surfaceColor"]})
        return {"attributeIds": []}
    if name == "CreateLayers":
        for d in a["layerDataArray"]:
            layers.append({"attributeId": {"guid": uuid.uuid4().hex}, "index": len(layers) + 1, "name": d["name"]})
        return {"attributeIds": []}
    if name == "CreateClassificationSystems":
        for c in a["classificationSystemsWithItems"]:
            classes.append(dict(c["classificationSystem"], classificationSystemId={"guid": uuid.uuid4().hex}))
        return {"executionResults": [{"success": True}]}
    if name == "UpdateClassificationSystems":
        for u in a["classificationSystems"]:
            for c in classes:
                if c["classificationSystemId"] == u["classificationSystemId"]:
                    c["source"] = u.get("source", c.get("source"))
        return {"executionResults": [{"success": True}]}
    if name in TYPE:
        key = [k for k in a if k.endswith("Data")][0]
        els = []
        for d in a[key]:
            g = str(uuid.uuid4())
            store[g] = {"type": TYPE[name], "floor": floor_for(name, d), "layer": 1, "bbox": bbox_of(name, d), "id": "", "surface": (d.get("surfaceId") or {}).get("guid")}
            els.append({"elementId": {"guid": g}})
        return {"elements": els}
    if name == "SetDetailsOfElements":
        res = []
        for e in a["elementsWithDetails"]:
            g = e["elementId"]["guid"]
            if g in store and "layerIndex" in e["details"]:
                store[g]["layer"] = int(e["details"]["layerIndex"])
            if g in store and "id" in e["details"]:
                store[g]["id"] = e["details"]["id"]
            res.append({"success": g in store})
        return {"executionResults": res}
    if name == "GetDetailsOfElements":
        out = []
        for e in a["elements"]:
            s = store.get(e["elementId"]["guid"])
            out.append({"error": {"code": 1, "message": "not found"}} if not s else {"type": s["type"], "id": s["id"], "floorIndex": s["floor"], "layerIndex": s["layer"]})
        return {"detailsOfElements": out}
    if name == "Get3DBoundingBoxes":
        out = []
        for e in a["elements"]:
            g = e["elementId"]["guid"]
            if g == "Z1":
                out.append({"boundingBox3D": {"xMin": 12.0, "yMin": 3.5, "zMin": 3.0, "xMax": 16.88, "yMax": 9.75, "zMax": 5.7}})
            elif g in store:
                out.append({"boundingBox3D": store[g]["bbox"]})
            else:
                out.append({"error": {"code": 1, "message": "not found"}})
        return {"boundingBoxes3D": out}
    if name == "DeleteElements":
        res = []
        for e in a["elements"]:
            res.append({"success": store.pop(e["elementId"]["guid"], None) is not None})
        return {"executionResults": res}
    if name == "GetSelectedElements": return {"elements": [{"elementId": {"guid": "Z1"}}] if ZONE_SELECTED else []}
    if name == "GetElementsByType": return {"elements": [{"elementId": {"guid": "Z1"}}] if a.get("elementType") == "Zone" else []}
    # test hook: edit an element as a user would
    if name == "_Edit":
        store[a["guid"]]["bbox"]["xMax"] += 0.1
        return {}
    if name == "_Dump": return {"elements": store, "surfaces": surfaces}
    if name == "_Count": return {"count": len(store), "types": {t: sum(1 for s in store.values() if s["type"] == t) for t in TYPE.values()}}
    return {"executionResults": []}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        c, p = req["command"], req.get("parameters", {})
        if c == "API.IsAlive": r = {"isAlive": True}
        elif c == "API.GetProductInfo": r = {"version": 29, "buildNumber": 3000, "languageCode": "INT"}
        elif c == "API.IsAddOnCommandAvailable": r = {"available": True}
        elif c == "API.GetAllClassificationSystems": r = {"classificationSystems": classes}
        elif c == "API.ExecuteAddOnCommand":
            r = {"addOnCommandResponse": tapir(p["addOnCommandId"]["commandName"], p.get("addOnCommandParameters", {}))}
        else:
            out = {"succeeded": False, "error": {"message": "unknown command " + c}}
            b = json.dumps(out).encode(); self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        b = json.dumps({"succeeded": True, "result": r}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)


HTTPServer(("127.0.0.1", PORT), H).serve_forever()

# Kitchen Configurator

A parametric kitchen configurator that runs in the browser and builds the result in **Archicad** as native elements through the [Tapir](https://github.com/ENZYME-APD/tapir-archicad-automation) add-on.

It covers the standard layouts from the reference sheets: **one-wall, galley, L-shaped, U-shaped, G-shaped and peninsula**, each with an optional **island** where it fits (one-wall, L, U). You can change the parameters live in a 3D view and a dimensioned plan. Each change re-checks the work triangle, aisles, landing space and door swing.

![layouts](https://img.shields.io/badge/layouts-6_%2B_island-e8742c) ![deps](https://img.shields.io/badge/build_step-none-5b5d3f)

## Quick start

```bash
python3 serve.py
```

Open <http://localhost:8000>. Nothing needs installing: the page is plain HTML/JS, Three.js r128 is vendored in `vendor/`, and the bridge uses only the Python standard library.

To build in Archicad, open a project in Archicad with Tapir installed, then click **Send to Archicad → Test placement** (optional) and **Build**.

> The page also works as a static site (GitHub Pages, Vercel, `file://`). In that case everything except **Send to Archicad** works, because Archicad can only be reached through `serve.py` running on the same machine.

## The workflow

1. **References.** Layout sheets define the vocabulary: runs, corners, peninsula, island, seating overhang, clearances.
2. **Design logic → parameters.** Room size, leg lengths, cabinet heights and depths, appliance placement, aisle widths, finishes.
3. **Generator.** `generator.js` turns the parameters into an element list. One pure module is shared by the 3D view, the plan, the JSON export and the Archicad build.
4. **Test and refine** in the browser. The checks panel shows when a design breaks a guideline.
5. **Send to Archicad** as walls, a door, a window and morph boxes, on `KITCHEN - …` layers.

## Parameters

| Group | Parameters |
|---|---|
| Layout | one-wall · galley · L · U · G · peninsula, island toggle |
| Room | width, depth, ceiling height, wall thickness, open ends (galley), door wall / position / width |
| Runs | left / right leg length, peninsula length and position, island length / offset, aisle to island, seating overhang, stool spacing |
| Appliances | run and position for sink, cooktop and fridge; sink / cooktop / fridge widths; dishwasher left or right of the sink; window over sink |
| Base cabinets | worktop height and thickness, base depth, plinth, max module width |
| Wall & tall | wall units on/off, bottom height, unit height and depth, tall unit height, number of tall pantry units |
| Finish | fronts, worktop, walls and floor colours, plus presets |

The parameters are stored in the URL, so **Copy link** shares the exact design.

### How runs are filled

- Each straight run puts its appliance groups first (sink + dishwasher, cooktop, fridge + pantries). Their edges snap to a 50 mm grid.
- The gaps are filled with **catalogue widths** (150 to 1000 mm, capped by *max module width*) using as few units as possible. Any remainder becomes a **filler at the wall or corner end**.
- Corners belong to the run that reaches the wall. The unit there is scheduled as a **blind corner** unit.
- Wall units skip tall units, the hood zone and the window over the sink.
- Islands and peninsulas get a seating overhang, a back panel and stools.
- If appliances don't fit, the generator drops the pantries first, then the dishwasher, and reports this in **Checks**.

### Checks (guidelines, not code compliance)

- Work triangle: each leg 1.2–2.7 m and the total 4.0–7.9 m (NKBA rule of thumb).
- Aisles: ≥ 1050 mm recommended, < 900 mm flagged as an error. Covers galley, between U legs, peninsula, island to every run, and behind seating.
- Landing space: ≥ 300 mm beside the cooktop and ≥ 600 mm on one side of the sink.
- Door swing clashing with cabinets.

## Archicad / Tapir

`archicad/build_kitchen.py` does the build. `serve.py` calls it, and you can also run it on its own:

```bash
node tools/export.js params.json model.json
```

```bash
python3 archicad/build_kitchen.py model.json --test
```

```bash
python3 archicad/build_kitchen.py model.json
```

```bash
python3 archicad/build_kitchen.py model.json --dry-run payloads.json
```

In order: generate a model without a browser, place one of each element type, verify it and delete it, build the model, and write the Tapir payloads without connecting.

| Model element | Archicad element | Tapir command |
|---|---|---|
| Room walls | Wall (Basic, centre reference line) | `CreateWalls` |
| Door, window over sink | Door / Window in the host wall | `CreateDoors`, `CreateWindows` |
| Cabinets, plinths, worktops, appliances, hood, stools | Morph box, oriented with x/y/z axes | `CreateMorphs` |
| Layers `KITCHEN - Cabinets / Worktops / Appliances / Furniture / Walls` | Layer attributes | `CreateLayers` + `SetDetailsOfElements` |

- It finds Archicad on ports **19723–19744** and checks the Tapir version and the commands it needs before building.
- **Replace previous build** deletes the GUIDs stored in `archicad/last_build.json` (git-ignored) before building again.
- **Test placement** places one sample per element type (rotated ones where possible). It reads the samples back with `Get3DBoundingBoxes`, reports the deviation in mm and deletes them. Run it once after installing or updating Tapir.
- Units go from millimetres in the app to metres in Archicad. Elements go on the story chosen in the dialog (index 0 by default).
- `serve.py` binds to `127.0.0.1`, accepts API calls only from localhost origins (add more with `--allow-origin`) and runs one build at a time.

The payloads follow Tapir's published command definitions (v1.7.3). Older Tapir versions without the optional wall fields fall back to a coordinates-only `CreateWalls`.

### Limitations

- Cabinets are **morph boxes**, not GDL kitchen objects. That keeps the geometry exact and independent of the library. To use parametric kitchen objects, map `boxes[]` to `CreateObjects` with your library part names.
- Doors and windows use the tool defaults or favourites from your Archicad, sized by the model.
- The live Archicad connection has only been exercised against a mock of the JSON API. Run **Test placement** in your own Archicad before the first full build.

## Files

```
index.html  styles.css  app.js     UI: parameter panel, views, analysis, export, Archicad dialog
generator.js                       parameters → model (runs, boxes, walls, openings, checks, schedule)
plan2d.js                          architect-style 2D plan (Canvas 2D) — also draws the layout thumbnails
viewer3d.js                        Three.js scene with orbit controls and wall cutaway
serve.py                           static server + Archicad bridge (/api/status, /api/build, /api/test)
archicad/build_kitchen.py          Tapir builder (stdlib only)
tools/export.js                    CLI: params JSON → model JSON
tools/check.js                     geometry sanity checks across all layouts
vendor/                            three.js r128 + OrbitControls (MIT)
```

Run `node tools/check.js` after changing the generator. It builds every layout in normal, island and small-room variants. It then checks for non-finite geometry, boxes outside the room, overlapping units, missing appliances and island errors after auto-fit.

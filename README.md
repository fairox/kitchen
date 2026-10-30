# Kitchen Configurator

A parametric kitchen configurator that runs in the browser and builds the result in **Archicad** as native elements through the [Tapir](https://github.com/ENZYME-APD/tapir-archicad-automation) add-on.

It covers the standard layouts from the reference sheets: **one-wall, galley, L-shaped, U-shaped, G-shaped, peninsula and four-wall**, each with an optional **island** where it fits (one-wall, L, U). You can change the parameters live in a 3D view and a dimensioned plan. Each change re-checks the work triangle, aisles, landing space and door swing.

![layouts](https://img.shields.io/badge/layouts-6_%2B_island-e8742c) ![deps](https://img.shields.io/badge/build_step-none-5b5d3f)

## Run it on your computer

Download the latest package zip (or clone the repo), unzip it and double-click:

| Windows | macOS | Linux |
|---|---|---|
| `Start Kitchen Configurator.bat` | `Start Kitchen Configurator.command` (first time: right-click → Open) | `./start.sh` |

The launcher starts the local server and opens your browser. All you need is **Python 3.8+**, with no internet, npm or extra packages. `START-HERE.txt` covers setup, Archicad/Tapir and troubleshooting. To build the zip yourself, run `python3 tools/package.py`. It is written to `dist/`.

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
| Layout | one-wall · galley · L · U · G · peninsula · four-wall, island toggle, prep sink |
| Walls | per wall run: base + wall units, tall to ceiling, or base only; open niche in tall walls |
| Room | width, depth, ceiling height, wall thickness, open ends (galley) |
| Openings | any number of **doors**, **windows** and **thresholds**, each placed by wall, reference corner and exact offset (see below) |
| Runs | left / right leg length, peninsula length and position, island length / offset, aisle to island, seating overhang, stool spacing |
| Appliances | run and position for sink, cooktop and fridge; sink / cooktop / fridge widths; dishwasher left or right of the sink; window over sink |
| Base cabinets | worktop height and thickness, base depth, plinth, max module width, door & drawer fronts on/off |
| Wall & tall | wall units on/off, bottom height, unit height and depth, tall unit height, number of tall pantry units |
| Finish | fronts, worktop, walls and floor colours, plus presets |

The parameters are stored in the URL, so **Copy link** shares the exact design.

### Using every wall: the four-wall layout and wall styles

The **Four-wall** layout puts cabinet runs on all four walls. The legs run the full depth and the front run owns both front corners. Doors and thresholds in any wall cut the runs where needed. The default follows a 4.9 × 6.25 m plan:
- **Back:** sink under the window with a dishwasher.
- **Left:** range and hood, then the fridge with a pantry.
- **Right:** an oven tower.
- **Front:** the entry door and a wide opening.
- **Island:** a prep sink and seating with 1.1 m aisles all round.

Each wall run has a **style** (*Walls* section):
- **Base + wall:** the standard run.
- **Tall to ceiling:** a wall of full-height units, like the photo references. Stretches under a window keep base units and a worktop, and *Open niche* adds a worktop niche with a stone back, open shelves and a bridge unit above.
- **Base only:** no wall units.

Further options:
- **Oven towers:** tall units with a built-in oven at eye level, placed on a chosen wall.
- **Up to the ceiling:** aligns the tops of tall and wall units.
- **Handleless** fronts.
- **Prep sink** on the island. The work triangle uses whichever sink makes it shorter.
- **Finishes:** separate colours and wood grain for base, wall and tall fronts. Presets *Oak & cashmere* and *Mocha & stone* follow the reference photos.

### Activate from Archicad

1. In Archicad, select the kitchen's **Zone** (optional).
2. Run `archicad/launch_configurator.py`: double-click **Open from Archicad** (`.bat` / `.command`), or run it from your Python setup / Tapir's script palette.
3. The script starts the configurator server if it is not already running and reads the selected zone through Tapir. It then opens the browser with that room as the **fixed site**: width, depth and height from the zone, placed at the zone's position and story.
4. The zone's walls already exist, so **Include room walls** starts unticked. Add the doors, windows and thresholds in *Openings*; the checks warn while the room has no entry.
5. **Send to Archicad** builds the kitchen at the zone's position.

The zone's bounding box is used, so draw the zone as an axis-aligned rectangle. Without Archicad or a selected zone, the script just opens the configurator.

### Fixed room: the site comes first

The room is the given condition. That means width, depth, ceiling height, wall thickness, open ends and every door, window and threshold. The first time you edit any of them by hand, the room becomes **fixed** (the Room section shows a green *Room fixed* bar). From then on the kitchen is generated around it:

- **Switching layouts** never touches the room or openings. Leg and peninsula lengths scale to the room the layout was drawn for, and the island is re-fitted.
- **Add island** shrinks the island to fit with clear aisles. If the room is too small, it says why and leaves the island off; it never enlarges the room.
- **Reset** rebuilds the kitchen and keeps the room.
- The **layout thumbnails** show each layout generated in *your* room, with a red badge counting the errors it would have there.
- **All runs avoid openings**, not just those on the opening's wall. Runs on the other walls and peninsulas stop short of door swings and passages ("kept clear of D1"). Appliances that no longer fit on their run move to another run instead of being dropped, and the cooktop keeps worktop beside it where an opening cuts the run.
- With *Window over sink*, the sink is **centred under an existing window** on its wall. In a fixed room no window is ever added.
- The fixed room is saved **in this browser** and restored on the next visit. It is also stored in the link, so *Copy link* shares it. **Release** in the Room bar lets layouts change the room again.

### Openings: doors, windows, thresholds

Each opening is placed precisely, in millimetres:

| Field | Meaning |
|---|---|
| `wall` | `back`, `front`, `left` or `right` |
| `from` | reference corner, named as seen in plan: **left/right** corner for the back and front walls, **front/back** corner for the side walls |
| `offset` | distance from that **interior corner** to the **near edge** of the opening |
| `width`, `height` | clear opening size (for a threshold, `height` is the clear height under the beam) |
| `sill` | window sill height above the floor |
| `hinge`, `swing` | door hinge jamb (same corner names) and `in`/`out` |
| `beamWidth`, `bearing` | threshold beam width (0 = wall thickness) and how far it bears into the wall each side |

- A **threshold** is a floor-to-beam passage with no leaf. The wall stops at both jambs and a beam spans the gap from the ceiling down to the clear height. Its depth is ceiling height minus clear height.
- Switching the reference corner keeps the opening where it is and converts the offset.
- The plan shows a **corner → edge → edge → corner dimension chain** outside every wall with openings, plus a tag with each opening's size. Thresholds show the beam dashed overhead.
- Cabinets respect openings:
  - No base units, worktop or tall units in front of a door or threshold (plus a 50 mm casing).
  - No base units in front of a window whose sill is below the worktop.
  - No tall units in front of any window.
  - No wall units across any opening that reaches their band.
  - Appliances move to the nearest stretch of wall that is free. If the fridge's wall has no free stretch wide enough, the fridge moves to another wall run.
- The automatic **window over the sink** narrows itself to stay clear of tall units and other openings.
- Checks:
  - Errors: overlapping openings, a tall unit in front of a window, and door swings or passages blocked by cabinets (including perpendicular runs).
  - Warnings: piers under 100 mm, clear heights under 2000 mm, and window sills below the worktop.

Example (also accepted in the URL hash and by `tools/export.js`):

```json
{ "layout": "u-shape", "openings": [
  { "type": "door", "wall": "front", "from": "start", "offset": 1550, "width": 900, "height": 2100, "hinge": "end", "swing": "in" },
  { "type": "threshold", "wall": "right", "from": "start", "offset": 200, "width": 1200, "height": 2200, "beamWidth": 250 },
  { "type": "window", "wall": "left", "from": "end", "offset": 1100, "width": 1200, "height": 1200, "sill": 1050 }
] }
```

### How runs are filled

- Each straight run puts its appliance groups first (sink + dishwasher, cooktop, fridge + pantries). Their edges snap to a 50 mm grid.
- The gaps are filled with **catalogue widths** (150 to 1000 mm, capped by *max module width*) using as few units as possible. Any remainder becomes a **filler at the wall or corner end**.
- Corners belong to the run that reaches the wall. The unit there is scheduled as a **blind corner** unit.
- Wall units skip tall units, the hood zone and the window over the sink.
- With **fronts** on, every unit gets real door and drawer fronts (19 mm, 3 mm joints) and handles: drawer + door on base units, a false front over the sink, an oven under the cooktop, an integrated dishwasher panel, two-door pantries and fridge/freezer doors. These are separate boxes, so they go to Archicad too. Fronts are clipped at corners so they never run into the adjoining run.
- A blind corner unit narrower than the corner plus 300 mm is merged with its neighbour (e.g. 600 + 300 → BC900), so it keeps a usable door.
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

Run `python3 archicad/check_tapir.py` first to confirm that Archicad is running, Tapir is active and every command the build uses is available. It changes nothing in the project.

In order: generate a model without a browser, place one of each element type, verify it and delete it, build the model, and write the Tapir payloads without connecting.

| Model element | Archicad element | Tapir command |
|---|---|---|
| Room walls, split at thresholds | Wall (Basic, centre reference line) | `CreateWalls` |
| Doors, windows | Door / Window in the wall segment that contains it, at its exact centre offset | `CreateDoors`, `CreateWindows` |
| Threshold beams | Beam, `TopCenter` anchor at ceiling level, exact width × depth (falls back to a header wall without `CreateBeams`) | `CreateBeams` |
| Cabinets, fronts, handles, plinths, worktops, appliances, tap, hood, stools | Morph box, oriented with x/y/z axes | `CreateMorphs` |
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

Run `node tools/check.js` after changing the generator. It builds every layout in normal, island and small-room variants. It then checks for non-finite geometry, boxes outside the room, overlapping units, fronts or handles colliding with anything, missing appliances and island errors after auto-fit.

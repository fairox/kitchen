# Prompt: Office Configurator (small to large) with Archicad build

> Paste this into Claude Code in an empty repository. It describes the product, the architecture, the rules that keep the Archicad build safe, and the lessons learned building the Kitchen Configurator. Work through the phases in order and do not start a phase before the previous one passes its acceptance checks.

---

## 1. What to build

A web-based, parametric **office layout configurator**. An architect defines a **fixed site** (floor plate, walls, columns, cores, windows, doors), chooses a **program** (headcount, workstation and room types), and gets a **generated, dimensioned, checked office layout** in a live 3D view and a plan. The layout is then built in **Archicad** as native elements by a script running inside Archicad (Tapir add-on).

It must scale:

| Tier | Typical site | Headcount | What it must handle |
|---|---|---|---|
| **S** small office | one room or suite, 20–150 m² | 1–12 | desks along walls, 1–2 meeting rooms or a meeting table, a phone booth, storage, a kitchenette |
| **M** medium office | one floor, 150–1500 m² | 12–120 | neighbourhoods of desk clusters, a meeting room mix, focus rooms, reception, pantry, print/copy, primary/secondary aisles |
| **L** large office | floor plates 1500–5000 m², columns, one or more cores, several floors | 120–600+ per floor | zoning (perimeter vs interior), multiple neighbourhoods, a room "spine" along the core, egress and travel-distance checks, thousands of elements (performance) |

The same generator serves all three tiers. The tier is a **preset** of parameters, never a separate code path.

---

## 2. Non-negotiable architecture

1. **Static web app, no build step.** Plain HTML/CSS/JS. Three.js r128 (UMD) + OrbitControls are **vendored** in `vendor/` (not a CDN), so the app runs offline next to Archicad. Plan view on Canvas 2D.
2. **One pure generator module** (`generator.js`): parameters in, a model out (`rooms[]`, `walls[]`, `openings[]`, `boxes[]`, `zones[]`, `checks[]`, `stats`, `schedule`). No DOM. UMD-wrapped so it runs in the browser **and** in Node (`tools/export.js`, `tools/check.js`). The 3D view, plan, exports and Archicad build all consume this one model: what you see is what gets built.
3. **Deterministic.** Any randomness (furniture variety, plant placement) is hash-based per element key, so changing one parameter never reshuffles the rest.
4. **Units:** millimetres in the app and the model; metres and degrees in the build file and in Archicad. Say so in every file that converts.
5. **State in the URL hash** (base64 JSON, a *diff against DEFAULTS*), so "Copy link" shares the exact design. Gotcha we hit: when restoring from a hash, apply it on top of `DEFAULTS` **only**, never on top of a preset's defaults, or values equal to DEFAULTS silently take the preset's value.
6. **Local server `serve.py`** (stdlib only): serves the app; optional bridge endpoints. It binds `127.0.0.1`, accepts localhost origins only, runs one build at a time, falls back to the next free port, has `--open`, and **forces MIME types** (`.js` → `text/javascript`). Windows sometimes serves `.js` as `text/plain` from the registry and the page stays blank.
7. **The browser never talks to Archicad directly.** The web app downloads a **build file**; an Archicad-side script builds it (Section 9).

---

## 3. The fixed site comes first

The site is the given. The office is generated **around** it.

- **Site parameters (`SITE_KEYS`):** floor plate outline, wall thickness, floor-to-ceiling height, structural column grid (spacing X/Y, column size, offset), cores (rectangles: stairs, lifts, toilets, risers), facade windows (or glazing ratio per facade), doors, thresholds (openings with an overhead beam), entry points, origin and story in Archicad.
- **Floor plate:**
  - **Phase 1:** a rectangle.
  - **Phase 3:** a rectilinear polygon (L, U, T, courtyard). Every algorithm must work on polygons from the start: write it against "a list of edges", never "four walls".
- **Fixed once edited:**
  - **Fixing:** the first manual edit of any site value fixes the site. A green bar ("Site fixed · 42.0 × 24.0 m · 6 columns · 1 core · 9 openings · Release") shows it.
  - **What may not change it:** switching presets or layouts, adding rooms, Reset and the "fit" helpers never change a fixed site. They fit inside it, or refuse **with the reason** (e.g. "the floor is 24 m deep; a 3-row neighbourhood with two aisles needs 26.4 m").
  - **Persistence:** the site is saved in `localStorage` and in the link.
- **Precise openings:**
  - **Placement:** each opening is placed by wall (polygon edge), reference corner (named as seen in plan) and an exact mm offset to its near edge.
  - **Sizes:** width, height, sill (windows), hinge/swing (doors), beam width/bearing (thresholds).
  - **Plan:** dimension chains corner → edge → edge → corner on every wall with openings.
  - **Changing the reference corner** keeps the opening in place and converts the offset.
- **Import from Archicad:** "From selected Zone" reads the selected Zone (start with its bounding box; later `GetZoneBoundaries` for the polygon) and its story. It opens the app with that site fixed and placed at the zone's position. The room walls then already exist, so "build room walls" starts **off**.
- **Generated around the site:**
  - **Columns** are obstacles: no desk, chair zone or partition may hit them. Prefer aligning partitions to the column grid.
  - **Cores** are obstacles with their own clearance band. Toilets and risers are usually in the core and not generated.
  - **Doors** keep a swing zone and an approach zone clear, on **every** run and room, not just the wall they are in. We learned this the hard way: a door on a side wall swung into the end of a run on another wall.
  - **Windows:** tall elements (storage walls, booths, tall partitions) keep out of the window band, including at corners. Use the cabinet/element depth for that check, not a fixed 700 mm, which gave false alarms at corners.

---

## 4. Program and parameters

- **Headcount and sharing:** headcount, desk-sharing ratio (e.g. 0.8 desks per person), growth reserve %.
- **Workstations:**
  - type: bench, single desk, L-desk, sit-stand, hot-desk;
  - desk size (1400×700, 1600×800, 1800×800);
  - pitch;
  - cluster size (2/4/6/8, back-to-back or side-by-side);
  - screens between desks;
  - pedestals / lockers per person.
- **Rooms:** a target count per type, or "per N people":
  - private office (single, double);
  - meeting rooms (2, 4–6, 8–10, 12–14, 20 seats; boardroom);
  - focus room; phone booth (1-person, 2-person);
  - quiet / library zone; wellness / mothers' room;
  - reception with waiting; pantry / kitchenette (a mini version of the kitchen generator);
  - print/copy; storage / file room; lockers; IT/server room; coat area.
- **Ratios:** meeting seats per person (e.g. 1 : 5), phone booths per person (e.g. 1 : 12), focus rooms per person.
- **Enclosure:** for each room, solid partition or glazed front, or open (booth / soft seating). The door position on the room's corridor side.
- **Circulation:**
  - primary aisle 1600–1800 mm;
  - secondary aisle 1000–1200 mm;
  - chair zone 1000 mm behind a desk edge (900 hard minimum);
  - clear turning circles 1500 mm at room entries (accessibility).
- **Daylight:** max distance from desk to facade (e.g. 7.5 m) or to glazing; desks prefer the perimeter, rooms prefer the interior / core side.
- **Finishes** (viewer and Archicad surfaces): desk top, desk frame, partitions, glass tint, carpet zones, accent per neighbourhood. Presets from reference images.
- **Tier presets S / M / L:** they set the program and densities only; the site stays as it is.

---

## 5. The generator: how to lay out an office

Think in **zones, then rooms, then furniture**:

1. **Usable area.**
   1. Floor plate minus wall thickness, cores plus their clearance band, columns plus a small buffer, and door swing/approach zones.
   2. Then reserve the **primary circulation**:
      - a loop or spine linking every entry, core door and fire exit;
      - drawn on the column grid where possible;
      - with a parameter for its width.
2. **Zoning.**
   - Split usable area into a **perimeter band** (within the daylight depth of glazed facades) and an **interior band** (deep space, core side).
   - Desks go to the perimeter first. Enclosed rooms go interior / along the core first, and to blind facades.
   - Reception goes at the main entry. The pantry goes near the core / riser (water).
3. **Rooms.**
   - Pack room types as rectangles **along a "spine"** (core edge or a chosen wall) using a 1D strip packer, the same idea as the kitchen's cabinet runs:
     - each room has a width and a depth;
     - doors face the corridor;
     - the strip is cut by columns, doors and cores;
     - widths snap to a planning grid (e.g. 600 or the partition module).
   - Pinned rooms (like the kitchen's pinned sink: the user puts the boardroom at an exact mm position) are placed **first and exactly**. Everything else packs around them; if impossible, a room moves the minimum distance and the checks say by how much.
4. **Desk neighbourhoods.**
   - Fill the remaining perimeter zones with clusters on a regular grid aligned to the facade: rows of clusters separated by secondary aisles.
   - Skip any cluster that would hit a column, window band rule or clearance. Do not shift the whole grid; drop or shorten one cluster and report it.
5. **Furniture and details.**
   - **Desks:** top, legs/frame, screen, pedestal and chair as separate boxes (like kitchen fronts and handles), so colours and IDs work per part.
   - **Meeting rooms:** table and chairs sized to capacity, a screen on the short wall.
   - **Booths, soft seating, storage walls, lockers, plants:** follow the same pattern.
6. **Element model.** Everything solid is an **oriented box** `{id, kind, cat, cx, cy, z, L, D, H, ux, uy, nx, ny, group, finish, label}`. Partitions are wall segments with openings, and rooms become zones.

**Packing rules learned the hard way (implement them from day 1):**
- Free space per strip is an **interval set**, not a "remaining length" number. Pinned items cut their exact span; claims cut real intervals.
- When an item is placed alone and splits a stretch, **re-home** everything already assigned to that stretch. A sink once vanished without a note because of this.
- Elements that need a window-free wall (tall units, hoods; for offices tall storage walls and booths) aim at window-free zones but are **packed with the rest**, so they don't fragment the strip. Only truly fixed things are placed alone, and they slide flush to a stretch end when the leftover would be unusable (< one module).
- Report what an element **really** ended up as, not what was aimed for. The kitchen readout once said "sink under W2" for a sink that had been pushed off the window.
- Shed optional parts in a fixed order before moving required ones. For example: second pedestal → screen → desk count. The kitchen's order was pantries → dishwasher → corner zone → drop.

---

## 6. Checks (guidelines, not code compliance)

Show checks as ✓ / ⚠ / ✕ with the measured value:
- **Aisles:** primary and secondary aisle widths; chair zones; turning circles at entries.
- **Daylight:** desk-to-facade distance, % of desks within the daylight band.
- **Egress:** travel distance from every desk and room door to the nearest exit (straight-line first; walk the aisle graph in Phase 3), and the dead-end corridor length.
- **Clearances:** door swings clear on every side, nothing in front of a door or threshold, tall elements not across windows, nothing on columns.
- **Program:** desks provided vs required (with the sharing ratio), meeting seats per person, booths per person; NIA (m²) and density (m² per person, m² per desk).
- **Site problems:** for example a fixed site that has no entry.

Phrase every message as a fact about the room ("Aisle between N2 and N3 is 980 mm (≥ 1100 recommended)").

---

## 7. UI

Follow the kitchen app's layout: a left parameter panel, the stage (Split / 3D / Plan) and a right analysis panel.
- **Preset picker:** S / M / L plus layout strategies (perimeter desks + interior rooms, room spine, cellular). Each thumbnail is the strategy **generated in your fixed site**, with a red badge counting the errors it would have there.
- **Site panel:** dimensions, column grid, cores, openings editor (+ Door / + Window / + Threshold, exact mm inputs, corner-to-edge readout), site-fixed bar.
- **Program panel:** headcount, ratios, workstation type, room mix table (count, size, enclosure, pin position).
- **Analysis panel:** checks, area schedule (NIA, per zone), furniture schedule (code, description, size, qty) with a CSV export, and a room list with names and numbers.
- **Plan:** architectural style:
  - dark walls, columns, cores hatched;
  - room names and areas, door swings, desk clusters;
  - dimension chains and corridor widths;
  - hover tooltips, click to highlight.
- **3D view:**
  - **Colours:** convert colours with `convertSRGBToLinear()` and use ACES tone mapping. Without the conversion everything washes out to white.
  - **Detail:** edge outlines, a cutaway of walls facing the camera, a carpet/floor texture.
  - **Framing:** fit the camera to the bounding sphere using the narrower of the two field-of-view angles (vertical or horizontal), and re-fit on resize until the user orbits.
  - **Performance:** for L tier (thousands of desks and chairs) use `InstancedMesh` per kind and colour.
- **Exports:** model JSON, parameters JSON, schedules CSV, plan PNG, 3D PNG, **Archicad build file**.

---

## 8. Archicad mapping

| Model | Archicad | Tapir command |
|---|---|---|
| Room partitions, perimeter walls | Wall (Basic, centre reference line, exact thickness and height), split at thresholds | `CreateWalls` |
| Doors, windows | Door / Window in the wall segment that contains it, at its exact centre offset | `CreateDoors`, `CreateWindows` |
| Thresholds | the gap between wall segments + Beam with the `TopCenter` anchor hung from the ceiling | `CreateBeams` |
| Rooms | **Zones** with name, number and category (meeting, focus, open office, support…) | `CreateZones` |
| Desks, tables, storage, booths, chairs | Morph boxes (or, later, library Objects from a user-chosen library: `CreateObjects`) | `CreateMorphs` |
| Colours | Surface attributes, one per configurator colour, named `OFFICE <material> #rrggbb` (the colour in the name, so builds in other finishes never recolour each other) | `CreateSurfaces`, then `surfaceId` on each morph |
| Organisation | layers `OFFICE - Walls / Rooms / Workstations / Meeting / Storage / Furniture` | `CreateLayers`, `SetDetailsOfElements` |
| Identity | every element gets a unique Element ID `OF-<run>-<key>` | `SetDetailsOfElements` (`details.id`) |

**Measured on Archicad 29 / Tapir 1.7.0: do this, don't rediscover it.**
- **Rotated morph axes.** A morph given rotated `xAxis/yAxis` comes out turned the **opposite** way: the axes act as rows of the placement matrix, not columns.
  - Send every box that is square to the project axes as its plain extent with identity axes.
  - For other angles, first place a 30° probe morph, read its bounding box back, decide "columns" or "rows", delete it, and refuse if neither fits.
  - The first real build had 102/263 elements mirrored (off by exactly each box's length) until this was handled.
- **Morph and beam heights.** Morph `basePoint.z` is absolute (story level + height). Wall `zCoordinate` is relative to the story when `floorIndex` is given. A beam hung from the ceiling may be assigned to the story above, so don't check its story.
- **Openings.** A door or window needs its host wall segment's GUID and the centre offset **from that segment's start**.
- **Command definitions.** Read Tapir's published command definitions for the **installed** version (`GetAddOnVersion`); don't trust memory.

---

## 9. The Archicad side: build file + window (Parkform-style)

The web app downloads `<name>.office-build.json`, format `office-configurator-build`, version 1: `{format, version, created, name, mode, walls, placement: {origin [m], rotationDeg, story}, model}`. Validate it **strictly** on the Archicad side: a whitelist copy with number ranges, known kinds, layer prefix, size limits.

**`archicad/OfficeBuild.py`:** a single file for Tapir's script palette, started as `uv run --script OfficeBuild.py --port N` with no console.
- **Packaging:** a PEP 723 header, standard library only, `parse_known_args` (the palette also passes `--host` and `--token`; ignore the token and never print it). Talks only to `127.0.0.1:19723–19744`.
- **Source:** generated by `tools/bundle_tapir_script.py` from `archicad/build_office.py` (library + CLI) and `archicad/office_gui.py` (window). Packaging fails when the bundle is out of date. Bundle trick: `B = sys.modules[__name__]` after the library part.
- **Window** (Tkinter/ttk, layout like Tapir's ScriptWindow): header with description; then:
  - **Project:** a picker of all running Archicads ("Name · Archicad 29 · port 19724") with Refresh. **Never guess** when several are open.
  - **Build file:** the newest one in Downloads is picked up automatically, including one downloaded while the window is open; a file opened by hand stays loaded. It shows design, site, element counts and the design's open checks.
  - **Table:** element type · count · Archicad layer(s).
  - **Placement:** story, origin X/Y/Z (m), rotation, "build site walls" checkbox, **From selected Zone**.
  - **Mode:** *Replace previous build …* (only when one exists) / *Append* / *Remove run … only* for older runs.
  - **Footer:** status line (colour by severity), *Keep on top*, *Open web app* (starts the local server; passes the selected Zone as the fixed site), *Open build file…*, *Test placement*, *Build in Archicad* (asks for confirmation).
- **Safety rules:**
  - **Project identity:** a token stored in the source field of an app-owned "Office Configurator" classification system (created on first build), plus the project path. Never write the user's project info fields.
  - **Journal:** every run in `Documents/Office Configurator/journal/<run>.json`, saved after each batch. A crash leaves a recoverable GUID list. CLI: `--status`, `--builds`, `--remove RUN_ID`.
  - **Verification:** every element is read back with `GetDetailsOfElements` (type, Element ID, story, layer) and `Get3DBoundingBoxes` (tolerances XY 5 mm, Z 12 mm). Record the as-built bounding box and layer.
  - **Replace:** runs only **after** the new build is verified, in the same identified project. It deletes only the previous run's elements that are still exactly as built (same type, same layer, geometry within 2 mm). Anything edited is kept and reported. "Built with problems" runs can be replaced too; that's how a faulty build is cleaned up. Nothing is ever deleted by type or layer query.
  - **Writing gate:** allow writing only with a Tapir version you have **tested**. Show other versions as status only, or require a passing Test placement first.
  - **Test placement:** one sample per kind, preferring rotated ones, plus one wall. Verify and delete.
- **Console encoding:** `stream.reconfigure(errors="replace")` on stdout/stderr. Windows consoles crash on characters like "—", "×" and "→".

---

## 10. Testing (this is what made the kitchen reliable)

1. **`tools/check.js`** runs the generator over every preset × tier × strategy, plus stress cases. It checks:
   - finite geometry; nothing outside the floor plate;
   - no overlaps between desks / rooms / partitions / columns;
   - nothing in a door swing, threshold or core clearance; nothing tall across a window band;
   - programme met or reported;
   - fixed site unchanged across every strategy; pinned rooms exactly where asked (or reported as moved);
   - the "really ended up" readouts match the geometry.

   Add a regression case for every bug you fix.
2. **Browser checks with Playwright** (Chromium is preinstalled; use `--use-gl=swiftshader`): no page errors; screenshot every preset (Split / 3D / Plan); drive the panels like a user (type exact mm, switch reference corners, add/remove openings, fix/release the site, reload and confirm restore).
3. **A mock Archicad** (`http.server` on 19723/19724) implementing:
   - `API.IsAlive`, `GetProductInfo`, `IsAddOnCommandAvailable`, `ExecuteAddOnCommand`;
   - an element store with type / story / layer / ID / surface / bounding box;
   - classification systems, surfaces, selection and zones, `DeleteElements` results.

   Make it **behave like the real Archicad**, including the rows-convention for morph axes, and replay real failures against it before fixing them. Test the safety flow:
   - the first Replace falls back to Append;
   - the second Replace deletes exactly the previous run;
   - a "user-edited" element is kept;
   - remove-run works;
   - two instances means a refusal to guess;
   - rotated builds verify;
   - leftovers from a faulty run can be removed.
4. **The window under Xvfb** (`xvfb-run`, a Python with tkinter, `import -window root` for screenshots): load a downloaded build file, build, replace, From selected Zone, Test placement.
5. **Never claim the real Archicad works** until the user has run Test placement on their machine. Say what was verified against the mock and what wasn't.

---

## 11. Packaging and launchers

- `Start Office Configurator.bat` (Windows, CRLF, tries `py -3` then `python`), `.command` (macOS, exec bit), `start.sh` (Linux). Each finds Python 3.8+, starts `serve.py --open`, and explains how to install Python if it is missing (including the Microsoft Store alias trap).
- `Build in Archicad.bat` / `.command` open `OfficeBuild.py` (`pyw` on Windows so no console stays open).
- `START-HERE.txt`: install, start, build in Archicad, troubleshooting.
- `tools/package.py` writes `dist/office-configurator-<date>-<commit>.zip` from the tracked files: CRLF for `.bat`, exec bits for launchers and scripts, and a refusal if the Tapir bundle is stale.
- `.gitattributes` for line endings. `.gitignore`: `dist/`, journals, logs, `__pycache__`.

---

## 12. Phases and acceptance

| Phase | Scope | Done when |
|---|---|---|
| 1 | S tier: rectangular room, fixed site, openings editor, desks along walls + meeting table + booth, 3D + plan + checks, URL/localStorage state | check.js green across presets; Playwright flow with no errors; plan dimension chains correct |
| 2 | Build file + `OfficeBuild.py` window + mock Archicad: walls, doors, windows, zones, morphs, layers, surfaces, element IDs, journal, verify, Replace/Remove | the mock flow passes every safety case; Xvfb window screenshots; the user's first real Test placement passes |
| 3 | M tier: rectilinear polygons, columns, one core, room spine packer, neighbourhoods, aisles graph, travel distance, pinned rooms | stress cases (columns in aisles, door in the spine, corner windows) produce no errors and honest reports |
| 4 | L tier: multiple cores, zoning, instanced rendering (≥ 5000 elements at 60 fps on a laptop), batch building (200 per call, journal per batch), import of zone polygons from Archicad | a 600-person floor generates in < 1 s, renders smoothly, builds and verifies against the mock |
| 5 | Optional: library Objects instead of morphs (user picks the library part per kind), multiple floors, IFC-friendly classification | per-kind object mapping, verified by read-back |

At the end of every phase:
- **Commit and push.**
- **Rebuild the package**, and send the zip and screenshots.
- **Say plainly** what was tested against the real Archicad and what only against the mock.

---

## 13. Working style

- **Ask only** when a decision is genuinely the user's (e.g. which desk standard or which jurisdiction's egress rules). Otherwise choose a sensible default and say so.
- **Treat a user's screenshot of a failure as data.** Find the pattern in the numbers. "Off by 600 / 597 mm, only on the side runs" pointed straight at the axis convention.
- **Reproduce the failure in the mock before fixing it**, then add the regression test.
- **Never drop an element silently.** Every shed, move, clamp or refusal produces a check message with the measured amount.
- **Keep the site sacred:** nothing the user fixed may change as a side effect.

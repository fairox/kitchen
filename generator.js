/*
 * Kitchen generator — parameters in, element list out.
 *
 * Pure module: no DOM, no Three.js. The web app, the Node CLI (tools/export.js)
 * and the Archicad builder (archicad/build_kitchen.py, via the JSON it produces)
 * all consume the same model, so what you see is what gets built.
 *
 * Coordinates are millimetres in plan: x to the right, y "up" (north), z up.
 * The room interior spans [0, roomW] x [0, roomD]. The "back" wall is y = roomD,
 * the "front" wall is y = 0.
 *
 * A *run* is a straight line of cabinets. It has an origin on its back line
 * (wall side), a unit direction u along the run and a unit normal n pointing
 * from the back line towards the working aisle. Every box is placed in run
 * coordinates (s along u, t along n) and converted to a world-space oriented box.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KitchenGenerator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    layout: 'l-shape',
    island: false,

    // Room
    roomW: 4200, roomD: 3600, wallH: 2700, wallT: 150, openEnds: true,
    // Openings, placed precisely: `from` names the reference corner of the wall
    // ('start' = left end of back/front walls, front end of left/right walls, as
    // seen in plan) and `offset` is the distance from that interior corner to
    // the near edge of the opening, in mm.
    openings: [{ type: 'door', wall: 'front', from: 'end', offset: 390, width: 900, height: 2100, hinge: 'end', swing: 'in' }],

    // Base cabinets & worktop
    counterH: 900, counterT: 30, baseDepth: 600, plinthH: 100, nosing: 20, moduleMax: 600,

    // Wall & tall cabinets
    fronts: true, handles: 'bar', // 'bar' | 'none' (handleless, push-to-open)
    wallCabs: true, wallCabH: 720, wallCabDepth: 350, wallCabElev: 1450,
    tallH: 2200, pantryCount: 0, alignTops: false, // alignTops: tall and wall units run to the ceiling
    ovenTowers: 0, ovenRun: 'right', ovenPos: 0.5, tallNiche: 0, // tallNiche: open worktop niche (mm) in a tall wall
    // what stands against each wall run: 'standard' (base + wall units), 'tall' (floor-to-ceiling units), 'base' (no wall units)
    styleBack: 'standard', styleLeft: 'standard', styleRight: 'standard', styleFront: 'standard',
    prepSink: false, // second, small sink on the island

    // Run geometry
    legLeft: 2700, legRight: 2100, pensLen: 1800, pensPos: 0.72, overhang: 300,
    islandLen: 2000, islandOffset: 0, aisle: 1100, stoolSpacing: 600,

    // Appliances (run id + position 0..1 along the usable run length)
    sinkRun: 'back', sinkPos: 0.75, sinkW: 900, dwSide: 'right',
    // sinkMode: 'auto' (run + position), 'window' (centred under sinkWindow, shifted by sinkShift mm),
    // 'exact' (centre at sinkOffset mm from the sinkFrom corner of the sink run's wall; island/peninsula: from the run start)
    sinkMode: 'auto', sinkWindow: '', sinkShift: 0, sinkFrom: 'start', sinkOffset: 1500,
    cookRun: 'back', cookPos: 0.1, cookW: 600,
    fridgeRun: 'left', fridgePos: 1, fridgeW: 700,
    windowOverSink: true, windowW: 1200, windowH: 1100,

    // Finish (used by the viewer only)
    frontColor: '#e8e2d6', counterColor: '#3d3b38', wallColor: '#f4f2ee', floorColor: '#d9cfc0',
    wallFrontColor: '#e8e2d6', tallFrontColor: '#e8e2d6', woodBase: false, woodWall: false, woodTall: false,
    // where the room sits in the Archicad project (mm) and whether the bridge builds its walls
    originX: 0, originY: 0, acFloor: 0, acWalls: true, siteSource: '',
  };

  const RUN_LABELS = {
    back: 'Back wall', left: 'Left wall', right: 'Right wall', front: 'Front wall',
    peninsula: 'Peninsula', island: 'Island',
  };

  // Runs available per layout, plus the appliance placement a layout starts with.
  const LAYOUTS = {
    'one-wall': {
      label: 'One-wall', island: true, runs: ['back'],
      defaults: { sinkRun: 'back', sinkPos: 0.5, cookRun: 'back', cookPos: 0.85, fridgeRun: 'back', fridgePos: 0.02, roomW: 4200, roomD: 3000, openings: [{ type: 'door', wall: 'front', from: 'start', offset: 1650, width: 900, height: 2100, hinge: 'start', swing: 'in' }] },
    },
    galley: {
      label: 'Galley', island: false, runs: ['back', 'front'],
      defaults: { sinkRun: 'back', sinkPos: 0.5, cookRun: 'front', cookPos: 0.5, fridgeRun: 'back', fridgePos: 0.02, roomW: 4200, roomD: 2400, openEnds: true, openings: [{ type: 'door', wall: 'left', from: 'start', offset: 750, width: 900, height: 2100, hinge: 'start', swing: 'in' }] },
    },
    'l-shape': {
      label: 'L-shaped', island: true, runs: ['back', 'left'],
      defaults: { sinkRun: 'back', sinkPos: 0.75, cookRun: 'back', cookPos: 0.1, fridgeRun: 'left', fridgePos: 1, roomW: 4200, roomD: 3600, legLeft: 2700, openings: [{ type: 'door', wall: 'front', from: 'end', offset: 390, width: 900, height: 2100, hinge: 'end', swing: 'in' }] },
    },
    'u-shape': {
      label: 'U-shaped', island: true, runs: ['back', 'left', 'right'],
      defaults: { sinkRun: 'back', sinkPos: 0.5, cookRun: 'left', cookPos: 0.5, fridgeRun: 'right', fridgePos: 0.6, roomW: 4000, roomD: 3600, legLeft: 2700, legRight: 2400, openings: [{ type: 'door', wall: 'front', from: 'start', offset: 1550, width: 900, height: 2100, hinge: 'start', swing: 'in' }] },
    },
    'g-shape': {
      label: 'G-shaped', island: false, runs: ['back', 'left', 'right', 'peninsula'],
      defaults: { sinkRun: 'back', sinkPos: 0.5, cookRun: 'left', cookPos: 0.35, fridgeRun: 'right', fridgePos: 0.4, roomW: 4000, roomD: 4200, legLeft: 2900, legRight: 1500, pensLen: 2000, openings: [{ type: 'door', wall: 'right', from: 'start', offset: 600, width: 900, height: 2100, hinge: 'start', swing: 'in' }] },
    },
    peninsula: {
      label: 'Peninsula', island: false, runs: ['back', 'left', 'peninsula'],
      defaults: { sinkRun: 'peninsula', sinkPos: 0.55, cookRun: 'back', cookPos: 0.5, fridgeRun: 'left', fridgePos: 0.95, roomW: 4800, roomD: 3600, legLeft: 2400, pensLen: 1800, pensPos: 0.72, openings: [{ type: 'door', wall: 'front', from: 'end', offset: 200, width: 900, height: 2100, hinge: 'end', swing: 'in' }] },
    },
  };

  const OPENING_DEFAULTS = {
    door: { width: 900, height: 2100, sill: 0, hinge: 'start', swing: 'in' },
    window: { width: 1200, height: 1200, sill: 1050 },
    threshold: { width: 1200, height: 2200, sill: 0, beamWidth: 0, bearing: 200 }, // beamWidth 0 = wall thickness
  };
  const WALLS = ['back', 'front', 'left', 'right'];

  LAYOUTS['four-wall'] = {
    label: 'Four-wall', island: true, runs: ['back', 'left', 'right', 'front'],
    // after a 4.9 x 6.25 m plan: sink under the back window, range on the left, fridge by the entry,
    // oven tower on the right, the entry door and a wide opening in the front wall, island with seating
    defaults: {
      sinkRun: 'back', sinkPos: 0.45, cookRun: 'left', cookPos: 0.15, fridgeRun: 'left', fridgePos: 0.55, pantryCount: 1,
      ovenTowers: 1, ovenRun: 'right', ovenPos: 0.25, roomW: 4880, roomD: 6250,
      island: true, prepSink: true, islandLen: 1450, islandOffset: 0, overhang: 450,
      openings: [
        { type: 'door', wall: 'front', from: 'start', offset: 1220, width: 915, height: 2100, hinge: 'start', swing: 'in' },
        { type: 'threshold', wall: 'front', from: 'end', offset: 300, width: 1220, height: 2200, beamWidth: 0 },
        { type: 'window', wall: 'back', from: 'start', offset: 1900, width: 1100, height: 1200, sill: 1050 },
      ],
    },
  };

  const CAT = { WALL: 'Walls', CAB: 'Cabinets', TOP: 'Worktops', APP: 'Appliances', FURN: 'Furniture' };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const r1 = (v) => Math.round(v * 10) / 10;

  function normalise(input) {
    const p = Object.assign({}, DEFAULTS, input || {});
    if (!LAYOUTS[p.layout]) p.layout = DEFAULTS.layout;
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[k] === 'number') {
        const v = Number(p[k]);
        p[k] = Number.isFinite(v) ? v : DEFAULTS[k];
      } else if (typeof DEFAULTS[k] === 'boolean') {
        p[k] = p[k] === true || p[k] === 'true' || p[k] === 1 || p[k] === '1';
      }
    }
    p.roomW = clamp(p.roomW, 1800, 12000);
    p.roomD = clamp(p.roomD, 1500, 12000);
    p.wallH = clamp(p.wallH, 2200, 5000);
    p.baseDepth = clamp(p.baseDepth, 300, 900);
    p.counterH = clamp(p.counterH, 700, 1100);
    p.plinthH = clamp(p.plinthH, 0, 250);
    p.counterT = clamp(p.counterT, 10, 100);
    p.moduleMax = clamp(p.moduleMax, 300, 1200);
    p.wallCabDepth = clamp(p.wallCabDepth, 200, p.baseDepth);
    p.wallCabElev = clamp(p.wallCabElev, p.counterH + 300, p.wallH - 300);
    p.wallCabH = clamp(p.wallCabH, 200, p.wallH - p.wallCabElev);
    p.tallH = clamp(p.tallH, p.counterH + 300, p.wallH);
    p.pantryCount = Math.round(clamp(p.pantryCount, 0, 4));
    p.overhang = clamp(p.overhang, 0, 600);
    for (const k of ['sinkPos', 'cookPos', 'fridgePos', 'pensPos']) p[k] = clamp(p[k], 0, 1);
    p.openings = normaliseOpenings(input || {}, p);
    p.island = p.island && LAYOUTS[p.layout].island;
    p.ovenTowers = Math.round(clamp(p.ovenTowers, 0, 3));
    p.ovenPos = clamp(p.ovenPos, 0, 1);
    p.tallNiche = clamp(p.tallNiche, 0, 3000);
    for (const k of ['styleBack', 'styleLeft', 'styleRight', 'styleFront']) if (!['standard', 'tall', 'base'].includes(p[k])) p[k] = 'standard';
    if (p.handles !== 'none') p.handles = 'bar';
    if (!['auto', 'window', 'exact'].includes(p.sinkMode)) p.sinkMode = 'auto';
    if (p.sinkFrom !== 'end') p.sinkFrom = 'start';
    p.sinkWindow = typeof p.sinkWindow === 'string' ? p.sinkWindow : '';
    if (p.alignTops) { // tall and wall units finish at the ceiling, tops in one line
      p.tallH = p.wallH;
      p.wallCabH = p.wallH - p.wallCabElev;
    }
    return p;
  }

  // ---------------------------------------------------------------- openings

  function normaliseOpenings(input, p) {
    let list = input.openings;
    if (!Array.isArray(list) && input.doorWall) { // links made before openings existed
      const len = input.doorWall === 'back' || input.doorWall === 'front' ? p.roomW : p.roomD;
      const w = Number(input.doorW) || 900;
      list = input.doorWall === 'none' ? [] : [{ type: 'door', wall: input.doorWall, from: 'start', offset: Math.round((Number(input.doorPos) || 0.5) * len - w / 2), width: w }];
    }
    if (!Array.isArray(list)) list = DEFAULTS.openings;
    return list.filter((o) => o && OPENING_DEFAULTS[o.type]).map((o, i) => {
      const d = OPENING_DEFAULTS[o.type];
      const q = Object.assign({}, d, o);
      for (const k of ['offset', 'width', 'height', 'sill', 'beamWidth', 'bearing']) {
        const v = Number(q[k]);
        q[k] = Number.isFinite(v) ? Math.round(v) : (d[k] || 0);
      }
      q.wall = WALLS.includes(q.wall) ? q.wall : 'front';
      q.from = q.from === 'end' ? 'end' : 'start';
      q.hinge = q.hinge === 'end' ? 'end' : 'start';
      q.swing = q.swing === 'out' ? 'out' : 'in';
      q.id = typeof o.id === 'string' && o.id ? o.id : `${{ door: 'D', window: 'W', threshold: 'T' }[q.type]}${i + 1}`;
      return q;
    });
  }

  // Resolve one opening against the room: its span [a0, a1] along the wall's
  // interior face (x for back/front, y for left/right), clamped to fit.
  function placeOpening(q, p, notes) {
    const len = q.wall === 'back' || q.wall === 'front' ? p.roomW : p.roomD;
    const label = `${q.id} (${q.type} on ${q.wall} wall)`;
    const width = clamp(q.width, 300, len);
    if (width !== q.width) notes.push(`${label}: width clamped to ${width} mm.`);
    const maxOff = len - width;
    const off = clamp(q.offset, 0, maxOff);
    if (off !== q.offset) notes.push(`${label}: offset clamped to ${off} mm to stay within the wall.`);
    const a0 = q.from === 'start' ? off : len - off - width;
    let h = q.height, sill = q.type === 'window' ? clamp(q.sill, 0, p.wallH - 300) : 0;
    const maxH = q.type === 'threshold' ? p.wallH - 100 : p.wallH - sill - 50;
    h = clamp(h, 300, maxH);
    if (h !== q.height) notes.push(`${label}: height clamped to ${h} mm.`);
    const out = {
      id: q.id, kind: q.type, wall: q.wall, a0, a1: a0 + width,
      offset: r1(a0 + width / 2 + p.wallT / 2), // centre, measured from the wall's start point (outer corner)
      w: width, h, sill, from: q.from, fromStart: a0, fromEnd: len - a0 - width,
    };
    if (q.type === 'door') Object.assign(out, { hinge: q.hinge, swing: q.swing });
    if (q.type === 'threshold') Object.assign(out, { beamW: q.beamWidth > 0 ? q.beamWidth : p.wallT, beamD: p.wallH - h, bearing: clamp(q.bearing, 0, 600) });
    return out;
  }

  // interior face point of a wall at coordinate a
  function wallPoint(wall, a, p) {
    return wall === 'back' ? [a, p.roomD] : wall === 'front' ? [a, 0] : wall === 'left' ? [0, a] : [p.roomW, a];
  }

  // Floor area that must stay clear in front of an opening, [x0, y0, x1, y1]:
  // the full swing of an inward door, otherwise a 600 mm approach.
  function clearZone(o, p) {
    const depth = o.kind === 'door' && o.swing === 'in' ? o.w : 600;
    const W = p.roomW, D = p.roomD;
    if (o.wall === 'back') return [o.a0, D - depth, o.a1, D];
    if (o.wall === 'front') return [o.a0, 0, o.a1, depth];
    if (o.wall === 'left') return [0, o.a0, depth, o.a1];
    return [W - depth, o.a0, W, o.a1];
  }

  // ---------------------------------------------------------------- runs

  function makeRun(id, ox, oy, ux, uy, nx, ny, length, opts) {
    return Object.assign({
      id, label: RUN_LABELS[id], ox, oy, ux, uy, nx, ny, length: Math.max(0, length),
      freestanding: false, startCorner: 0, endCorner: 0,
      counterStart: 0, counterEnd: 0, wallCabStart: 0, wallCabEnd: 0, wall: null,
    }, opts || {});
  }

  function buildRuns(p, notes) {
    const W = p.roomW, D = p.roomD, bd = p.baseDepth, wcd = p.wallCabDepth;
    const has = new Set(LAYOUTS[p.layout].runs);
    const runs = {};
    const cornerAttached = { counterStart: p.nosing, wallCabStart: -(bd - wcd), startCorner: 0 };

    const four = p.layout === 'four-wall';
    const maxLeg = D - (has.has('front') ? bd : 0);
    const legL = clamp(p.legLeft, 2 * bd, maxLeg);
    const legR = clamp(p.legRight, 2 * bd, maxLeg);
    if (has.has('left') && legL !== p.legLeft) notes.push(`Left leg clamped to ${legL} mm to fit the room.`);
    if (has.has('right') && legR !== p.legRight) notes.push(`Right leg clamped to ${legR} mm to fit the room.`);

    let backEnd = W;
    let pensX = null;
    if (p.layout === 'peninsula') {
      pensX = clamp(Math.round(p.pensPos * W), 2 * bd + 600, W - 300);
      backEnd = pensX;
    }

    runs.back = makeRun('back', 0, D, 1, 0, 0, -1, backEnd, {
      wall: 'back',
      startCorner: has.has('left') ? bd : 0,
      endCorner: has.has('right') || p.layout === 'peninsula' ? bd : 0,
    });

    // four-wall: the legs run the full depth and stop at the front run, which owns both front corners
    const fourLeg = { counterEnd: p.nosing, wallCabEnd: bd - wcd };
    if (has.has('left')) {
      runs.left = makeRun('left', 0, D - bd, 0, -1, 1, 0, four ? D - 2 * bd : legL - bd, Object.assign({}, cornerAttached, {
        wall: 'left', endCorner: p.layout === 'g-shape' ? bd : 0,
      }, four ? fourLeg : {}));
    }
    if (has.has('right')) {
      runs.right = makeRun('right', W, D - bd, 0, -1, -1, 0, four ? D - 2 * bd : legR - bd, Object.assign({}, cornerAttached, { wall: 'right' }, four ? fourLeg : {}));
    }
    if (has.has('front')) {
      runs.front = makeRun('front', W, 0, -1, 0, 0, 1, W, {
        wall: 'front', startCorner: has.has('right') ? bd : 0, endCorner: has.has('left') ? bd : 0,
      });
    }
    for (const r of Object.values(runs)) r.style = r.freestanding ? 'standard' : p[`style${r.id[0].toUpperCase()}${r.id.slice(1)}`] || 'standard';
    if (p.layout === 'g-shape') {
      const maxP = W - bd - (has.has('right') ? bd + 900 : 600);
      const len = clamp(p.pensLen, 600, Math.max(600, maxP));
      if (len !== p.pensLen) notes.push(`Peninsula clamped to ${len} mm to keep an entry gap.`);
      runs.peninsula = makeRun('peninsula', bd, D - legL, 1, 0, 0, 1, len, {
        freestanding: true, counterStart: p.nosing,
      });
    }
    if (p.layout === 'peninsula') {
      const maxP = D - bd - 900;
      const len = clamp(p.pensLen, 600, Math.max(600, maxP));
      if (len !== p.pensLen) notes.push(`Peninsula clamped to ${len} mm to keep a walkway.`);
      runs.peninsula = makeRun('peninsula', pensX, D - bd, 0, -1, -1, 0, len, {
        freestanding: true, counterStart: p.nosing,
      });
    }
    if (p.island) {
      const leftLimit = runs.left ? bd : 0;
      const rightLimit = runs.right ? W - bd : W;
      const len = clamp(p.islandLen, 600, Math.max(600, W - 600));
      const cx = clamp(W / 2 + p.islandOffset, len / 2 + 100, W - len / 2 - 100);
      const yBack = D - bd - p.aisle - bd; // island cabinet back line (seating side)
      runs.island = makeRun('island', cx - len / 2, yBack, 1, 0, 0, 1, len, {
        freestanding: true, sideLimits: [leftLimit, rightLimit],
      });
      runs.island.style = 'standard';
    }
    return runs;
  }

  // run coordinates -> world
  function at(run, s, t) {
    return [run.ox + s * run.ux + t * run.nx, run.oy + s * run.uy + t * run.ny];
  }

  // ---------------------------------------------------------------- run filling

  // Pack appliance groups into one free stretch [lo, hi] of a run; hard0/hard1
  // are the stretch limits including corner zones (used only when it overflows).
  // items: [{key, w, s}] with s = desired centre. Returns resolved centres; mutates.
  function packItems(run, items, notes, lo, hi, hard0, hard1) {
    const total = () => items.reduce((a, it) => a + it.w, 0);
    // Too much for the run: shed optional parts, then borrow the corner zones, then drop items.
    for (const kind of ['pantry', 'dishwasher']) {
      while (total() > hi - lo + 1e-6) {
        const it = items.find((x) => x.parts.some((q) => q.kind === kind));
        if (!it) break;
        const i = it.parts.findIndex((q) => q.kind === kind);
        it.w -= it.parts[i].w;
        it.parts.splice(i, 1);
        notes.push(`${run.label}: no room for the ${kind} — removed.`);
      }
    }
    if (total() > hi - lo + 1e-6) {
      if (hard1 - hard0 > hi - lo + 1) notes.push(`${run.label}: appliances pushed into the corner zone.`);
      lo = hard0; hi = hard1;
    }
    while (items.length && total() > hi - lo + 1e-6) {
      const it = items.pop();
      notes.push(`${run.label}: ${it.key} does not fit — removed.`);
    }
    for (const it of items) it.s = clamp(it.s, lo + it.w / 2, Math.max(lo + it.w / 2, hi - it.w / 2));
    items.sort((a, b) => a.s - b.s);
    for (let i = 1; i < items.length; i++) {
      items[i].s = Math.max(items[i].s, items[i - 1].s + items[i - 1].w / 2 + items[i].w / 2);
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const lim = i === items.length - 1 ? hi - items[i].w / 2 : items[i + 1].s - items[i + 1].w / 2 - items[i].w / 2;
      items[i].s = Math.min(items[i].s, lim);
    }
    // Snap left edges to the module grid so the gaps fill with catalogue units;
    // gaps too narrow for a unit are closed up.
    const snap = (v) => Math.round(v / GRID) * GRID;
    let prevEnd = -Infinity;
    for (const it of items) {
      let s0 = Math.max(snap(it.s - it.w / 2), prevEnd, Math.ceil(lo / GRID) * GRID);
      if (s0 - prevEnd < 150) s0 = prevEnd;
      it.s = s0 + it.w / 2;
      prevEnd = s0 + it.w;
    }
    let nextStart = Infinity;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const limit = Math.min(nextStart, hi);
      if (it.s + it.w / 2 > limit + 1e-6) it.s = Math.floor((limit - it.w) / GRID) * GRID + it.w / 2;
      if (nextStart < Infinity && nextStart - (it.s + it.w / 2) < 150) it.s = nextStart - it.w / 2;
      nextStart = it.s - it.w / 2;
    }
    return items;
  }

  // Distribute appliance groups over the stretches of a run left free by doors,
  // thresholds and low windows, nearest stretch first; tall groups also avoid windows.
  function resolveItems(run, items, notes, baseVoids, tallVoids) {
    const lo0 = run.startCorner, hi0 = run.length - run.endCorner;
    if (!baseVoids.length && !tallVoids.length && !items.some((it) => it.pin !== undefined)) return packItems(run, items, notes, lo0, hi0, 0, run.length);
    const free = gaps(0, run.length, baseVoids).map(([a, b]) => ({ a, b, lo: Math.max(a, lo0), hi: Math.min(b, hi0), items: [] }));
    free.forEach((f) => (f.cap = f.hi - f.lo));
    const tallFree = gaps(0, run.length, tallVoids);
    const out = [];
    const split = (f, t0, t1) => { // cut a placed group out of its free stretch
      const pieces = [[f.a, t0], [t1, f.b]].filter(([a, b]) => b - a > 1).map(([a, b]) => {
        const g = { a, b, lo: Math.max(a, f.lo), hi: Math.min(b, f.hi), items: [] };
        g.cap = g.hi - g.lo;
        return g;
      });
      free.splice(free.indexOf(f), 1, ...pieces);
      for (const it of f.items) { // anything already assigned to the stretch moves to the nearest stretch with room
        const dist = (x) => Math.abs((x.lo + x.hi) / 2 - it.s);
        const g = free.filter((x) => x.cap >= it.w - 1e-6).reduce((m, x) => (!m || dist(x) < dist(m) ? x : m), null);
        if (!g) { notes.push(`${run.label}: no room left for the ${it.key} — removed.`); continue; }
        g.items.push(it);
        g.cap -= it.w;
      }
    };
    // pinned groups (a sink placed exactly) go exactly where asked, or as little away from it as the
    // openings, corners and run ends allow; nothing is snapped to the module grid
    for (const it of items.filter((x) => x.pin !== undefined)) {
      const fit = (g) => {
        let best = null;
        for (const f of free) {
          if (f.hi - f.lo < g.w - 1e-6) continue;
          const s = clamp(g.s, f.lo + g.w / 2, f.hi - g.w / 2);
          if (!best || Math.abs(s - g.s) < Math.abs(best.s - g.s)) best = { f, s };
        }
        return best;
      };
      let best = fit(it);
      // the dishwasher may swap sides, or go, rather than the sink moving away from its place
      if (it.parts.length > 1 && (!best || Math.abs(best.s - it.s) > 1)) {
        const off = (parts) => parts.slice(0, parts.findIndex((q) => q.kind === it.pinKind)).reduce((a, q) => a + q.w, 0) + parts.find((q) => q.kind === it.pinKind).w / 2;
        const swapped = it.parts.slice().reverse();
        const alt = { w: it.w, s: it.pin - off(swapped) + it.w / 2 };
        const altBest = fit(alt);
        if (altBest && Math.abs(altBest.s - alt.s) <= 1) {
          it.parts = swapped; it.s = alt.s; best = altBest;
          notes.push({ level: 'ok', msg: `${run.label}: dishwasher moved to the other side of the sink to keep the sink where it was placed.` });
        } else {
          const only = it.parts.filter((q) => q.kind === it.pinKind);
          const solo = { w: only[0].w, s: it.pin };
          const soloBest = fit(solo);
          if (soloBest && Math.abs(soloBest.s - solo.s) < Math.abs((best ? best.s : Infinity) - it.s)) {
            notes.push(`${run.label}: no room for the dishwasher beside the sink at its placed position — removed.`);
            it.parts = only; it.w = only[0].w; it.s = solo.s; best = soloBest;
          }
        }
      }
      if (!best) { notes.push(`${run.label}: the ${it.key} does not fit anywhere on this run — removed.`); continue; }
      const moved = best.s - it.s;
      if (Math.abs(moved) > 1) {
        it.moved = Math.round(moved);
        notes.push(`${run.label}: the ${it.key} was moved ${Math.abs(Math.round(moved))} mm to clear an opening, corner or the end of the run.`);
      }
      it.s = best.s;
      out.push(it);
      split(best.f, it.s - it.w / 2, it.s + it.w / 2);
    }
    items = items.filter((x) => x.pin === undefined);
    // tall groups first, each packed alone into its window-free zone; the stretch is then split around it
    const needsWall = (it) => it.parts.some((q) => q.tall) || !!it.avoidWindows;
    for (const it of items.slice().sort((x, y) => (needsWall(y) - needsWall(x)) || y.w - x.w)) {
      // tall units and a wall-hung hood both need wall without a window behind them
      const tall = it.parts.some((q) => q.tall) || !!it.avoidWindows;
      let best = null, bestD = Infinity;
      // a tall group too wide for every window-free zone sheds its pantries first
      const widest = () => Math.max(0, ...free.map((f) => Math.max(0, ...tallFree.map(([a, b]) => Math.min(b, f.hi) - Math.max(a, f.lo)))));
      while (tall && it.parts.length > 1 && widest() < it.w - 1e-6) {
        const i = it.parts.findIndex((q) => q.kind === 'pantry' || (q.kind === 'ovenTower' && it.parts.length > 1));
        if (i < 0) break;
        it.w -= it.parts[i].w;
        notes.push(`${run.label}: no window-free wall for the ${it.parts[i].kind === 'pantry' ? 'tall pantry' : 'oven tower'} — removed.`);
        it.parts.splice(i, 1);
      }
      for (const f of free) {
        if (f.cap < it.w - 1e-6) continue;
        // a tall group needs a window-free part of the stretch that is wide enough
        let zones = tall ? tallFree.map(([a, b]) => [Math.max(a, f.lo), Math.min(b, f.hi)]).filter(([a, b]) => b - a >= it.w - 1e-6) : [[f.lo, f.hi]];
        if (it.landing) { // keep worktop beside it where an opening cuts the run, if the stretch allows
          zones = zones.map(([a, b]) => {
            const a2 = a + (f.a > 1 ? it.landing : 0), b2 = b - (f.b < run.length - 1 ? it.landing : 0);
            if (b2 - a2 >= it.w) return [a2, b2];
            if (b - a2 >= it.w && a2 > a) return [a2, b]; // landing on one side at least
            if (b2 - a >= it.w && b2 < b) return [a, b2];
            return [a, b];
          });
        }
        for (const [a, b] of zones) {
          const d = it.s < a + it.w / 2 ? a + it.w / 2 - it.s : it.s > b - it.w / 2 ? it.s - (b - it.w / 2) : 0;
          if (d < bestD) { bestD = d; best = { f, a, b }; }
        }
      }
      if (!best) {
        const f = free.reduce((m, x) => (x.cap > m.cap ? x : m), free[0]);
        if (!f) { notes.push(`${run.label}: no free wall for the ${it.key} — removed.`); continue; }
        best = { f, a: f.lo, b: f.hi };
        if (bestD === Infinity) notes.push(`${run.label}: openings leave too little room for the ${it.key}.`);
      }
      it.s = clamp(it.s, best.a + it.w / 2, Math.max(best.a + it.w / 2, best.b - it.w / 2));
      // real tall units are placed alone and cut the stretch; a cooktop only aims at a window-free zone
      // and is packed with the rest, so it does not fragment the wall
      if (it.parts.some((q) => q.tall) && bestD !== Infinity) {
        packItems(run, [it], notes, best.a, best.b, best.a, best.b);
        out.push(it);
        const f = best.f;
        // a leftover too narrow for a unit is wasted: slide flush to that end of the stretch instead
        const gl = it.s - it.w / 2 - f.lo, gr = f.hi - (it.s + it.w / 2);
        if (Math.min(gl, gr) < 600) {
          const toLeft = gl <= gr;
          const s2 = toLeft ? f.lo + it.w / 2 : f.hi - it.w / 2;
          if (s2 - it.w / 2 >= best.a - 1e-6 && s2 + it.w / 2 <= best.b + 1e-6) it.s = s2;
        }
        split(f, it.s - it.w / 2, it.s + it.w / 2);
        continue;
      }
      best.f.items.push(it);
      best.f.cap -= it.w;
    }
    for (const f of free) if (f.items.length) out.push(...packItems(run, f.items, notes, f.lo, f.hi, f.a, f.b));
    return out;
  }

  // Split a gap into catalogue widths using as few units as possible (exact sum
  // on a 50 mm grid), plus one filler for any remainder. The filler goes at the
  // wall/corner end of the gap, where a scribed panel belongs.
  const STANDARD = [1000, 900, 800, 600, 500, 450, 400, 300, 200, 150];
  const GRID = 50;
  function modules(len, max, minW, fillerFirst) {
    if (len < 1) return [];
    const sizes = STANDARD.filter((w) => w <= max && w >= minW).map((w) => w / GRID);
    const n = Math.floor(len / GRID + 1e-6);
    const best = new Array(n + 1).fill(Infinity), pick = new Array(n + 1).fill(0);
    best[0] = 0;
    for (let k = 1; k <= n; k++) {
      for (const sz of sizes) {
        if (sz <= k && best[k - sz] + 1 < best[k]) { best[k] = best[k - sz] + 1; pick[k] = sz; }
      }
    }
    let k = n;
    while (k > 0 && best[k] === Infinity) k--;
    const out = [];
    for (let j = k; j > 0; j -= pick[j]) out.push({ w: pick[j] * GRID, filler: false });
    out.sort((a, b) => b.w - a.w);
    const rem = len - k * GRID;
    if (rem > 1e-6) {
      const f = { w: rem, filler: true };
      if (fillerFirst) out.unshift(f); else out.push(f);
    }
    return out;
  }

  // intervals = sorted, non-overlapping [a,b]; returns gaps within [lo,hi]
  function gaps(lo, hi, intervals) {
    const out = [];
    let cur = lo;
    for (const [a, b] of intervals) {
      if (a > cur + 1e-6) out.push([cur, Math.min(a, hi)]);
      cur = Math.max(cur, b);
    }
    if (hi > cur + 1e-6) out.push([cur, hi]);
    return out.filter(([a, b]) => b - a > 1e-6);
  }

  function mergeIntervals(list) {
    const s = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const iv of s) {
      if (out.length && iv[0] <= out[out.length - 1][1] + 1e-6) out[out.length - 1][1] = Math.max(out[out.length - 1][1], iv[1]);
      else out.push([iv[0], iv[1]]);
    }
    return out;
  }

  // ---------------------------------------------------------------- main

  function generate(input) {
    const p = normalise(input);
    const notes = [];
    const runs = buildRuns(p, notes);
    const boxes = [];
    let seq = 0;
    const W = p.roomW, D = p.roomD, bd = p.baseDepth;
    const carcassTop = p.counterH - p.counterT;

    function box(run, kind, cat, s0, s1, t0, t1, z0, z1, extra) {
      const [cx, cy] = at(run, (s0 + s1) / 2, (t0 + t1) / 2);
      const b = Object.assign({
        id: `${kind}-${++seq}`, kind, cat, run: run.id,
        cx: r1(cx), cy: r1(cy), z: r1(z0),
        L: r1(s1 - s0), D: r1(t1 - t0), H: r1(z1 - z0),
        ux: run.ux, uy: run.uy, nx: run.nx, ny: run.ny,
      }, extra || {});
      boxes.push(b);
      return b;
    }

    // ---- door / drawer fronts, proud of a carcass face at t = depth
    const FT = 19, GAP = 3, HD = 26; // front thickness, joint, handle projection
    function fronts(run, s0, s1, depth, bands, o) {
      if (!p.fronts) return;
      const a = Math.max(s0, o.clipA === undefined ? s0 : o.clipA);
      const b = Math.min(s1, o.clipB === undefined ? s1 : o.clipB);
      if (b - a < 40) return;
      const openRight = (s0 + s1) / 2 < run.length / 2; // single doors open towards the middle of the run
      for (const band of bands) {
        const leaves = band.type === 'door' && b - a > 650 ? 2 : 1;
        const lw = (b - a) / leaves;
        for (let i = 0; i < leaves; i++) {
          const fa = a + i * lw + GAP / 2, fb = a + (i + 1) * lw - GAP / 2;
          box(run, 'front', band.cat || CAT.CAB, fa, fb, depth, depth + FT, band.z0 + GAP / 2, band.z1 - GAP / 2,
            { label: band.label || (band.type === 'drawer' ? 'Drawer front' : 'Door'), finish: band.finish || 'front', group: o.group || 'base' });
          const t0 = depth + FT, t1 = t0 + HD;
          if (p.handles === 'none' && band.finish !== 'steel' && band.finish !== 'oven') continue; // push-to-open
          if (band.handle === 'h') {
            const len = Math.min((fb - fa) * 0.5, 420), c = (fa + fb) / 2;
            box(run, 'handle', CAT.CAB, c - len / 2, c + len / 2, t0, t1, band.hz - 7, band.hz + 7, { label: 'Handle' });
          } else if (band.handle === 'v') {
            const edge = leaves === 2 ? (i === 0 ? fb - 40 : fa + 40) : (openRight ? fb - 40 : fa + 40);
            box(run, 'handle', CAT.CAB, edge - 7, edge + 7, t0, t1, band.hz - band.hl / 2, band.hz + band.hl / 2, { label: 'Handle' });
          }
        }
      }
    }
    function baseBands(kind, w) {
      const z0 = p.plinthH, top = carcassTop, dz = 170;
      switch (kind) {
        case 'sink': case 'prepSink': return [{ z0: top - dz, z1: top, type: 'panel', label: 'False drawer front' }, { z0, z1: top - dz, type: 'door', handle: 'v', hz: top - dz - 90, hl: 160 }];
        case 'cooktop': return [
          { z0: top - 600, z1: top, type: 'panel', label: 'Oven', finish: 'oven', cat: CAT.APP, handle: 'h', hz: top - 45 },
          { z0, z1: top - 600, type: 'drawer', handle: 'h', hz: (z0 + top - 600) / 2 },
        ];
        case 'dishwasher': return [{ z0, z1: top, type: 'panel', label: 'Dishwasher panel', handle: 'h', hz: top - 50 }];
        case 'filler': return [{ z0, z1: top, type: 'panel', label: 'Filler panel' }];
        default:
          if (w <= 350) return [{ z0, z1: top, type: 'door', handle: 'v', hz: top - 110, hl: 160 }];
          return [{ z0: top - dz, z1: top, type: 'drawer', handle: 'h', hz: top - dz / 2 }, { z0, z1: top - dz, type: 'door', handle: 'v', hz: top - dz - 90, hl: 160 }];
      }
    }

    // ---- walls and the openings placed in them
    const t = p.wallT;
    const walls = [];
    const wallDefs = {
      back: [-t / 2, D + t / 2, W + t / 2, D + t / 2],
      front: [-t / 2, -t / 2, W + t / 2, -t / 2],
      left: [-t / 2, -t / 2, -t / 2, D + t / 2],
      right: [W + t / 2, -t / 2, W + t / 2, D + t / 2],
    };
    const omitSides = p.layout === 'galley' && p.openEnds;
    for (const [id, [x1, y1, x2, y2]] of Object.entries(wallDefs)) {
      if (omitSides && (id === 'left' || id === 'right')) continue;
      walls.push({ id, x1, y1, x2, y2, t, h: p.wallH });
    }
    const wallById = Object.fromEntries(walls.map((w) => [w.id, w]));
    const openings = [];
    for (const q of p.openings) {
      if (!wallById[q.wall]) { notes.push(`${q.id}: the ${q.wall} wall is open in this layout — opening ignored.`); continue; }
      openings.push(placeOpening(q, p, notes));
    }

    // Stretches of each wall run that openings take away, in run coordinates.
    // base: doors, thresholds and windows whose sill is below the worktop;
    // tall: base + every window; wall units: anything reaching into their band.
    const CASING = 50;
    const toS = (run, x, y) => (x - run.ox) * run.ux + (y - run.oy) * run.uy;
    const voidCache = {};
    function runVoids(run) {
      if (voidCache[run.id]) return voidCache[run.id];
      const v = voidCache[run.id] = { base: [], tall: [], wall: [] };
      for (const o of openings) {
        if (run.freestanding || o.wall !== run.wall) continue;
        const sa = toS(run, ...wallPoint(o.wall, o.a0, p)), sb = toS(run, ...wallPoint(o.wall, o.a1, p));
        const m = o.kind === 'window' ? 0 : CASING;
        const iv = [Math.max(0, Math.min(sa, sb) - m), Math.min(run.length, Math.max(sa, sb) + m)];
        if (iv[1] <= iv[0]) continue;
        const wtop = p.wallCabElev + p.wallCabH;
        if (o.kind !== 'window' || o.sill < p.counterH + 10) v.base.push(iv);
        v.tall.push(iv);
        if (o.kind !== 'window' ? o.h > p.wallCabElev : o.sill < wtop && o.sill + o.h > p.wallCabElev) v.wall.push([iv[0] - 50, iv[1] + 50]);
      }
      // runs on the other walls (and peninsulas) stop short of door swings and passages
      for (const o of openings) {
        if (o.wall === run.wall || run.id === 'island') continue; // an island is moved, not split
        // windows: only the cabinet-depth band in front of them (a corner unit of the next run); doors: the swing
        const d = bd - 1;
        const z = o.kind !== 'window' ? clearZone(o, p)
          : o.wall === 'back' ? [o.a0, D - d, o.a1, D] : o.wall === 'front' ? [o.a0, 0, o.a1, d]
            : o.wall === 'left' ? [0, o.a0, d, o.a1] : [W - d, o.a0, W, o.a1];
        const tb = run.freestanding ? -p.overhang : 0;
        const corners = [at(run, 0, tb), at(run, run.length, tb), at(run, 0, bd + p.nosing), at(run, run.length, bd + p.nosing)];
        const fx0 = Math.min(...corners.map((c) => c[0])), fx1 = Math.max(...corners.map((c) => c[0]));
        const fy0 = Math.min(...corners.map((c) => c[1])), fy1 = Math.max(...corners.map((c) => c[1]));
        const ix0 = Math.max(fx0, z[0]), ix1 = Math.min(fx1, z[2]), iy0 = Math.max(fy0, z[1]), iy1 = Math.min(fy1, z[3]);
        if (ix1 - ix0 < 1 || iy1 - iy0 < 1) continue;
        const ss = [[ix0, iy0], [ix1, iy0], [ix0, iy1], [ix1, iy1]].map(([x, y]) => toS(run, x, y));
        const iv = [Math.max(0, Math.min(...ss)), Math.min(run.length, Math.max(...ss))];
        if (iv[1] - iv[0] < 1) continue;
        if (o.kind === 'window') {
          if (o.sill < p.counterH + 10) v.base.push(iv);
          v.tall.push(iv); v.wall.push(iv);
          continue;
        }
        v.base.push(iv); v.tall.push(iv); v.wall.push(iv);
        notes.push({ level: 'ok', msg: `${run.label} run kept clear of ${o.id}'s ${o.kind === 'door' && o.swing === 'in' ? 'door swing' : 'passage'}.` });
      }
      v.base = mergeIntervals(v.base); v.tall = mergeIntervals(v.tall); v.wall = mergeIntervals(v.wall);
      return v;
    }

    // ---- appliance assignment
    const runIds = Object.keys(runs);
    const wallRuns = runIds.filter((id) => !runs[id].freestanding);
    const def = LAYOUTS[p.layout].defaults;
    const pick = (want, fallback, allowed) => (allowed.includes(want) ? want : allowed.includes(fallback) ? fallback : allowed[0]);
    const sinkRun = pick(p.sinkRun, def.sinkRun, runIds);
    const cookRun = pick(p.cookRun, def.cookRun, runIds);
    const fridgeRun = pick(p.fridgeRun, def.fridgeRun, wallRuns);
    const assigned = { sinkRun, cookRun, fridgeRun };

    const itemsByRun = {};
    runIds.forEach((id) => (itemsByRun[id] = []));
    const usable = (run) => [run.startCorner, run.length - run.endCorner];
    const posOf = (run, f, w, landing) => {
      let [lo, hi] = usable(run);
      if (landing && hi - lo - w >= 2 * landing) { lo += landing; hi -= landing; }
      return lo + w / 2 + f * Math.max(0, hi - lo - w);
    };
    // the viewer's right hand when facing the run, expressed as +1 (along u) or -1
    const rightSign = (run) => (-run.ny * run.ux + run.nx * run.uy > 0 ? 1 : -1);

    // Free wall per run after openings, claimed appliance by appliance, so an
    // appliance whose run is full moves to another run instead of being dropped.
    // Kept as interval sets per run: `free` (no door, threshold or low window) and `wall` (free and
    // no window either: room for a tall unit or a wall hood). A pinned sink removes its exact span.
    const capacity = {};
    const cut = (ivs, a, b) => ivs.flatMap(([x, y]) => [[x, Math.min(y, a)], [Math.max(x, b), y]]).filter(([x, y]) => y - x > 1);
    const capOf = (id) => capacity[id] || (capacity[id] = (() => {
      const r = runs[id], v = runVoids(r);
      return { free: gaps(r.startCorner, r.length - r.endCorner, v.base), wall: gaps(r.startCorner, r.length - r.endCorner, v.tall) };
    })());
    const claimExact = (id, a, b) => { const c = capOf(id); c.free = cut(c.free, a, b); c.wall = cut(c.wall, a, b); };
    const claim = (id, w, needWall) => {
      const c = capOf(id);
      const segs = needWall && !runs[id].freestanding
        ? c.free.flatMap(([a, b]) => c.wall.map(([x, y]) => [Math.max(a, x), Math.min(b, y)])) : c.free;
      const seg = segs.find(([a, b]) => b - a >= w - 1e-6);
      if (seg) claimExact(id, seg[0], seg[0] + w);
      return !!seg;
    };
    const chooseRun = (want, candidates, w, tall, name) => {
      if (claim(want, w, tall)) return want;
      const alt = candidates.find((id) => id !== want && claim(id, w, tall));
      if (!alt) return want;
      notes.push(`${name} moved to the ${runs[alt].label.toLowerCase()} run: openings and other appliances leave no ${Math.round(w)} mm on the ${runs[want].label.toLowerCase()}.`);
      return alt;
    };
    // a tall wall has no worktop, so the sink and cooktop go elsewhere
    const worktopRuns = runIds.filter((id) => runs[id].style !== 'tall');
    const sinkGroupW = p.sinkW + (p.dwSide !== 'none' ? 600 : 0);
    // a sink placed under a chosen window or at an exact position decides its own run
    let sinkPin = null; // { run, s (sink centre on the run), under }
    if (p.sinkMode === 'window') {
      const win = openings.find((o) => o.kind === 'window' && o.id === p.sinkWindow);
      const run = win && Object.values(runs).find((r) => !r.freestanding && r.wall === win.wall);
      if (!win) notes.push(`Sink: window ${p.sinkWindow || '(none chosen)'} not found — placed automatically.`);
      else if (!run) notes.push(`Sink: the ${win.wall} wall has no cabinet run in this layout, so the sink cannot go under ${win.id} — placed automatically.`);
      else {
        if (win.sill < p.counterH - 10) notes.push(`Sink: ${win.id}'s sill (${win.sill} mm) is below the worktop.`);
        sinkPin = { run: run.id, s: toS(run, ...wallPoint(win.wall, (win.a0 + win.a1) / 2 + p.sinkShift, p)), under: win.id };
      }
    } else if (p.sinkMode === 'exact') {
      const run = runs[p.sinkRun] && runs[p.sinkRun].style !== 'tall' ? runs[p.sinkRun] : null;
      if (!run) notes.push(`Sink: run ${p.sinkRun} is not available for a sink in this layout — placed automatically.`);
      else if (run.freestanding) {
        sinkPin = { run: run.id, s: p.sinkFrom === 'start' ? p.sinkOffset : run.length - p.sinkOffset };
      } else {
        const len = run.wall === 'back' || run.wall === 'front' ? W : D;
        sinkPin = { run: run.id, s: toS(run, ...wallPoint(run.wall, p.sinkFrom === 'start' ? p.sinkOffset : len - p.sinkOffset, p)) };
      }
    }
    if (sinkPin) { // claim the real span: the dishwasher sits on one side of the sink centre
      const dwW = p.dwSide !== 'none' ? 600 : 0;
      const after = dwW && (p.dwSide === 'right') === (rightSign(runs[sinkPin.run]) > 0);
      const a = sinkPin.s - p.sinkW / 2 - (after ? 0 : dwW);
      claimExact(sinkPin.run, a, a + sinkGroupW);
    }
    // then the hardest to place: the fridge needs window-free wall
    const fRun = chooseRun(fridgeRun, wallRuns, p.fridgeW, true, 'Fridge');
    const sRun = sinkPin ? sinkPin.run : chooseRun(worktopRuns.includes(sinkRun) ? sinkRun : worktopRuns[0], worktopRuns, sinkGroupW, false, 'Sink');
    // a cooktop on a wall run needs window-free wall for its hood
    const cRun = chooseRun(worktopRuns.includes(cookRun) ? cookRun : worktopRuns[0], worktopRuns, p.cookW, true, 'Cooktop');
    const tallRuns = wallRuns.filter((id) => runs[id].style === 'tall');
    const oRun = p.ovenTowers ? chooseRun(wallRuns.includes(p.ovenRun) ? p.ovenRun : (tallRuns[0] || wallRuns[wallRuns.length - 1]),
      tallRuns.concat(wallRuns), 600 * p.ovenTowers, true, 'Oven tower') : null;

    // With "window over sink" the sink is centred under an existing window of its
    // wall when there is one; only an unfixed room gets a window added over the sink.
    let sinkUnder = null;
    let sinkMoved = 0;
    {
      const run = runs[sRun];
      const parts = [{ kind: 'sink', w: p.sinkW }];
      if (p.dwSide !== 'none') {
        const after = (p.dwSide === 'right') === (rightSign(run) > 0);
        if (after) parts.push({ kind: 'dishwasher', w: 600 });
        else parts.unshift({ kind: 'dishwasher', w: 600 });
      }
      const w = parts.reduce((a, q) => a + q.w, 0);
      const sinkOff = parts.slice(0, parts.findIndex((q) => q.kind === 'sink')).reduce((a, q) => a + q.w, 0) + p.sinkW / 2;
      let sc = posOf(run, p.sinkPos, w);
      if (sinkPin) {
        itemsByRun[sRun].push({ key: 'sink', parts, w, s: sinkPin.s - sinkOff + w / 2, pin: sinkPin.s, pinKind: 'sink' });
        sinkUnder = sinkPin.under || null;
      }
      const wins = !sinkPin && p.windowOverSink && !run.freestanding
        ? openings.filter((o) => o.kind === 'window' && o.wall === run.wall && o.sill >= p.counterH - 10) : [];
      if (wins.length) {
        const sOf = (o) => toS(run, ...wallPoint(o.wall, (o.a0 + o.a1) / 2, p));
        const win = wins.reduce((m, o) => (Math.abs(sOf(o) - sc) < Math.abs(sOf(m) - sc) ? o : m), wins[0]);
        sc = sOf(win) - sinkOff + w / 2;
        // aimed at a window on purpose: placed first, exactly under it, everything else around it
        itemsByRun[sRun].push({ key: 'sink', parts, w, s: sc, pin: sOf(win), pinKind: 'sink' });
        sinkUnder = win.id;
      } else if (!sinkPin) itemsByRun[sRun].push({ key: 'sink', parts, w, s: sc });
    }
    {
      const run = runs[cRun];
      itemsByRun[cRun].push({ key: 'cook', parts: [{ kind: 'cooktop', w: p.cookW }], w: p.cookW, landing: 300, avoidWindows: !run.freestanding,
        s: posOf(run, p.cookPos, p.cookW, 300) });
    }
    if (oRun) {
      const parts = Array.from({ length: p.ovenTowers }, () => ({ kind: 'ovenTower', w: 600, tall: true }));
      itemsByRun[oRun].push({ key: 'oven tower', parts, w: 600 * p.ovenTowers, s: posOf(runs[oRun], p.ovenPos, 600 * p.ovenTowers) });
    }
    if (runs.island && p.prepSink) {
      const isl = runs.island;
      itemsByRun.island.push({ key: 'prep sink', parts: [{ kind: 'prepSink', w: 450 }], w: 450, s: posOf(isl, sRun === 'island' ? 0.15 : 0.5, 450) });
    }
    {
      const run = runs[fRun];
      const parts = [{ kind: 'fridge', w: p.fridgeW, tall: true }];
      const s0 = posOf(run, p.fridgePos, p.fridgeW);
      const towardEnd = s0 < run.length / 2;
      for (let i = 0; i < p.pantryCount; i++) {
        const q = { kind: 'pantry', w: 600, tall: true };
        if (towardEnd) parts.push(q); else parts.unshift(q);
      }
      const w = parts.reduce((a, q) => a + q.w, 0);
      const fOff = parts.slice(0, parts.findIndex((q) => q.kind === 'fridge')).reduce((a, q) => a + q.w, 0) + p.fridgeW / 2;
      itemsByRun[fRun].push({ key: 'fridge', parts, w, s: s0 - fOff + w / 2 });
    }

    const placed = {}; // kind -> {run, s, w}
    let sinkWindow = null;
    const cooktopLanding = [];
    const sinkLanding = [];

    // ---- per run
    for (const id of runIds) {
      const run = runs[id];
      const voids = runVoids(run);
      const items = resolveItems(run, itemsByRun[id], notes, voids.base, voids.tall);
      const sinkItem = items.find((it) => it.key === 'sink');
      if (sinkItem && sinkItem.moved) sinkMoved = sinkItem.moved;

      // expand groups into concrete segments
      const segs = [];
      for (const it of items) {
        let s = it.s - it.w / 2;
        for (const q of it.parts) {
          segs.push({ kind: q.kind, s0: s, s1: s + q.w, tall: !!q.tall });
          placed[q.kind] = placed[q.kind] || { run: id, s: s + q.w / 2, w: q.w };
          s += q.w;
        }
      }
      segs.sort((a, b) => a.s0 - b.s0);
      // a pantry or oven tower pushed in front of a window is dropped (the fridge stays and is reported)
      for (let i = segs.length - 1; i >= 0; i--) {
        const g = segs[i];
        if ((g.kind === 'pantry' || g.kind === 'ovenTower') && voids.tall.some(([a, b]) => a < g.s1 - 1 && b > g.s0 + 1)) {
          notes.push(`${run.label}: ${g.kind === 'pantry' ? 'tall pantry' : 'oven tower'} would stand in front of a window — removed.`);
          segs.splice(i, 1);
        }
      }

      // fill gaps with base cabinets, leaving openings clear
      const fixedIv = mergeIntervals(segs.map((g) => [g.s0, g.s1]).concat(voids.base));
      const baseSegs = segs.slice();
      const edge = (x) => x < 1 || x > run.length - 1 || voids.base.some(([a, b]) => Math.abs(a - x) < 1 || Math.abs(b - x) < 1);
      // On a tall wall the free stretches get floor-to-ceiling units, except under
      // windows and in the optional central niche, which keep base units and a worktop.
      const nicheIv = [];
      if (run.style === 'tall') {
        const windowsIv = mergeIntervals(voids.tall.filter((t) => !voids.base.some((b) => b[0] <= t[0] + 1 && b[1] >= t[1] - 1)));
        nicheIv.push(...windowsIv.map(([a, b]) => [Math.max(0, a - 100), Math.min(run.length, b + 100)]));
        if (p.tallNiche > 0) {
          const free = gaps(0, run.length, mergeIntervals(fixedIv.concat(nicheIv)));
          const big = free.reduce((m, g) => (g[1] - g[0] > m[1] - m[0] ? g : m), [0, 0]);
          const w = Math.min(p.tallNiche, big[1] - big[0] - 300);
          if (w >= 600) { const c = (big[0] + big[1]) / 2; nicheIv.push([Math.round((c - w / 2) / 50) * 50, Math.round((c - w / 2) / 50) * 50 + Math.floor(w / 50) * 50]); }
        }
        const niches = mergeIntervals(nicheIv);
        nicheIv.length = 0;
        nicheIv.push(...niches);
        for (const [a, b] of gaps(0, run.length, mergeIntervals(fixedIv.concat(niches)))) {
          let s = a;
          for (const m of modules(b - a, Math.min(p.moduleMax, 600), 300, edge(a) && !edge(b))) {
            baseSegs.push({ kind: m.filler ? 'tallFiller' : 'pantry', s0: s, s1: s + m.w, tall: true });
            s += m.w;
          }
        }
      }
      const fillIv = run.style === 'tall' ? nicheIv : null;
      for (const [a, b] of fillIv ? fillIv.map(([a, b]) => gaps(a, b, fixedIv)).flat() : gaps(0, run.length, fixedIv)) {
        let s = a;
        const fillerFirst = edge(a) && !edge(b); // filler against the wall end or the opening
        const mods = modules(b - a, p.moduleMax, 150, fillerFirst);
        // widest unit towards the run end the gap touches (for the corner unit)
        if (b > run.length - 1 && a > 1) mods.sort((x, y) => (x.filler - y.filler) || (x.w - y.w));
        // the first/last real unit of a gap that reaches a cornered run end is the blind corner unit
        const units = mods.filter((m) => !m.filler);
        const merge = (i, j) => { // a blind corner unit needs ≥ 300 mm of door beyond the corner
          mods[i].w += mods[j].w;
          mods.splice(j, 1);
        };
        if (units.length && a < 1 && run.startCorner > 0) {
          let i = mods.indexOf(units[0]);
          if (units[0].w < run.startCorner + 300 && mods[i + 1] && !mods[i + 1].filler) merge(i, i + 1);
          mods[i].corner = true;
        }
        const u2 = mods.filter((m) => !m.filler);
        if (u2.length && b > run.length - 1 && run.endCorner > 0) {
          let i = mods.indexOf(u2[u2.length - 1]);
          if (u2[u2.length - 1].w < run.endCorner + 300 && mods[i - 1] && !mods[i - 1].filler && !mods[i - 1].corner) { merge(i - 1, i); i -= 1; }
          mods[i].corner = true;
        }
        for (const m of mods) {
          baseSegs.push({ kind: m.filler ? 'filler' : m.corner ? 'corner' : 'base', s0: s, s1: s + m.w });
          s += m.w;
        }
      }
      baseSegs.sort((x, y) => x.s0 - y.s0);

      const clip = { // fronts must not run into the cabinets of the adjoining run
        clipA: run.startCorner > 0 ? run.startCorner + FT : undefined,
        clipB: run.endCorner > 0 ? run.length - run.endCorner - FT : undefined,
      };
      for (const g of baseSegs) {
        const w = g.s1 - g.s0;
        const ins = p.fronts ? 0 : 1.5; // visual joint between carcasses when there are no fronts
        if (g.kind === 'tallFiller') {
          box(run, 'filler', CAT.CAB, g.s0, g.s1, 0, bd, p.plinthH, p.tallH, { label: `Tall filler ${Math.round(w)}`, w: Math.round(w), code: `TF${Math.round(w)}` });
          fronts(run, g.s0, g.s1, bd, [{ z0: p.plinthH, z1: p.tallH, type: 'panel', label: 'Filler panel' }], Object.assign({ group: 'tall' }, clip));
        } else if (g.tall) {
          const isFridge = g.kind === 'fridge', isOven = g.kind === 'ovenTower';
          const label = isFridge ? `Fridge ${Math.round(w)}` : isOven ? `Oven tower ${Math.round(w)}` : `Tall pantry ${Math.round(w)}`;
          const code = isFridge ? `F${Math.round(w)}` : isOven ? `OT${Math.round(w)}` : `T${Math.round(w)}`;
          box(run, g.kind === 'ovenTower' ? 'pantry' : g.kind, isFridge || isOven ? CAT.APP : CAT.CAB, g.s0 + ins, g.s1 - ins, 0, bd, p.plinthH, p.tallH,
            { label, w: Math.round(w), code, tower: isOven || undefined });
          const z0 = p.plinthH, z1 = p.tallH;
          if (isOven) { // two drawers, a built-in oven at eye level, a door above
            const o0 = p.counterH + 50, o1 = o0 + 600;
            fronts(run, g.s0, g.s1, bd, [
              { z0, z1: (z0 + o0) / 2, type: 'drawer', handle: 'h', hz: (z0 + (z0 + o0) / 2) / 2 },
              { z0: (z0 + o0) / 2, z1: o0, type: 'drawer', handle: 'h', hz: ((z0 + o0) / 2 + o0) / 2 },
              { z0: o0, z1: o1, type: 'panel', label: 'Built-in oven', finish: 'oven', cat: CAT.APP, handle: 'h', hz: o1 - 45 },
              { z0: o1, z1, type: 'door', handle: 'v', hz: o1 + 160, hl: 260 },
            ], Object.assign({ group: 'tall' }, clip));
          } else if (isFridge) {
            const zs = z0 + Math.round((z1 - z0) * 0.38);
            fronts(run, g.s0, g.s1, bd, [
              { z0, z1: zs, type: 'panel', label: 'Freezer door', finish: 'steel', cat: CAT.APP, handle: 'v', hz: zs - 170, hl: 260 },
              { z0: zs, z1, type: 'panel', label: 'Fridge door', finish: 'steel', cat: CAT.APP, handle: 'v', hz: zs + 330, hl: 520 },
            ], clip);
          } else {
            const zs = p.counterH;
            fronts(run, g.s0, g.s1, bd, [
              { z0, z1: zs, type: 'door', handle: 'v', hz: zs - 160, hl: 300 },
              { z0: zs, z1, type: 'door', handle: 'v', hz: zs + 160, hl: 300 },
            ], Object.assign({ group: 'tall' }, clip));
          }
        } else if (g.kind === 'filler') {
          box(run, 'filler', CAT.CAB, g.s0, g.s1, 0, bd, p.plinthH, carcassTop, { label: `Filler ${Math.round(w)}`, w: Math.round(w), code: `FL${Math.round(w)}` });
          fronts(run, g.s0, g.s1, bd, baseBands('filler', w), clip);
        } else {
          const codes = { base: 'B', corner: 'BC', sink: 'SB', prepSink: 'PS', dishwasher: 'DW', cooktop: 'CB' };
          const labels = { base: 'Base', corner: 'Blind corner base', sink: 'Sink base', prepSink: 'Prep sink base', dishwasher: 'Dishwasher', cooktop: 'Cooktop / oven base' };
          box(run, g.kind === 'dishwasher' ? 'dishwasher' : g.kind === 'sink' || g.kind === 'prepSink' ? 'sinkBase' : g.kind === 'cooktop' ? 'cookBase' : g.kind, g.kind === 'dishwasher' || g.kind === 'cooktop' ? CAT.APP : CAT.CAB,
            g.s0 + ins, g.s1 - ins, 0, bd, p.plinthH, carcassTop,
            { label: `${labels[g.kind]} ${Math.round(w)}`, w: Math.round(w), code: `${codes[g.kind]}${Math.round(w)}` });
          fronts(run, g.s0, g.s1, bd, baseBands(g.kind, w), clip);
        }
        // plinth (recessed)
        if (p.plinthH > 0) box(run, 'plinth', CAT.CAB, g.s0, g.s1, run.freestanding ? 60 : 0, bd - 60, 0, p.plinthH, { label: 'Plinth' });
      }

      // worktop over non-tall stretches
      const tallIv = mergeIntervals(baseSegs.filter((g) => g.tall || g.kind === 'tallFiller').map((g) => [g.s0, g.s1]).concat(voids.base));
      const back = run.freestanding ? -p.overhang : 0;
      const topRuns = gaps(run.counterStart, run.length - run.counterEnd, tallIv);
      for (const [a, b] of topRuns) {
        box(run, 'counter', CAT.TOP, a, b, back, bd + p.nosing, carcassTop, p.counterH, { label: 'Worktop' });
      }
      if (run.freestanding) {
        box(run, 'panel', CAT.CAB, run.counterStart, run.length, -18, 0, 0, carcassTop, { label: 'Back panel' });
      }

      // niches in a tall wall: open shelves and a bridge of wall units above (unless a window is there)
      for (const [a, b] of nicheIv) {
        const hasWindow = voids.tall.some(([x, y]) => x < b - 1 && y > a + 1) && !voids.base.some(([x, y]) => x < b - 1 && y > a + 1);
        if (hasWindow) continue;
        const sd = Math.min(350, p.wallCabDepth);
        box(run, 'panel', CAT.CAB, a, b, 0, 12, p.counterH, p.tallH - 400, { label: 'Niche back panel', finish: 'stone' });
        for (const z of [p.counterH + 550, p.counterH + 950]) box(run, 'shelf', CAT.CAB, a, b, 12, sd, z, z + 30, { label: 'Open shelf' });
        box(run, 'wallCab', CAT.CAB, a, b, 0, bd, p.tallH - 400, p.tallH, { label: `Bridge unit ${Math.round(b - a)}`, w: Math.round(b - a), code: `BR${Math.round(b - a)}` });
        fronts(run, a, b, bd, [{ z0: p.tallH - 400, z1: p.tallH, type: 'door', handle: 'v', hz: p.tallH - 330, hl: 120 }], { group: 'tall' });
      }

      // sink bowl & cooktop on the worktop; hood above the cooktop
      for (const g of segs) {
        const c = (g.s0 + g.s1) / 2, w = g.s1 - g.s0;
        if (g.kind === 'prepSink') {
          box(run, 'sinkBowl', CAT.APP, c - 170, c + 170, 90, bd - 90, p.counterH - 4, p.counterH + 2, { label: 'Prep sink', bowls: 1 });
          box(run, 'tap', CAT.APP, c - 20, c + 20, 30, 70, p.counterH, p.counterH + 300, { label: 'Tap' });
          box(run, 'tap', CAT.APP, c - 14, c + 14, 50, 230, p.counterH + 272, p.counterH + 300, { label: 'Tap spout' });
        }
        if (g.kind === 'sink') {
          const bw = Math.min(w - 120, 820);
          box(run, 'sinkBowl', CAT.APP, c - bw / 2, c + bw / 2, 80, bd - 80, p.counterH - 4, p.counterH + 2, { label: 'Sink', bowls: bw > 650 ? 2 : 1 });
          box(run, 'tap', CAT.APP, c - 22, c + 22, 28, 72, p.counterH, p.counterH + 320, { label: 'Tap' });
          box(run, 'tap', CAT.APP, c - 15, c + 15, 50, 260, p.counterH + 290, p.counterH + 320, { label: 'Tap spout' });
          sinkLanding.push(landing(run, g, segs, tallIv));
        }
        if (g.kind === 'cooktop') {
          box(run, 'cooktop', CAT.APP, c - w / 2 + 30, c + w / 2 - 30, 50, bd - 30, p.counterH, p.counterH + 8, { label: 'Cooktop', burners: w >= 800 ? 5 : 4 });
          const hw = Math.max(600, w);
          const hz = p.counterH + 650;
          if (run.freestanding) {
            box(run, 'hood', CAT.APP, c - hw / 2, c + hw / 2, 20, bd - 20, hz, hz + 80, { label: 'Island hood' });
            box(run, 'hood', CAT.APP, c - 150, c + 150, bd / 2 - 150, bd / 2 + 150, hz + 80, p.wallH, { label: 'Hood chimney' });
          } else {
            box(run, 'hood', CAT.APP, c - hw / 2, c + hw / 2, 0, 500, hz, hz + 80, { label: 'Hood' });
            box(run, 'hood', CAT.APP, c - 150, c + 150, 0, 280, hz + 80, p.wallH, { label: 'Hood chimney' });
          }
          cooktopLanding.push(landing(run, g, segs, tallIv));
        }
      }

      // automatic window centred over a wall-run sink, narrowed to clear tall units and other openings
      const sinkSeg = segs.find((g) => g.kind === 'sink');
      if (p.sinkMode === 'auto' && p.windowOverSink && !p.siteFixed && !sinkUnder && sinkSeg && !run.freestanding && wallById[run.wall]) {
        const c = (sinkSeg.s0 + sinkSeg.s1) / 2;
        const stops = mergeIntervals(segs.filter((g) => g.tall).map((g) => [g.s0, g.s1]).concat(voids.tall.map(([a, b]) => [a - 100, b + 100])));
        let room = Math.min(c, run.length - c) - 50;
        for (const [a, b] of stops) room = Math.min(room, b <= c ? c - b - 50 : a >= c ? a - c - 50 : 0);
        const w = Math.floor(Math.min(p.windowW, 2 * room) / 10) * 10;
        if (w >= 400) sinkWindow = { run: run.id, s: c, w };
        else notes.push('Window over sink omitted: no clear wall beside the sink.');
      }

      // wall cabinets
      if (p.wallCabs && !run.freestanding && run.style === 'standard') {
        const blocked = segs.filter((g) => g.tall).map((g) => [g.s0, g.s1]);
        const cook = segs.find((g) => g.kind === 'cooktop');
        if (cook) {
          const c = (cook.s0 + cook.s1) / 2, hw = Math.max(600, cook.s1 - cook.s0);
          blocked.push([c - hw / 2, c + hw / 2]);
        }
        blocked.push(...voids.wall);
        blocked.push(...baseSegs.filter((g) => g.tall || g.kind === 'tallFiller').map((g) => [g.s0, g.s1]));
        if (sinkWindow && sinkWindow.run === run.id) blocked.push([sinkWindow.s - sinkWindow.w / 2 - 50, sinkWindow.s + sinkWindow.w / 2 + 50]);
        const z0 = p.wallCabElev, z1 = p.wallCabElev + p.wallCabH, wcd = p.wallCabDepth;
        const wclip = {
          clipA: run.startCorner > 0 && !(run.id === 'front' && runs.right && runs.right.style !== 'standard') ? wcd + FT : undefined,
          clipB: (run.id === 'back' && runs.right) || (run.id === 'front' && runs.left) ? run.length - wcd - FT : undefined, // the adjoining leg's wall units
          group: 'wall',
        };
        const wallBand = [{ z0, z1, type: 'door', handle: 'v', hz: z0 + 90, hl: 140 }];
        for (const [a, b] of gaps(run.wallCabStart, run.length + run.wallCabEnd, mergeIntervals(blocked))) {
          if (b - a < 200) continue;
          let s = a;
          for (const m of modules(b - a, p.moduleMax, 300, a < run.wallCabStart + 1 && b < run.length + run.wallCabEnd - 1)) {
            if (!m.filler) {
              const ins = p.fronts ? 0 : 1.5;
              box(run, 'wallCab', CAT.CAB, s + ins, s + m.w - ins, 0, wcd, z0, z1,
                { label: `Wall ${Math.round(m.w)}`, w: Math.round(m.w), code: `W${Math.round(m.w)}` });
              fronts(run, s, s + m.w, wcd, wallBand, wclip);
            }
            else if (m.w >= 20) box(run, 'wallFiller', CAT.CAB, s, s + m.w, 0, p.wallCabDepth, z0, z1,
              { label: `Wall filler ${Math.round(m.w)}`, w: Math.round(m.w), code: `WF${Math.round(m.w)}` });
            s += m.w;
          }
        }
      }

      // stools along freestanding runs
      if (run.freestanding && p.overhang >= 200) {
        const avail = run.length - run.counterStart - 150;
        const n = Math.max(0, Math.floor((avail + 150) / p.stoolSpacing));
        const pitch = n ? avail / n : 0;
        for (let i = 0; i < n; i++) {
          const s = run.counterStart + 75 + pitch * (i + 0.5);
          box(run, 'stool', CAT.FURN, s - 190, s + 190, -p.overhang - 230, -p.overhang + 150, 0, p.counterH - 250, { label: 'Stool' });
        }
      }
    }

    // ---- automatic sink window, beams over thresholds, wall segments for Archicad
    if (sinkWindow) {
      const run = runs[sinkWindow.run], wall = run.wall;
      const [x, y] = at(run, sinkWindow.s, 0);
      const ac = wall === 'back' || wall === 'front' ? x : y;
      const sill = p.counterH + 150;
      const h = Math.min(p.windowH, p.wallH - sill - 150);
      if (h > 300) {
        const len = wall === 'back' || wall === 'front' ? W : D;
        const a0 = ac - sinkWindow.w / 2;
        openings.push({ id: 'W-sink', kind: 'window', wall, a0: r1(a0), a1: r1(a0 + sinkWindow.w), offset: r1(ac + t / 2), w: sinkWindow.w, h, sill,
          from: 'start', fromStart: Math.round(a0), fromEnd: Math.round(len - a0 - sinkWindow.w), auto: true });
      }
    }
    const beams = [];
    for (const o of openings.filter((x) => x.kind === 'threshold')) {
      const w = wallById[o.wall];
      const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1), ux = (w.x2 - w.x1) / len, uy = (w.y2 - w.y1) / len;
      const d0 = Math.max(0, o.a0 + t / 2 - o.bearing), d1 = Math.min(len, o.a1 + t / 2 + o.bearing);
      beams.push({ id: `B-${o.id}`, opening: o.id, wall: o.wall,
        x1: r1(w.x1 + ux * d0), y1: r1(w.y1 + uy * d0), x2: r1(w.x1 + ux * d1), y2: r1(w.y1 + uy * d1),
        w: o.beamW, d: o.beamD, z: p.wallH - o.beamD, top: p.wallH });
    }
    // Each wall is split at its thresholds: the pieces either side are walls, the
    // beam spans the gap. Distances are measured from the wall's start point.
    for (const w of walls) {
      const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      const cuts = mergeIntervals(openings.filter((o) => o.wall === w.id && o.kind === 'threshold').map((o) => [o.a0 + t / 2, o.a1 + t / 2]));
      w.segments = gaps(0, len, cuts).map(([a, b]) => [r1(a), r1(b)]);
    }

    // ---- work triangle (front-centre of each appliance)
    const tri = {};
    for (const k of ['sink', 'cooktop', 'fridge', 'prepSink']) {
      const q = placed[k];
      if (!q) continue;
      const run = runs[q.run];
      const [x, y] = at(run, q.s, bd + (k === 'fridge' ? 30 : 0));
      tri[k] = { x: r1(x), y: r1(y) };
    }
    // with a prep sink the triangle uses whichever sink makes it shorter
    if (tri.prepSink && tri.cooktop && tri.fridge && tri.sink) {
      const per = (q) => Math.hypot(q.x - tri.cooktop.x, q.y - tri.cooktop.y) + Math.hypot(q.x - tri.fridge.x, q.y - tri.fridge.y);
      if (per(tri.prepSink) < per(tri.sink)) { tri.mainSink = tri.sink; tri.sink = tri.prepSink; }
    }
    delete tri.prepSink;
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const legs = tri.sink && tri.cooktop && tri.fridge ? {
      sinkCook: Math.round(dist(tri.sink, tri.cooktop)),
      cookFridge: Math.round(dist(tri.cooktop, tri.fridge)),
      fridgeSink: Math.round(dist(tri.fridge, tri.sink)),
    } : null;
    const triangle = { points: tri, legs, total: legs ? legs.sinkCook + legs.cookFridge + legs.fridgeSink : 0 };

    // where the sink really is: centre along its wall from both corners (island/peninsula: from the run ends)
    let sinkPlacement = null;
    if (placed.sink) {
      const run = runs[placed.sink.run];
      const [x, y] = at(run, placed.sink.s, 0);
      // "under" is decided from where the sink really ended up, not from where it was aimed
      sinkUnder = null;
      if (!run.freestanding) {
        const a = run.wall === 'back' || run.wall === 'front' ? x : y;
        const win = openings.find((o) => o.kind === 'window' && o.wall === run.wall && a >= o.a0 && a <= o.a1);
        if (win) sinkUnder = win.id;
      }
      if (run.freestanding) {
        sinkPlacement = { run: run.id, wall: null, fromStart: Math.round(placed.sink.s), fromEnd: Math.round(run.length - placed.sink.s) };
      } else {
        const len = run.wall === 'back' || run.wall === 'front' ? W : D;
        const a = run.wall === 'back' || run.wall === 'front' ? x : y;
        sinkPlacement = { run: run.id, wall: run.wall, fromStart: Math.round(a), fromEnd: Math.round(len - a) };
      }
      Object.assign(sinkPlacement, { under: sinkUnder, moved: sinkMoved, mode: p.sinkMode, width: placed.sink.w });
    }
    const model = { version: 2, units: 'mm', params: p, assigned, sinkUnder, sinkPlacement, runs: Object.values(runs).map(publicRun), walls, openings, beams, boxes, triangle, notes };
    model.checks = validate(model, runs, { cooktopLanding, sinkLanding });
    model.stats = stats(model);
    model.schedule = schedule(boxes);
    return model;
  }

  function publicRun(r) {
    const { id, label, ox, oy, ux, uy, nx, ny, length, freestanding, wall } = r;
    return { id, label, ox, oy, ux, uy, nx, ny, length: r1(length), freestanding, wall };
  }

  // free worktop either side of a segment, up to tall units or the run ends
  function landing(run, g, segs, tallIv) {
    let left = g.s0, right = run.length - g.s1;
    for (const [a, b] of tallIv) {
      if (b <= g.s0 + 1e-6) left = Math.min(left, g.s0 - b);
      if (a >= g.s1 - 1e-6) right = Math.min(right, a - g.s1);
    }
    return { run: run.id, left: Math.round(left), right: Math.round(right) };
  }

  // ---------------------------------------------------------------- checks

  function validate(model, runs, extra) {
    const p = model.params, bd = p.baseDepth, W = p.roomW, D = p.roomD;
    const out = [];
    const add = (level, msg) => out.push({ level, msg });
    for (const n of model.notes) if (typeof n === 'string') add('warn', n); else add(n.level, n.msg);

    // Work triangle — NKBA guideline: each leg 1.2–2.7 m, total ≤ 7.9 m
    const tr = model.triangle;
    if (tr.legs) {
      const names = { sinkCook: 'Sink–cooktop', cookFridge: 'Cooktop–fridge', fridgeSink: 'Fridge–sink' };
      for (const [k, v] of Object.entries(tr.legs)) {
        if (v < 1200) add('warn', `${names[k]} leg is ${(v / 1000).toFixed(2)} m (< 1.2 m guideline).`);
        else if (v > 2700) add('warn', `${names[k]} leg is ${(v / 1000).toFixed(2)} m (> 2.7 m guideline).`);
      }
      if (tr.total > 7900) add('warn', `Work triangle totals ${(tr.total / 1000).toFixed(2)} m (> 7.9 m).`);
      else if (tr.total < 4000) add('warn', `Work triangle totals ${(tr.total / 1000).toFixed(2)} m — compact; check landing space.`);
      else add('ok', `Work triangle ${(tr.total / 1000).toFixed(2)} m — within 4.0–7.9 m.`);
    }

    // Aisles
    const aisle = (label, v, min = 1050, hard = 900) => {
      if (v < hard) add('error', `${label} is ${v} mm (min ${hard}).`);
      else if (v < min) add('warn', `${label} is ${v} mm (recommended ≥ ${min}).`);
      else add('ok', `${label}: ${v} mm.`);
    };
    const R = runs;
    if (R.front && p.layout === 'galley') {
      const v = D - 2 * bd;
      aisle('Galley aisle', v, 1050, 900);
      if (v > 1800) add('warn', `Galley aisle ${v} mm is wide — consider an island layout.`);
    }
    if (R.left && R.right) aisle('Between left and right legs', W - 2 * bd, 1050, 900);
    if (p.layout === 'g-shape') aisle('Peninsula to back run', Math.round(R.left.length + bd - 2 * bd), 1050, 900);
    if (p.layout === 'peninsula') {
      aisle('Peninsula to left run', Math.round(R.peninsula.ox - bd - bd), 1050, 900);
      if (p.overhang >= 200) aisle('Seating side of peninsula', Math.round(W - R.peninsula.ox - p.overhang), 900, 600);
    }
    if (R.island) {
      const isl = R.island;
      aisle('Island to back run (cabinet faces)', Math.round(p.aisle), 1050, 900);
      const behind = Math.round(isl.oy - p.overhang - (R.front ? bd + p.nosing : 0));
      aisle('Behind island seating', behind, p.overhang >= 200 ? 1100 : 900, 750);
      const x0 = isl.ox, x1 = isl.ox + isl.length;
      const legReach = (r) => r && r.oy - r.length < isl.oy + bd + p.nosing; // the leg extends alongside the island
      if (R.left && legReach(R.left)) aisle('Island to left run', Math.round(x0 - bd), 1050, 900);
      else if (x0 < 900) aisle('Island end clearance (left)', Math.round(x0), 900, 750);
      if (R.right && legReach(R.right)) aisle('Island to right run', Math.round(W - bd - x1), 1050, 900);
      else if (W - x1 < 900) aisle('Island end clearance (right)', Math.round(W - x1), 900, 750);
    }

    // Landing areas — NKBA: ≥ 300/380 mm beside a cooktop, ≥ 600 + 450 beside a sink
    for (const l of extra.cooktopLanding) {
      if (Math.min(l.left, l.right) < 300) add('warn', `Cooktop has only ${Math.min(l.left, l.right)} mm worktop on one side (≥ 300 recommended).`);
    }
    for (const l of extra.sinkLanding) {
      if (Math.max(l.left, l.right) < 600) add('warn', `Sink needs ≥ 600 mm of worktop on at least one side.`);
    }

    // Openings: overlaps, piers, headroom, and what stands in front of them
    const solids = model.boxes.filter((b) => ['base', 'corner', 'sinkBase', 'cookBase', 'dishwasher', 'fridge', 'pantry', 'filler', 'counter'].includes(b.kind));
    const byWall = {};
    for (const o of model.openings) (byWall[o.wall] = byWall[o.wall] || []).push(o);
    for (const list of Object.values(byWall)) {
      list.sort((a, b) => a.a0 - b.a0);
      for (let i = 1; i < list.length; i++) {
        const gap = list[i].a0 - list[i - 1].a1;
        if (gap < 0) add('error', `${list[i - 1].id} and ${list[i].id} overlap on the ${list[i].wall} wall.`);
        else if (gap < 100) add('warn', `Only ${Math.round(gap)} mm of wall between ${list[i - 1].id} and ${list[i].id} (≥ 100 for a frame).`);
      }
    }
    const zone = (o, depth) => (o.wall === 'back' ? [o.a0, D - depth, o.a1, D] : o.wall === 'front' ? [o.a0, 0, o.a1, depth] // in front of an opening
      : o.wall === 'left' ? [0, o.a0, depth, o.a1] : [W - depth, o.a0, W, o.a1]);
    let doorsClear = true;
    for (const o of model.openings) {
      if (o.kind === 'door' && o.swing === 'in') {
        const hit = solids.find((b) => b.kind !== 'counter' && overlaps(zone(o, o.w), aabb(b)));
        if (hit) { add('error', `${o.id} swing clashes with ${hit.label.toLowerCase()}.`); doorsClear = false; }
      }
      if (o.kind === 'door' || o.kind === 'threshold') {
        const hit = solids.find((b) => overlaps(zone(o, 600), aabb(b)));
        if (hit && !(o.kind === 'door' && o.swing === 'in' && !doorsClear)) { add('error', `${o.id} passage is blocked by ${hit.label.toLowerCase()}.`); doorsClear = false; }
        if (o.h < 2000) add('warn', `${o.id} clear height is ${o.h} mm (< 2000 headroom).`);
      }
      if (o.kind === 'threshold') add('ok', `${o.id}: ${o.w} mm passage, beam ${o.beamW}×${o.beamD} mm at ${o.h} mm.`);
      if (o.kind === 'window') {
        if (o.sill < p.counterH + 10 && !o.auto) add('warn', `${o.id} sill (${o.sill} mm) is below the worktop — no base units in front of it.`);
        // a tall unit within cabinet depth of the window wall, across the window, really blocks it
        const tall = model.boxes.find((b) => (b.kind === 'fridge' || b.kind === 'pantry') && overlaps(zone(o, bd - 1), aabb(b)));
        if (tall) add('error', `${tall.label} stands in front of ${o.id}.`);
      }
    }
    if (model.sinkUnder) add('ok', `Sink centred under ${model.sinkUnder}.`);
    for (const h of model.boxes.filter((b) => b.kind === 'hood' && b.label === 'Hood')) { // wall-hung hood in front of a window
      const hb = aabb(h);
      const win = model.openings.find((o) => o.kind === 'window' && overlaps(zone(o, 520), hb) && o.sill + o.h > h.z);
      if (win) add('warn', `The cooktop hood stands in front of ${win.id}.`);
    }
    const walled = model.walls.length === 4;
    if (walled && !model.openings.some((o) => o.kind === 'door' || o.kind === 'threshold')) {
      add('warn', 'The room has no door or passage — add the entry in Openings so the cabinets keep it clear.');
    }
    if (doorsClear && model.openings.some((o) => o.kind === 'door' || o.kind === 'threshold')) add('ok', 'Doors and passages are clear of cabinets.');

    if (model.boxes.some((b) => !Number.isFinite(b.cx + b.cy + b.L + b.D + b.H))) add('error', 'Invalid geometry generated.');
    return out;
  }

  function aabb(b) {
    const hx = Math.abs(b.ux) * b.L / 2 + Math.abs(b.nx) * b.D / 2;
    const hy = Math.abs(b.uy) * b.L / 2 + Math.abs(b.ny) * b.D / 2;
    return [b.cx - hx, b.cy - hy, b.cx + hx, b.cy + hy];
  }
  function overlaps(a, b) {
    return a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1;
  }

  // ---------------------------------------------------------------- reports

  function stats(model) {
    const b = model.boxes;
    const count = (kinds) => b.filter((x) => kinds.includes(x.kind)).length;
    const counters = b.filter((x) => x.kind === 'counter');
    return {
      baseUnits: count(['base', 'corner', 'sinkBase', 'cookBase']),
      wallUnits: count(['wallCab']),
      tallUnits: count(['fridge', 'pantry']),
      worktopLength: Math.round(counters.reduce((a, x) => a + x.L, 0)),
      worktopArea: Math.round(counters.reduce((a, x) => a + x.L * x.D, 0) / 1e4) / 100,
      seats: count(['stool']),
      floorArea: Math.round(model.params.roomW * model.params.roomD / 1e4) / 100,
    };
  }

  function schedule(boxes) {
    const rows = new Map();
    for (const b of boxes) {
      if (!b.code) continue;
      const key = `${b.code}|${b.D}|${b.H}`;
      const r = rows.get(key) || { code: b.code, description: b.label.replace(/\s\d+$/, ''), width: b.w, depth: Math.round(b.D), height: Math.round(b.H), qty: 0, category: b.cat };
      r.qty++;
      rows.set(key, r);
    }
    const order = ['B', 'BC', 'SB', 'CB', 'DW', 'FL', 'W', 'WF', 'T', 'F'];
    return [...rows.values()].sort((a, b) => {
      const pa = order.indexOf(a.code.replace(/\d+$/, '')), pb = order.indexOf(b.code.replace(/\d+$/, ''));
      return pa - pb || a.width - b.width;
    });
  }

  // The site: room size, walls and openings. Once fixed, layouts, the island
  // and resets never change these; the kitchen is generated around them.
  const ROOM_KEYS = ['roomW', 'roomD', 'wallH', 'wallT', 'openEnds', 'openings', 'originX', 'originY', 'acFloor', 'acWalls', 'siteSource'];

  // A layout's starting parameters for a given (fixed) room: the room keys are
  // left alone and leg / peninsula lengths scale with the room they were drawn for.
  function layoutDefaults(layout, room) {
    const def = JSON.parse(JSON.stringify((LAYOUTS[layout] || LAYOUTS[DEFAULTS.layout]).defaults));
    if (!room) return def;
    const W0 = def.roomW || DEFAULTS.roomW, D0 = def.roomD || DEFAULTS.roomD;
    const W = room.roomW || W0, D = room.roomD || D0;
    const scale = (v, k, lo, hi) => clamp(Math.round((v * k) / 50) * 50, lo, hi);
    if (def.legLeft) def.legLeft = scale(def.legLeft, D / D0, 1200, D);
    if (def.legRight) def.legRight = scale(def.legRight, D / D0, 1200, D);
    if (def.pensLen) def.pensLen = layout === 'g-shape' ? scale(def.pensLen, W / W0, 600, W) : scale(def.pensLen, D / D0, 600, D);
    for (const k of ROOM_KEYS) delete def[k];
    return def;
  }

  // Parameter patch that sizes and centres an island so every aisle meets the
  // recommended clearance. With fixedRoom the room is never enlarged: the
  // island shrinks to fit, or { fail } explains why it cannot.
  function fitIsland(input, opts) {
    const fixed = !!(opts && opts.fixedRoom);
    const p = normalise(Object.assign({}, input, { island: true }));
    const runs = LAYOUTS[p.layout].runs, bd = p.baseDepth, clear = 1100;
    const leftM = runs.includes('left') ? bd + clear : 1000;
    const rightM = runs.includes('right') ? bd + clear : 1000;
    const patch = { island: true };
    const needD = 2 * bd + Math.max(p.aisle, 1050) + p.overhang + 1100 + (runs.includes('front') ? bd + p.nosing : 0);
    const minLen = 1200;
    if (fixed) {
      if (p.roomD < needD) return { fail: `The room is ${p.roomD} mm deep; an island needs ${needD} mm (cabinets, ${Math.max(p.aisle, 1050)} aisle, seating and a walkway).` };
      if (p.roomW - leftM - rightM < minLen) return { fail: `The room is ${p.roomW} mm wide; an island of ${minLen} mm with clear aisles needs ${leftM + rightM + minLen} mm.` };
    }
    if (p.roomD < needD) patch.roomD = Math.ceil(needD / 100) * 100;
    let W = p.roomW;
    if (W - leftM - rightM < minLen) W = patch.roomW = Math.ceil((leftM + rightM + minLen) / 100) * 100;
    patch.islandLen = Math.min(Math.max(p.islandLen, minLen), Math.floor((W - leftM - rightM) / 50) * 50);
    patch.islandOffset = Math.round((leftM - rightM) / 2);
    return patch;
  }

  function runOptions(layout, island) {
    const ids = LAYOUTS[layout] ? LAYOUTS[layout].runs.slice() : [];
    if (island && LAYOUTS[layout] && LAYOUTS[layout].island) ids.push('island');
    return ids.map((id) => ({ id, label: RUN_LABELS[id], freestanding: id === 'island' || id === 'peninsula' }));
  }

  return { DEFAULTS, LAYOUTS, RUN_LABELS, CAT, ROOM_KEYS, normalise, generate, layoutDefaults, fitIsland, runOptions, aabb };
});

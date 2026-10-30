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
    doorWall: 'front', doorPos: 0.75, doorW: 900, doorH: 2100,

    // Base cabinets & worktop
    counterH: 900, counterT: 30, baseDepth: 600, plinthH: 100, nosing: 20, moduleMax: 600,

    // Wall & tall cabinets
    wallCabs: true, wallCabH: 720, wallCabDepth: 350, wallCabElev: 1450,
    tallH: 2200, pantryCount: 0,

    // Run geometry
    legLeft: 2700, legRight: 2100, pensLen: 1800, pensPos: 0.72, overhang: 300,
    islandLen: 2000, islandOffset: 0, aisle: 1100, stoolSpacing: 600,

    // Appliances (run id + position 0..1 along the usable run length)
    sinkRun: 'back', sinkPos: 0.75, sinkW: 900, dwSide: 'right',
    cookRun: 'back', cookPos: 0.1, cookW: 600,
    fridgeRun: 'left', fridgePos: 1, fridgeW: 700,
    windowOverSink: true, windowW: 1200, windowH: 1100,

    // Finish (used by the viewer only)
    frontColor: '#e8e2d6', counterColor: '#3d3b38', wallColor: '#f4f2ee', floorColor: '#d9cfc0',
  };

  const RUN_LABELS = {
    back: 'Back wall', left: 'Left wall', right: 'Right wall', front: 'Front wall',
    peninsula: 'Peninsula', island: 'Island',
  };

  // Runs available per layout, plus the appliance placement a layout starts with.
  const LAYOUTS = {
    'one-wall': {
      label: 'One-wall', island: true, runs: ['back'],
      defaults: { sinkRun: 'back', sinkPos: 0.5, cookRun: 'back', cookPos: 0.85, fridgeRun: 'back', fridgePos: 0.02, roomW: 4200, roomD: 3000, doorWall: 'front', doorPos: 0.5 },
    },
    galley: {
      label: 'Galley', island: false, runs: ['back', 'front'],
      defaults: { sinkRun: 'back', sinkPos: 0.5, cookRun: 'front', cookPos: 0.5, fridgeRun: 'back', fridgePos: 0.02, roomW: 4200, roomD: 2400, openEnds: true, doorWall: 'left', doorPos: 0.5 },
    },
    'l-shape': {
      label: 'L-shaped', island: true, runs: ['back', 'left'],
      defaults: { sinkRun: 'back', sinkPos: 0.75, cookRun: 'back', cookPos: 0.1, fridgeRun: 'left', fridgePos: 1, roomW: 4200, roomD: 3600, legLeft: 2700, doorWall: 'front', doorPos: 0.8 },
    },
    'u-shape': {
      label: 'U-shaped', island: true, runs: ['back', 'left', 'right'],
      defaults: { sinkRun: 'back', sinkPos: 0.5, cookRun: 'left', cookPos: 0.5, fridgeRun: 'right', fridgePos: 0.6, roomW: 4000, roomD: 3600, legLeft: 2700, legRight: 2400, doorWall: 'front', doorPos: 0.5 },
    },
    'g-shape': {
      label: 'G-shaped', island: false, runs: ['back', 'left', 'right', 'peninsula'],
      defaults: { sinkRun: 'back', sinkPos: 0.5, cookRun: 'left', cookPos: 0.35, fridgeRun: 'right', fridgePos: 0.4, roomW: 4000, roomD: 4200, legLeft: 2900, legRight: 1500, pensLen: 2000, doorWall: 'right', doorPos: 0.25 },
    },
    peninsula: {
      label: 'Peninsula', island: false, runs: ['back', 'left', 'peninsula'],
      defaults: { sinkRun: 'peninsula', sinkPos: 0.55, cookRun: 'back', cookPos: 0.5, fridgeRun: 'left', fridgePos: 0.95, roomW: 4800, roomD: 3600, legLeft: 2400, pensLen: 1800, pensPos: 0.72, doorWall: 'front', doorPos: 0.88 },
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
    for (const k of ['sinkPos', 'cookPos', 'fridgePos', 'doorPos', 'pensPos']) p[k] = clamp(p[k], 0, 1);
    p.island = p.island && LAYOUTS[p.layout].island;
    return p;
  }

  // ---------------------------------------------------------------- runs

  function makeRun(id, ox, oy, ux, uy, nx, ny, length, opts) {
    return Object.assign({
      id, label: RUN_LABELS[id], ox, oy, ux, uy, nx, ny, length: Math.max(0, length),
      freestanding: false, startCorner: 0, endCorner: 0,
      counterStart: 0, wallCabStart: 0, wall: null,
    }, opts || {});
  }

  function buildRuns(p, notes) {
    const W = p.roomW, D = p.roomD, bd = p.baseDepth, wcd = p.wallCabDepth;
    const has = new Set(LAYOUTS[p.layout].runs);
    const runs = {};
    const cornerAttached = { counterStart: p.nosing, wallCabStart: -(bd - wcd), startCorner: 0 };

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

    if (has.has('left')) {
      runs.left = makeRun('left', 0, D - bd, 0, -1, 1, 0, legL - bd, Object.assign({}, cornerAttached, {
        wall: 'left', endCorner: p.layout === 'g-shape' ? bd : 0,
      }));
    }
    if (has.has('right')) {
      runs.right = makeRun('right', W, D - bd, 0, -1, -1, 0, legR - bd, Object.assign({}, cornerAttached, { wall: 'right' }));
    }
    if (has.has('front')) {
      runs.front = makeRun('front', W, 0, -1, 0, 0, 1, W, { wall: 'front' });
    }
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
    }
    return runs;
  }

  // run coordinates -> world
  function at(run, s, t) {
    return [run.ox + s * run.ux + t * run.nx, run.oy + s * run.uy + t * run.ny];
  }

  // ---------------------------------------------------------------- run filling

  // items: [{key, w, s}] with s = desired centre. Returns resolved centres; mutates.
  function resolveItems(run, items, notes) {
    let lo = run.startCorner, hi = run.length - run.endCorner;
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
      lo = 0; hi = run.length;
      notes.push(`${run.label}: appliances pushed into the corner zone.`);
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
    const posOf = (run, f, w) => {
      const [lo, hi] = usable(run);
      return lo + w / 2 + f * Math.max(0, hi - lo - w);
    };
    // the viewer's right hand when facing the run, expressed as +1 (along u) or -1
    const rightSign = (run) => (-run.ny * run.ux + run.nx * run.uy > 0 ? 1 : -1);

    {
      const run = runs[sinkRun];
      const parts = [{ kind: 'sink', w: p.sinkW }];
      if (p.dwSide !== 'none') {
        const after = (p.dwSide === 'right') === (rightSign(run) > 0);
        if (after) parts.push({ kind: 'dishwasher', w: 600 });
        else parts.unshift({ kind: 'dishwasher', w: 600 });
      }
      const w = parts.reduce((a, q) => a + q.w, 0);
      itemsByRun[sinkRun].push({ key: 'sink', parts, w, s: posOf(run, p.sinkPos, w) });
    }
    {
      const run = runs[cookRun];
      itemsByRun[cookRun].push({ key: 'cook', parts: [{ kind: 'cooktop', w: p.cookW }], w: p.cookW, s: posOf(run, p.cookPos, p.cookW) });
    }
    {
      const run = runs[fridgeRun];
      const parts = [{ kind: 'fridge', w: p.fridgeW, tall: true }];
      const s0 = posOf(run, p.fridgePos, p.fridgeW);
      const towardEnd = s0 < run.length / 2;
      for (let i = 0; i < p.pantryCount; i++) {
        const q = { kind: 'pantry', w: 600, tall: true };
        if (towardEnd) parts.push(q); else parts.unshift(q);
      }
      const w = parts.reduce((a, q) => a + q.w, 0);
      const fOff = parts.slice(0, parts.findIndex((q) => q.kind === 'fridge')).reduce((a, q) => a + q.w, 0) + p.fridgeW / 2;
      itemsByRun[fridgeRun].push({ key: 'fridge', parts, w, s: s0 - fOff + w / 2 });
    }

    const placed = {}; // kind -> {run, s, w}
    const cooktopLanding = [];
    const sinkLanding = [];

    // ---- per run
    for (const id of runIds) {
      const run = runs[id];
      const items = resolveItems(run, itemsByRun[id], notes);

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

      // fill gaps with base cabinets
      const fixedIv = segs.map((g) => [g.s0, g.s1]);
      const baseSegs = segs.slice();
      for (const [a, b] of gaps(0, run.length, fixedIv)) {
        let s = a;
        const fillerFirst = a < 1 && b < run.length - 1; // gap starts at the run end
        const mods = modules(b - a, p.moduleMax, 150, fillerFirst);
        // widest unit towards the run end the gap touches (for the corner unit)
        if (b > run.length - 1 && a > 1) mods.sort((x, y) => (x.filler - y.filler) || (x.w - y.w));
        // the first/last real unit of a gap that reaches a cornered run end is the blind corner unit
        const units = mods.filter((m) => !m.filler);
        if (units.length && a < 1 && run.startCorner > 0) units[0].corner = true;
        if (units.length && b > run.length - 1 && run.endCorner > 0) units[units.length - 1].corner = true;
        for (const m of mods) {
          baseSegs.push({ kind: m.filler ? 'filler' : m.corner ? 'corner' : 'base', s0: s, s1: s + m.w });
          s += m.w;
        }
      }
      baseSegs.sort((x, y) => x.s0 - y.s0);

      for (const g of baseSegs) {
        const w = g.s1 - g.s0;
        const ins = 1.5; // visual joint between fronts
        if (g.tall) {
          const isFridge = g.kind === 'fridge';
          box(run, g.kind, isFridge ? CAT.APP : CAT.CAB, g.s0 + ins, g.s1 - ins, 0, bd + (isFridge ? 30 : 0), p.plinthH, p.tallH,
            { label: isFridge ? `Fridge ${Math.round(w)}` : `Tall pantry ${Math.round(w)}`, w: Math.round(w), code: isFridge ? `F${Math.round(w)}` : `T${Math.round(w)}` });
        } else if (g.kind === 'filler') {
          box(run, 'filler', CAT.CAB, g.s0, g.s1, 0, bd, p.plinthH, carcassTop, { label: `Filler ${Math.round(w)}`, w: Math.round(w), code: `FL${Math.round(w)}` });
        } else {
          const codes = { base: 'B', corner: 'BC', sink: 'SB', dishwasher: 'DW', cooktop: 'CB' };
          const labels = { base: 'Base', corner: 'Blind corner base', sink: 'Sink base', dishwasher: 'Dishwasher', cooktop: 'Cooktop / oven base' };
          box(run, g.kind === 'dishwasher' ? 'dishwasher' : g.kind === 'sink' ? 'sinkBase' : g.kind === 'cooktop' ? 'cookBase' : g.kind, g.kind === 'dishwasher' || g.kind === 'cooktop' ? CAT.APP : CAT.CAB,
            g.s0 + ins, g.s1 - ins, 0, bd, p.plinthH, carcassTop,
            { label: `${labels[g.kind]} ${Math.round(w)}`, w: Math.round(w), code: `${codes[g.kind]}${Math.round(w)}` });
        }
        // plinth (recessed)
        if (p.plinthH > 0) box(run, 'plinth', CAT.CAB, g.s0, g.s1, run.freestanding ? 60 : 0, bd - 60, 0, p.plinthH, { label: 'Plinth' });
      }

      // worktop over non-tall stretches
      const tallIv = mergeIntervals(segs.filter((g) => g.tall).map((g) => [g.s0, g.s1]));
      const back = run.freestanding ? -p.overhang : 0;
      const topRuns = gaps(run.counterStart, run.length, tallIv);
      for (const [a, b] of topRuns) {
        box(run, 'counter', CAT.TOP, a, b, back, bd + p.nosing, carcassTop, p.counterH, { label: 'Worktop' });
      }
      if (run.freestanding) {
        box(run, 'panel', CAT.CAB, run.counterStart, run.length, -18, 0, 0, carcassTop, { label: 'Back panel' });
      }

      // sink bowl & cooktop on the worktop; hood above the cooktop
      for (const g of segs) {
        const c = (g.s0 + g.s1) / 2, w = g.s1 - g.s0;
        if (g.kind === 'sink') {
          const bw = Math.min(w - 120, 820);
          box(run, 'sinkBowl', CAT.APP, c - bw / 2, c + bw / 2, 80, bd - 80, p.counterH - 4, p.counterH + 2, { label: 'Sink', bowls: bw > 650 ? 2 : 1 });
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

      // wall cabinets
      if (p.wallCabs && !run.freestanding) {
        const blocked = segs.filter((g) => g.tall).map((g) => [g.s0, g.s1]);
        const cook = segs.find((g) => g.kind === 'cooktop');
        if (cook) {
          const c = (cook.s0 + cook.s1) / 2, hw = Math.max(600, cook.s1 - cook.s0);
          blocked.push([c - hw / 2, c + hw / 2]);
        }
        const sink = segs.find((g) => g.kind === 'sink');
        if (sink && p.windowOverSink) {
          const c = (sink.s0 + sink.s1) / 2;
          blocked.push([c - p.windowW / 2 - 50, c + p.windowW / 2 + 50]);
        }
        const z0 = p.wallCabElev, z1 = p.wallCabElev + p.wallCabH;
        for (const [a, b] of gaps(run.wallCabStart, run.length, mergeIntervals(blocked))) {
          if (b - a < 200) continue;
          let s = a;
          for (const m of modules(b - a, p.moduleMax, 300, a < run.wallCabStart + 1 && b < run.length - 1)) {
            if (!m.filler) box(run, 'wallCab', CAT.CAB, s + 1.5, s + m.w - 1.5, 0, p.wallCabDepth, z0, z1,
              { label: `Wall ${Math.round(m.w)}`, w: Math.round(m.w), code: `W${Math.round(m.w)}` });
            else if (m.w >= 20) box(run, 'wallFiller', CAT.CAB, s, s + m.w, 0, p.wallCabDepth, z0, z1,
              { label: `Wall filler ${Math.round(m.w)}`, w: Math.round(m.w), code: `WF${Math.round(m.w)}` });
            s += m.w;
          }
        }
      }

      // stools along freestanding runs
      if (run.freestanding && p.overhang >= 200) {
        const avail = run.length - run.counterStart - 150;
        const n = Math.max(0, Math.floor(avail / p.stoolSpacing));
        const pitch = n ? avail / n : 0;
        for (let i = 0; i < n; i++) {
          const s = run.counterStart + 75 + pitch * (i + 0.5);
          box(run, 'stool', CAT.FURN, s - 190, s + 190, -p.overhang - 230, -p.overhang + 150, 0, p.counterH - 250, { label: 'Stool' });
        }
      }
    }

    // ---- walls, door, window
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
    const wallLen = (w) => Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    const project = (w, x, y) => {
      const L = wallLen(w);
      return ((x - w.x1) * (w.x2 - w.x1) + (y - w.y1) * (w.y2 - w.y1)) / L;
    };

    const doorWall = wallById[p.doorWall] || null;
    if (doorWall) {
      const inner = p.doorWall === 'back' || p.doorWall === 'front' ? W : D;
      const pos = clamp(p.doorPos * inner, p.doorW / 2 + 100, inner - p.doorW / 2 - 100);
      const offset = pos + t / 2; // all walls start at the outer corner (-t/2)
      openings.push({ id: 'door-1', kind: 'door', wall: doorWall.id, offset: r1(offset), w: p.doorW, h: Math.min(p.doorH, p.wallH - 100), sill: 0 });
    }
    const sinkP = placed.sink;
    if (p.windowOverSink && sinkP && !runs[sinkP.run].freestanding) {
      const run = runs[sinkP.run];
      const w = wallById[run.wall];
      if (w) {
        const [x, y] = at(run, sinkP.s, 0);
        const sill = p.counterH + 150;
        const h = Math.min(p.windowH, p.wallH - sill - 150);
        if (h > 300) openings.push({ id: 'window-1', kind: 'window', wall: w.id, offset: r1(project(w, x, y)), w: p.windowW, h, sill });
      }
    }

    // ---- work triangle (front-centre of each appliance)
    const tri = {};
    for (const k of ['sink', 'cooktop', 'fridge']) {
      const q = placed[k];
      if (!q) continue;
      const run = runs[q.run];
      const [x, y] = at(run, q.s, bd + (k === 'fridge' ? 30 : 0));
      tri[k] = { x: r1(x), y: r1(y) };
    }
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const legs = tri.sink && tri.cooktop && tri.fridge ? {
      sinkCook: Math.round(dist(tri.sink, tri.cooktop)),
      cookFridge: Math.round(dist(tri.cooktop, tri.fridge)),
      fridgeSink: Math.round(dist(tri.fridge, tri.sink)),
    } : null;
    const triangle = { points: tri, legs, total: legs ? legs.sinkCook + legs.cookFridge + legs.fridgeSink : 0 };

    const model = { version: 1, units: 'mm', params: p, assigned, runs: Object.values(runs).map(publicRun), walls, openings, boxes, triangle, notes };
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
    for (const n of model.notes) add('warn', n);

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
    if (R.front) {
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
      const behind = Math.round(isl.oy - p.overhang);
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

    // Door swing clashes with cabinets (axis-aligned footprints)
    const door = model.openings.find((o) => o.kind === 'door');
    if (door) {
      const wall = model.walls.find((w) => w.id === door.wall);
      const t = p.wallT;
      const along = door.offset - t / 2; // distance from interior corner
      let rect;
      if (wall.id === 'front') rect = [along - door.w / 2, 0, along + door.w / 2, door.w];
      if (wall.id === 'back') rect = [along - door.w / 2, D - door.w, along + door.w / 2, D];
      if (wall.id === 'left') rect = [0, along - door.w / 2, door.w, along + door.w / 2];
      if (wall.id === 'right') rect = [W - door.w, along - door.w / 2, W, along + door.w / 2];
      const hit = model.boxes.filter((b) => ['base', 'corner', 'sinkBase', 'cookBase', 'dishwasher', 'fridge', 'pantry', 'filler'].includes(b.kind))
        .find((b) => overlaps(rect, aabb(b)));
      if (hit) add('error', `Door swing on ${wall.id} wall clashes with ${hit.label.toLowerCase()}.`);
      else add('ok', 'Door swing is clear of cabinets.');
    }

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

  // Parameter patch that sizes and centres an island so every aisle meets the
  // recommended clearance, growing the room when it is too small.
  function fitIsland(input) {
    const p = normalise(Object.assign({}, input, { island: true }));
    const runs = LAYOUTS[p.layout].runs, bd = p.baseDepth, clear = 1100;
    const leftM = runs.includes('left') ? bd + clear : 1000;
    const rightM = runs.includes('right') ? bd + clear : 1000;
    const patch = { island: true };
    const needD = 2 * bd + Math.max(p.aisle, 1050) + p.overhang + 1100;
    if (p.roomD < needD) patch.roomD = Math.ceil(needD / 100) * 100;
    const minLen = 1200;
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

  return { DEFAULTS, LAYOUTS, RUN_LABELS, CAT, normalise, generate, fitIsland, runOptions, aabb };
});

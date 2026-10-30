#!/usr/bin/env node
// Sanity checks for generator.js across every layout: finite geometry, boxes
// inside the room, no two cabinets of the same level overlapping.
// Usage: node tools/check.js
'use strict';
const G = require('../generator.js');

const SOLID = ['base', 'corner', 'sinkBase', 'cookBase', 'dishwasher', 'filler', 'fridge', 'pantry'];
let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL', msg); };

function overlapArea(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 1 && h > 1 ? w * h : 0;
}

const cases = [];
for (const [id, def] of Object.entries(G.LAYOUTS)) {
  cases.push(Object.assign({ layout: id }, def.defaults, { island: false }));
  if (def.island) {
    const base = Object.assign({ layout: id }, def.defaults);
    cases.push(Object.assign(base, G.fitIsland(base), { cookRun: 'island', cookPos: 0.5 }));
  }
  cases.push(Object.assign({ layout: id }, def.defaults, { pantryCount: 2, dwSide: 'left', roomW: 3000, island: false }));
  // every wall gets a door, a threshold or a window, some of them where cabinets would be
  // tall walls with a niche, tops to the ceiling, handleless, oven towers
  cases.push(Object.assign({ layout: id }, def.defaults, { island: false, styleLeft: 'tall', styleRight: 'tall', styleBack: 'base',
    tallNiche: 1200, alignTops: true, handles: 'none', ovenTowers: 2 }));
  cases.push(Object.assign({ layout: id }, def.defaults, { openEnds: false, island: false, openings: [
    { type: 'door', wall: 'back', from: 'start', offset: 700, width: 800 },
    { type: 'threshold', wall: 'right', from: 'start', offset: 200, width: 1200, height: 2200, beamWidth: 250 },
    { type: 'window', wall: 'left', from: 'end', offset: 1000, width: 900, sill: 1050 },
    { type: 'window', wall: 'front', from: 'start', offset: 1200, width: 1000, sill: 600 },
  ] }));
}

for (const c of cases) {
  const m = G.generate(c);
  const label = `${c.layout}${m.params.island ? '+island' : ''} ${m.params.roomW}x${m.params.roomD}`;
  console.log(label, `boxes=${m.boxes.length}`, `triangle=${m.triangle.total}`,
    `checks=${m.checks.filter((x) => x.level !== 'ok').length} issues`);
  const p = m.params;
  for (const b of m.boxes) {
    if (![b.cx, b.cy, b.z, b.L, b.D, b.H].every(Number.isFinite)) fail(`${b.id} non-finite`);
    if (b.L <= 0 || b.D <= 0 || b.H <= 0) fail(`${b.id} non-positive size ${b.L}x${b.D}x${b.H}`);
    const [x0, y0, x1, y1] = G.aabb(b);
    if (b.kind !== 'stool' && (x0 < -1 || y0 < -1 || x1 > p.roomW + 1 || y1 > p.roomD + 1)) fail(`${b.id} (${b.label}) outside room [${x0},${y0},${x1},${y1}]`);
    if (b.z + b.H > p.wallH + 1) fail(`${b.id} above ceiling`);
  }
  const solids = m.boxes.filter((b) => SOLID.includes(b.kind));
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      if (overlapArea(G.aabb(solids[i]), G.aabb(solids[j])) > 100) fail(`${solids[i].label} overlaps ${solids[j].label}`);
    }
  }
  const walls = m.boxes.filter((b) => b.kind === 'wallCab');
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      if (overlapArea(G.aabb(walls[i]), G.aabb(walls[j])) > 100) fail(`${walls[i].label} overlaps ${walls[j].label}`);
    }
  }
  // fronts and handles must not collide with each other or with any cabinet body (3D test)
  const solid3 = m.boxes.filter((b) => SOLID.includes(b.kind) || ['wallCab', 'front', 'handle'].includes(b.kind));
  const box3 = (b) => { const a = G.aabb(b); return [a[0], a[1], b.z, a[2], a[3], b.z + b.H]; };
  const hit3 = (a, b) => a[0] < b[3] - 1 && b[0] < a[3] - 1 && a[1] < b[4] - 1 && b[1] < a[4] - 1 && a[2] < b[5] - 1 && b[2] < a[5] - 1;
  for (const f of m.boxes.filter((b) => b.kind === 'front' || b.kind === 'handle')) {
    const fa = box3(f);
    const other = solid3.find((o) => o !== f && hit3(fa, box3(o)));
    if (other) fail(`${f.label} (${f.id}) collides with ${other.label} (${other.id})`);
  }
  // nothing on the floor in front of a door or threshold on the wall a run stands against
  for (const o of m.openings.filter((x) => x.kind !== 'window' || x.sill < p.counterH)) {
    for (const r of m.runs.filter((r) => r.wall === o.wall)) {
      for (const b of m.boxes.filter((b) => b.run === r.id && [...SOLID, 'counter'].includes(b.kind))) {
        const a = G.aabb(b);
        const along = o.wall === 'back' || o.wall === 'front' ? [a[0], a[2]] : [a[1], a[3]];
        if (along[0] < o.a1 - 1 && along[1] > o.a0 + 1) fail(`${b.label} stands in ${o.id} on the ${o.wall} wall`);
      }
    }
  }
  for (const o of m.openings.filter((x) => x.kind === 'window')) {
    for (const r of m.runs.filter((r) => r.wall === o.wall)) {
      for (const b of m.boxes.filter((b) => b.run === r.id && ['wallCab', 'fridge', 'pantry'].includes(b.kind))) {
        const a = G.aabb(b);
        const along = o.wall === 'back' || o.wall === 'front' ? [a[0], a[2]] : [a[1], a[3]];
        if (along[0] < o.a1 - 1 && along[1] > o.a0 + 1 && b.z < o.sill + o.h && b.z + b.H > o.sill) fail(`${b.label} covers ${o.id}`);
      }
    }
  }
  for (const k of ['sink', 'cooktop', 'fridge']) if (!m.triangle.points[k]) fail(`missing ${k}`);
  if (c.island) m.checks.filter((x) => x.level === 'error').forEach((x) => fail(`fitted island: ${x.msg}`));
}

// A window right at a corner, next to a tall wall: no tall unit may stand across it, and no false alarm
for (const layout of ['l-shape', 'u-shape', 'four-wall']) {
  const m = G.generate(Object.assign({ layout }, G.LAYOUTS[layout].defaults, { island: false, roomW: 5754, roomD: 4704, styleLeft: 'tall', styleRight: 'tall',
    openings: [{ type: 'door', wall: 'front', from: 'start', offset: 2000, width: 900 },
      { type: 'window', wall: 'back', from: 'start', offset: 100, width: 1200, sill: 1050 },
      { type: 'window', wall: 'back', from: 'end', offset: 300, width: 1000, sill: 1050 }] }));
  m.checks.filter((c) => c.level === 'error').forEach((c) => fail(`corner window ${layout}: ${c.msg}`));
}

// A fixed site: every layout keeps the room and openings exactly, nothing blocks a door or passage,
// and the island is fitted inside the room or refused, never by resizing the room.
const sites = [
  { roomW: 3400, roomD: 3100, wallH: 2600, wallT: 200, openEnds: false, openings: [
    { type: 'door', wall: 'left', from: 'start', offset: 300, width: 900 },
    { type: 'window', wall: 'back', from: 'start', offset: 900, width: 1400, sill: 1000 },
    { type: 'threshold', wall: 'front', from: 'end', offset: 250, width: 1400, height: 2150 }] },
  { roomW: 5200, roomD: 4600, wallH: 2800, wallT: 250, openEnds: false, openings: [
    { type: 'door', wall: 'front', from: 'start', offset: 150, width: 1000, swing: 'in', hinge: 'start' },
    { type: 'door', wall: 'right', from: 'end', offset: 200, width: 800, swing: 'in', hinge: 'end' },
    { type: 'window', wall: 'left', from: 'start', offset: 1800, width: 1600, sill: 950 }] },
];
for (const [si, site] of sites.entries()) {
  for (const layout of Object.keys(G.LAYOUTS)) {
    for (const island of [false, true]) {
      if (island && !G.LAYOUTS[layout].island) continue;
      let p = Object.assign({}, G.DEFAULTS, G.layoutDefaults(layout, site), JSON.parse(JSON.stringify(site)), { layout, siteFixed: true, island: false });
      if (island) {
        const fit = G.fitIsland(p, { fixedRoom: true });
        if (fit.roomW || fit.roomD) fail(`site ${si} ${layout}: fitIsland resized the room`);
        if (fit.fail) continue;
        p = Object.assign(p, fit);
      }
      const m = G.generate(p);
      const tag = `site ${si} ${layout}${island ? '+island' : ''}`;
      for (const k of ['roomW', 'roomD', 'wallH', 'wallT']) if (m.params[k] !== site[k]) fail(`${tag}: ${k} changed to ${m.params[k]}`);
      const mine = m.openings.filter((o) => !o.auto);
      if (mine.length !== site.openings.length) fail(`${tag}: ${mine.length} openings instead of ${site.openings.length}`);
      if (m.openings.some((o) => o.auto)) fail(`${tag}: a window was added to a fixed site`);
      site.openings.forEach((o, i) => { if (mine[i] && mine[i].w !== o.width) fail(`${tag}: ${mine[i].id} width changed`); });
      m.checks.filter((c) => c.level === 'error' && /swing|passage|stands in front/.test(c.msg) && !/island/.test(c.msg))
        .forEach((c) => fail(`${tag}: ${c.msg}`));
    }
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);

/*
 * Plan view — draws a generated kitchen model onto a 2D canvas in the style of
 * the reference sheets: dark walls, light worktops, appliance symbols, dashed
 * wall cabinets, door swing, the work triangle and dimension strings.
 */
(function (root) {
  'use strict';

  const C = {
    paper: '#fbfaf7', grid: 'rgba(60,80,110,0.06)', wall: '#2b2a28', counter: '#efe9de', counterEdge: '#8b8478',
    tall: '#d9d3c7', wallCab: '#6e7d8f', appliance: '#55524d', triangle: '#e8742c', dim: '#c0392b', text: '#33312d',
    stool: '#b9b2a6', island: '#f3ede2', window: '#7fb0d6',
  };

  function bounds(model, pad) {
    const p = model.params, t = p.wallT;
    let x0 = -t, y0 = -t, x1 = p.roomW + t, y1 = p.roomD + t;
    for (const b of model.boxes) {
      if (b.kind !== 'stool') continue;
      const a = KitchenGenerator.aabb(b);
      x0 = Math.min(x0, a[0]); y0 = Math.min(y0, a[1]); x1 = Math.max(x1, a[2]); y1 = Math.max(y1, a[3]);
    }
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }

  // corners of an oriented box footprint in world mm
  function footprint(b, shrink = 0) {
    const hl = b.L / 2 - shrink, hd = b.D / 2 - shrink;
    const pts = [[-hl, -hd], [hl, -hd], [hl, hd], [-hl, hd]];
    return pts.map(([a, c]) => [b.cx + a * b.ux + c * b.nx, b.cy + a * b.uy + c * b.ny]);
  }

  function draw(canvas, model, opts) {
    opts = Object.assign({ thumb: false, triangle: true, dims: true, wallCabs: true, labels: true, highlight: null, highlightOpening: null }, opts);
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return null;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = opts.thumb ? 'transparent' : C.paper;
    ctx.clearRect(0, 0, cw, ch);
    if (!opts.thumb) ctx.fillRect(0, 0, cw, ch);

    const pad = opts.thumb ? 80 : opts.dims ? 1050 : 300;
    const [x0, y0, x1, y1] = bounds(model, pad);
    const s = Math.min(cw / (x1 - x0), ch / (y1 - y0));
    const ox = (cw - (x1 - x0) * s) / 2 - x0 * s;
    const oy = (ch + (y1 - y0) * s) / 2 + y0 * s;
    const X = (x) => ox + x * s, Y = (y) => oy - y * s;
    const view = { s, ox, oy, X, Y, toWorld: (px, py) => [(px - ox) / s, (oy - py) / s] };

    if (!opts.thumb) {
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      const step = 100 * s >= 8 ? 100 : 500;
      for (let gx = Math.floor(x0 / step) * step; gx < x1; gx += step) { ctx.beginPath(); ctx.moveTo(X(gx), 0); ctx.lineTo(X(gx), ch); ctx.stroke(); }
      for (let gy = Math.floor(y0 / step) * step; gy < y1; gy += step) { ctx.beginPath(); ctx.moveTo(0, Y(gy)); ctx.lineTo(cw, Y(gy)); ctx.stroke(); }
    }

    const poly = (pts, fill, stroke, lw = 1, dash) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]); }
    };
    // local (a along u, c along n) relative to box centre
    const L = (b, a, c) => [b.cx + a * b.ux + c * b.nx, b.cy + a * b.uy + c * b.ny];

    const p = model.params;
    const by = (k) => model.boxes.filter((b) => b.kind === k);

    // floor
    poly([[0, 0], [p.roomW, 0], [p.roomW, p.roomD], [0, p.roomD]], opts.thumb ? '#fff' : '#fff', null);

    // worktops & base footprints
    for (const b of by('counter')) poly(footprint(b), model.runs.find((r) => r.id === b.run).freestanding ? C.island : C.counter, C.counterEdge, opts.thumb ? 0.6 : 1);
    if (!opts.thumb) {
      for (const b of model.boxes.filter((x) => ['base', 'corner', 'sinkBase', 'cookBase', 'dishwasher', 'filler'].includes(x.kind))) {
        poly(footprint(b), null, 'rgba(120,110,95,0.35)', 0.7);
      }
    }
    // tall units
    for (const b of by('pantry')) {
      const f = footprint(b);
      poly(f, C.tall, C.counterEdge, 1);
      ctx.beginPath(); ctx.moveTo(X(f[0][0]), Y(f[0][1])); ctx.lineTo(X(f[2][0]), Y(f[2][1])); ctx.strokeStyle = C.counterEdge; ctx.lineWidth = 0.7; ctx.stroke();
      if (b.tower && !opts.thumb) {
        ctx.fillStyle = C.text; ctx.font = `600 ${Math.max(8, 80 * s)}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('OV', X(b.cx), Y(b.cy));
      }
    }
    if (!opts.thumb) for (const b of by('shelf')) poly(footprint(b), null, C.wallCab, 0.8, [2, 3]);
    for (const b of by('fridge')) {
      poly(footprint(b), '#fff', C.appliance, 1.2);
      // asterisk symbol, as in the reference plans
      const r = Math.min(b.L, b.D) * 0.22;
      ctx.strokeStyle = C.appliance; ctx.lineWidth = opts.thumb ? 0.8 : 1.4;
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 4;
        const [xa, ya] = [b.cx + Math.cos(a) * r, b.cy + Math.sin(a) * r];
        const [xb, yb] = [b.cx - Math.cos(a) * r, b.cy - Math.sin(a) * r];
        ctx.beginPath(); ctx.moveTo(X(xa), Y(ya)); ctx.lineTo(X(xb), Y(yb)); ctx.stroke();
      }
    }
    // sink
    for (const b of by('sinkBowl')) {
      poly(footprint(b), '#fff', C.appliance, 1);
      const n = b.bowls, gap = 30, bw = (b.L - gap * (n + 1)) / n;
      for (let i = 0; i < n; i++) {
        const a0 = -b.L / 2 + gap + i * (bw + gap);
        const pts = [L(b, a0, -b.D / 2 + gap + 40), L(b, a0 + bw, -b.D / 2 + gap + 40), L(b, a0 + bw, b.D / 2 - gap), L(b, a0, b.D / 2 - gap)];
        poly(pts, '#f1f4f6', C.appliance, 0.8);
      }
      // tap at the back
      const [tx, ty] = L(b, 0, -b.D / 2 + 25);
      ctx.beginPath(); ctx.arc(X(tx), Y(ty), Math.max(1.5, 22 * s), 0, Math.PI * 2); ctx.fillStyle = C.appliance; ctx.fill();
    }
    // cooktop
    for (const b of by('cooktop')) {
      poly(footprint(b), '#3b3936', C.appliance, 1);
      const n = b.burners;
      const spots = n === 5 ? [[-0.3, -0.25], [0.3, -0.25], [0, 0], [-0.3, 0.25], [0.3, 0.25]] : [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]];
      ctx.strokeStyle = '#d0ccc5'; ctx.lineWidth = opts.thumb ? 0.5 : 1;
      for (const [a, c] of spots) {
        const [x, y] = L(b, a * b.L, c * b.D);
        ctx.beginPath(); ctx.arc(X(x), Y(y), Math.max(1, Math.min(b.L, b.D) * 0.16 * s), 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (!opts.thumb) {
      for (const b of by('dishwasher')) {
        const [x, y] = L(b, 0, 0);
        ctx.fillStyle = C.text; ctx.font = `${Math.max(8, 90 * s)}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('DW', X(x), Y(y));
      }
    }
    // wall cabinets & hoods (dashed, overhead)
    if (opts.wallCabs && !opts.thumb) {
      for (const b of by('wallCab')) poly(footprint(b, 2), null, C.wallCab, 0.9, [5, 4]);
      for (const b of by('hood').filter((h) => h.label !== 'Hood chimney')) poly(footprint(b), null, C.appliance, 0.9, [2, 3]);
    }
    // stools
    for (const b of by('stool')) {
      ctx.beginPath(); ctx.arc(X(b.cx), Y(b.cy), Math.max(2, 175 * s), 0, Math.PI * 2);
      ctx.fillStyle = C.stool; ctx.fill(); ctx.strokeStyle = '#8f887c'; ctx.lineWidth = 0.8; ctx.stroke();
    }

    // walls with openings
    drawWalls(ctx, model, view, opts);

    // work triangle
    const tp = model.triangle.points;
    if (opts.triangle && tp.sink && tp.cooktop && tp.fridge) {
      const pts = [tp.sink, tp.cooktop, tp.fridge];
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(X(q.x), Y(q.y)) : ctx.moveTo(X(q.x), Y(q.y))));
      ctx.closePath();
      ctx.strokeStyle = C.triangle; ctx.lineWidth = opts.thumb ? 1 : 2; ctx.setLineDash(opts.thumb ? [3, 2] : [7, 5]); ctx.stroke(); ctx.setLineDash([]);
      for (const q of pts) { ctx.beginPath(); ctx.arc(X(q.x), Y(q.y), opts.thumb ? 2 : 5, 0, Math.PI * 2); ctx.fillStyle = C.triangle; ctx.fill(); }
      if (!opts.thumb && model.triangle.legs) {
        const lg = model.triangle.legs;
        const pairs = [[tp.sink, tp.cooktop, lg.sinkCook], [tp.cooktop, tp.fridge, lg.cookFridge], [tp.fridge, tp.sink, lg.fridgeSink]];
        ctx.font = '600 11px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const [a, b, v] of pairs) {
          const mx = X((a.x + b.x) / 2), my = Y((a.y + b.y) / 2);
          const txt = `${(v / 1000).toFixed(2)} m`;
          const w = ctx.measureText(txt).width + 8;
          ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(mx - w / 2, my - 8, w, 16);
          ctx.fillStyle = C.triangle; ctx.fillText(txt, mx, my);
        }
      }
    }

    if (opts.dims && !opts.thumb) drawDims(ctx, model, view);
    if (opts.highlight) {
      const b = model.boxes.find((x) => x.id === opts.highlight);
      if (b) poly(footprint(b), 'rgba(232,116,44,0.18)', C.triangle, 2);
    }
    return view;
  }

  function drawWalls(ctx, model, v, opts) {
    const { X, Y, s } = v;
    for (const w of model.walls) {
      const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      const ux = (w.x2 - w.x1) / len, uy = (w.y2 - w.y1) / len;
      const nx = -uy, ny = ux;
      const ops = model.openings.filter((o) => o.wall === w.id).map((o) => [o.offset - o.w / 2, o.offset + o.w / 2, o]).sort((a, b) => a[0] - b[0]);
      const pieces = [];
      let cur = 0;
      for (const [a, b] of ops) { if (a > cur) pieces.push([cur, a]); cur = b; }
      if (cur < len) pieces.push([cur, len]);
      const quad = (a, b) => {
        const P = (d, o) => [w.x1 + ux * d + nx * o, w.y1 + uy * d + ny * o];
        return [P(a, -w.t / 2), P(b, -w.t / 2), P(b, w.t / 2), P(a, w.t / 2)];
      };
      for (const [a, b] of pieces) {
        const q = quad(a, b);
        ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath();
        ctx.fillStyle = C.wall; ctx.fill();
      }
      const p = model.params;
      const mid0 = [w.x1 + ux * len / 2, w.y1 + uy * len / 2];
      const room = ((p.roomW / 2 - mid0[0]) * nx + (p.roomD / 2 - mid0[1]) * ny) > 0 ? 1 : -1; // normal side facing the room
      const P = (d, o) => [w.x1 + ux * d + nx * o, w.y1 + uy * d + ny * o];
      const line = (pa, pb, lw, color, dash) => {
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash || []);
        ctx.beginPath(); ctx.moveTo(X(pa[0]), Y(pa[1])); ctx.lineTo(X(pb[0]), Y(pb[1])); ctx.stroke(); ctx.setLineDash([]);
      };
      for (const [a, b, o] of ops) {
        const q = quad(a, b);
        if (o.kind === 'window') {
          line(q[0], q[1], opts.thumb ? 1 : 2, C.window);
          line(q[3], q[2], opts.thumb ? 1 : 2, C.window);
          line(P(a, 0), P(b, 0), opts.thumb ? 0.6 : 1, C.window);
          // sill line on the room side
          if (!opts.thumb) line(P(a, room * (w.t / 2 + 40)), P(b, room * (w.t / 2 + 40)), 0.8, C.window);
        } else if (o.kind === 'threshold') {
          // jambs, and the beam overhead drawn dashed (above the cut plane)
          const hw = (o.beamW || w.t) / 2;
          line(P(a, -w.t / 2), P(a, w.t / 2), opts.thumb ? 0.8 : 1.4, C.wall);
          line(P(b, -w.t / 2), P(b, w.t / 2), opts.thumb ? 0.8 : 1.4, C.wall);
          const ext = Math.min(o.bearing || 0, 400);
          line(P(a - ext, -hw), P(b + ext, -hw), opts.thumb ? 0.6 : 1, C.text, [8, 5]);
          line(P(a - ext, hw), P(b + ext, hw), opts.thumb ? 0.6 : 1, C.text, [8, 5]);
        } else {
          // leaf drawn open at 90°, hinged at the chosen jamb, swinging in or out
          const side = o.swing === 'out' ? -room : room;
          const hd = o.hinge === 'end' ? b : a, fd = o.hinge === 'end' ? a : b;
          const hinge = P(hd, side * w.t / 2);
          const leaf = o.w - 20;
          const leafEnd = [hinge[0] + nx * side * leaf, hinge[1] + ny * side * leaf];
          line(hinge, leafEnd, opts.thumb ? 0.8 : 1.8, C.text);
          const closed = P(fd, side * w.t / 2);
          const a0 = Math.atan2(-(leafEnd[1] - hinge[1]), leafEnd[0] - hinge[0]);
          const a1 = Math.atan2(-(closed[1] - hinge[1]), closed[0] - hinge[0]);
          let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
          ctx.strokeStyle = C.text; ctx.lineWidth = opts.thumb ? 0.5 : 0.9; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.arc(X(hinge[0]), Y(hinge[1]), leaf * s, a0, a1, d < 0); ctx.stroke(); ctx.setLineDash([]);
        }
        if (opts.highlightOpening === o.id) {
          const hq = [P(a, -w.t / 2 - 60), P(b, -w.t / 2 - 60), P(b, w.t / 2 + 60), P(a, w.t / 2 + 60)];
          ctx.beginPath(); hq.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath();
          ctx.fillStyle = 'rgba(232,116,44,0.18)'; ctx.fill(); ctx.strokeStyle = C.triangle; ctx.lineWidth = 1.5; ctx.stroke();
        }
        if (!opts.thumb && opts.labels) {
          // tag inside the room, beyond an in-swinging leaf
          const tagOff = room * (w.t / 2 + (o.kind === 'door' && o.swing === 'in' ? o.w : 0) + 170);
          const [tx, ty] = P((a + b) / 2, tagOff);
          const sub = o.kind === 'window' ? `${o.w}×${o.h} · sill ${o.sill}` : o.kind === 'threshold' ? `${o.w}×${o.h} · beam ${o.beamW}×${o.beamD}` : `${o.w}×${o.h}`;
          ctx.font = '600 10px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const tw = Math.max(ctx.measureText(o.id).width, (ctx.font = '9px Inter, system-ui, sans-serif', ctx.measureText(sub).width)) + 8;
          ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(X(tx) - tw / 2, Y(ty) - 12, tw, 24);
          ctx.fillStyle = C.text; ctx.font = '600 10px Inter, system-ui, sans-serif'; ctx.fillText(o.id, X(tx), Y(ty) - 5);
          ctx.font = '9px Inter, system-ui, sans-serif'; ctx.fillStyle = '#6b665d'; ctx.fillText(sub, X(tx), Y(ty) + 6);
        }
      }
    }
  }

  function dimLine(ctx, v, x1, y1, x2, y2, off, text) {
    const { X, Y } = v;
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 1) return;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len, nx = -uy, ny = ux;
    const a = [x1 + nx * off, y1 + ny * off], b = [x2 + nx * off, y2 + ny * off];
    ctx.strokeStyle = C.dim; ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(X(x1 + nx * off * 0.2), Y(y1 + ny * off * 0.2)); ctx.lineTo(X(a[0] + nx * 60 * Math.sign(off)), Y(a[1] + ny * 60 * Math.sign(off)));
    ctx.moveTo(X(x2 + nx * off * 0.2), Y(y2 + ny * off * 0.2)); ctx.lineTo(X(b[0] + nx * 60 * Math.sign(off)), Y(b[1] + ny * 60 * Math.sign(off)));
    ctx.moveTo(X(a[0]), Y(a[1])); ctx.lineTo(X(b[0]), Y(b[1]));
    ctx.stroke();
    for (const q of [a, b]) { // architectural ticks
      ctx.beginPath(); ctx.moveTo(X(q[0] - (ux - nx) * 50), Y(q[1] - (uy - ny) * 50)); ctx.lineTo(X(q[0] + (ux - nx) * 50), Y(q[1] + (uy - ny) * 50)); ctx.lineWidth = 1.4; ctx.stroke();
    }
    const mx = X((a[0] + b[0]) / 2), my = Y((a[1] + b[1]) / 2);
    let ang = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
    if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
    ctx.save(); ctx.translate(mx, my); ctx.rotate(ang);
    ctx.font = '11px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = C.dim; ctx.fillText(text, 0, -3);
    ctx.restore();
  }

  // Corner-to-edge dimension chain along every wall that has openings,
  // just outside the wall (interior dimensions).
  function drawOpeningChains(ctx, model, v) {
    const p = model.params, W = p.roomW, D = p.roomD, t = p.wallT, off = 170;
    const lines = {
      back: (a) => [a, D + t], front: (a) => [a, -t], left: (a) => [-t, a], right: (a) => [W + t, a],
    };
    const sign = { back: 1, front: -1, left: 1, right: -1 };
    for (const wall of Object.keys(lines)) {
      const ops = model.openings.filter((o) => o.wall === wall).sort((a, b) => a.a0 - b.a0);
      if (!ops.length) continue;
      const len = wall === 'back' || wall === 'front' ? W : D;
      const pts = [0];
      for (const o of ops) pts.push(o.a0, o.a1);
      pts.push(len);
      for (let i = 0; i < pts.length - 1; i++) {
        const d = pts[i + 1] - pts[i];
        if (d < 1) continue;
        const [x1, y1] = lines[wall](pts[i]), [x2, y2] = lines[wall](pts[i + 1]);
        dimLine(ctx, v, x1, y1, x2, y2, sign[wall] * off, `${Math.round(d)}`);
      }
    }
  }

  function drawDims(ctx, model, v) {
    const p = model.params, bd = p.baseDepth, W = p.roomW, D = p.roomD, t = p.wallT;
    drawOpeningChains(ctx, model, v);
    dimLine(ctx, v, 0, D + t, W, D + t, 420, `${W}`);
    dimLine(ctx, v, -t, 0, -t, D, 420, `${D}`);
    const R = Object.fromEntries(model.runs.map((r) => [r.id, r]));
    // aisle dimensions
    if (R.front) dimLine(ctx, v, W * 0.15, bd, W * 0.15, D - bd, 0, `${D - 2 * bd}`);
    if (R.left && R.right) dimLine(ctx, v, bd, D * 0.35, W - bd, D * 0.35, 0, `${W - 2 * bd}`);
    // leg lengths, each outside its own wall (beyond the overall and opening dimensions)
    if (R.left) dimLine(ctx, v, -t, D - (R.left.length + bd), -t, D, 640, `${Math.round(R.left.length + bd)}`);
    if (R.right) dimLine(ctx, v, W + t, D, W + t, D - (R.right.length + bd), 420, `${Math.round(R.right.length + bd)}`);
    if (R.island) {
      const i = R.island;
      dimLine(ctx, v, i.ox, i.oy + bd + p.nosing, i.ox, D - bd, 0, `${Math.round(D - bd - i.oy - bd - p.nosing)}`);
      dimLine(ctx, v, i.ox, i.oy - p.overhang, i.ox + i.length, i.oy - p.overhang, -260, `${Math.round(i.length)}`);
    }
    if (R.peninsula) {
      const q = R.peninsula;
      if (p.layout === 'g-shape') dimLine(ctx, v, W * 0.62, q.oy + bd, W * 0.62, D - bd, 0, `${Math.round(D - bd - q.oy - bd)}`);
      else dimLine(ctx, v, bd, D * 0.4, q.ox - bd, D * 0.4, 0, `${Math.round(q.ox - 2 * bd)}`);
    }
  }

  root.KitchenPlan = { draw, footprint };
})(typeof self !== 'undefined' ? self : this);

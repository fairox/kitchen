/*
 * App controller — builds the parameter panel, keeps state in the URL hash,
 * regenerates the model on every change and pushes it to the 3D and plan views.
 */
(function () {
  'use strict';
  const G = KitchenGenerator;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ------------------------------------------------------------------ state
  // the hash stores a diff against DEFAULTS, so it is applied on top of DEFAULTS alone
  const fromHash = readHash();
  let params = Object.keys(fromHash).length
    ? Object.assign({}, G.DEFAULTS, fromHash)
    : Object.assign({}, G.DEFAULTS, G.LAYOUTS[G.DEFAULTS.layout].defaults);
  let model = null;
  let highlight = null;

  function readHash() {
    try {
      const h = decodeURIComponent(location.hash.slice(1));
      return h ? JSON.parse(atob(h)) : {};
    } catch (e) { return {}; }
  }
  function writeHash() {
    const diff = {};
    for (const [k, v] of Object.entries(params)) if (v !== G.DEFAULTS[k]) diff[k] = v;
    history.replaceState(null, '', '#' + encodeURIComponent(btoa(JSON.stringify(diff))));
  }

  // ------------------------------------------------------------------ field schema
  const has = (id) => (p) => G.LAYOUTS[p.layout].runs.includes(id);
  const freestanding = (p) => p.island || G.LAYOUTS[p.layout].runs.includes('peninsula');
  const SECTIONS = [
    {
      title: 'Room', open: true, fields: [
        { key: 'roomW', label: 'Room width', min: 1800, max: 8000, step: 50, unit: 'mm' },
        { key: 'roomD', label: 'Room depth', min: 1500, max: 8000, step: 50, unit: 'mm' },
        { key: 'wallH', label: 'Ceiling height', min: 2300, max: 3600, step: 50, unit: 'mm' },
        { key: 'wallT', label: 'Wall thickness', min: 100, max: 400, step: 10, unit: 'mm' },
        { key: 'openEnds', label: 'Open ends (walk-through galley)', type: 'toggle', show: (p) => p.layout === 'galley' },
        { key: 'doorWall', label: 'Door', type: 'seg', options: [['front', 'Front'], ['left', 'Left'], ['right', 'Right'], ['none', 'None']], show: (p) => !(p.layout === 'galley' && p.openEnds) },
        { key: 'doorPos', label: 'Door position', min: 0, max: 1, step: 0.01, unit: '%', show: (p) => p.doorWall !== 'none' && !(p.layout === 'galley' && p.openEnds) },
        { key: 'doorW', label: 'Door width', min: 700, max: 1600, step: 10, unit: 'mm', show: (p) => p.doorWall !== 'none' && !(p.layout === 'galley' && p.openEnds) },
      ],
    },
    {
      title: 'Runs', open: true, fields: [
        { key: 'legLeft', label: 'Left leg length', min: 1200, max: 6000, step: 50, unit: 'mm', show: has('left') },
        { key: 'legRight', label: 'Right leg length', min: 1200, max: 6000, step: 50, unit: 'mm', show: has('right') },
        { key: 'pensLen', label: 'Peninsula length', min: 600, max: 4000, step: 50, unit: 'mm', show: has('peninsula') },
        { key: 'pensPos', label: 'Peninsula position', min: 0.3, max: 1, step: 0.01, unit: '%', show: (p) => p.layout === 'peninsula' },
        { key: 'islandLen', label: 'Island length', min: 900, max: 4000, step: 50, unit: 'mm', show: (p) => p.island },
        { key: 'islandOffset', label: 'Island offset', min: -1500, max: 1500, step: 25, unit: 'mm', show: (p) => p.island },
        { key: 'aisle', label: 'Aisle to island', min: 800, max: 1800, step: 25, unit: 'mm', show: (p) => p.island },
        { key: 'overhang', label: 'Seating overhang', min: 0, max: 450, step: 10, unit: 'mm', show: freestanding },
        { key: 'stoolSpacing', label: 'Stool spacing', min: 450, max: 900, step: 10, unit: 'mm', show: freestanding },
      ],
    },
    { title: 'Appliances', open: true, custom: 'appliances' },
    {
      title: 'Base cabinets', open: false, fields: [
        { key: 'counterH', label: 'Worktop height', min: 800, max: 1000, step: 5, unit: 'mm' },
        { key: 'baseDepth', label: 'Base depth', min: 450, max: 750, step: 10, unit: 'mm' },
        { key: 'counterT', label: 'Worktop thickness', min: 12, max: 60, step: 1, unit: 'mm' },
        { key: 'plinthH', label: 'Plinth height', min: 0, max: 200, step: 5, unit: 'mm' },
        { key: 'moduleMax', label: 'Max module width', min: 400, max: 1000, step: 50, unit: 'mm' },
      ],
    },
    {
      title: 'Wall & tall units', open: false, fields: [
        { key: 'wallCabs', label: 'Wall cabinets', type: 'toggle' },
        { key: 'wallCabElev', label: 'Wall unit bottom', min: 1300, max: 1700, step: 10, unit: 'mm', show: (p) => p.wallCabs },
        { key: 'wallCabH', label: 'Wall unit height', min: 300, max: 1100, step: 10, unit: 'mm', show: (p) => p.wallCabs },
        { key: 'wallCabDepth', label: 'Wall unit depth', min: 250, max: 450, step: 10, unit: 'mm', show: (p) => p.wallCabs },
        { key: 'tallH', label: 'Tall unit height', min: 1800, max: 2700, step: 10, unit: 'mm' },
        { key: 'pantryCount', label: 'Tall pantry units', min: 0, max: 3, step: 1, unit: '' },
      ],
    },
    { title: 'Finish', open: false, custom: 'finish' },
  ];

  const PRESETS = [
    { name: 'Oat', frontColor: '#e8e2d6', counterColor: '#3d3b38', floorColor: '#d9cfc0' },
    { name: 'Olive', frontColor: '#6f7350', counterColor: '#e9e4da', floorColor: '#c9b79c' },
    { name: 'Navy', frontColor: '#2f3e55', counterColor: '#efece6', floorColor: '#d2c4ae' },
    { name: 'Walnut', frontColor: '#7a5338', counterColor: '#f1efea', floorColor: '#e4dfd6' },
    { name: 'White', frontColor: '#f7f7f5', counterColor: '#b9b2a4', floorColor: '#a58b6d' },
  ];

  // ------------------------------------------------------------------ build panel
  const fieldsEl = $('#fields');
  const fieldEls = [];

  function fmt(f, v) {
    if (f.unit === '%') return Math.round(v * 100) + '%';
    return f.unit ? `${v}` : `${v}`;
  }

  function buildFields() {
    for (const sec of SECTIONS) {
      const d = document.createElement('details');
      d.className = 'group';
      d.open = sec.open;
      d.innerHTML = `<summary><h2>${sec.title}</h2></summary>`;
      fieldsEl.appendChild(d);
      if (sec.custom === 'appliances') buildAppliances(d);
      else if (sec.custom === 'finish') buildFinish(d);
      else for (const f of sec.fields) d.appendChild(buildField(f));
    }
  }

  function buildField(f) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const entry = { f, wrap };
    if (f.type === 'toggle') {
      wrap.innerHTML = `<label class="toggle"><input type="checkbox"><span>${f.label}</span></label>`;
      const inp = $('input', wrap);
      inp.addEventListener('change', () => set(f.key, inp.checked));
      entry.sync = () => (inp.checked = !!params[f.key]);
    } else if (f.type === 'seg') {
      wrap.innerHTML = `<div class="field-head"><label>${f.label}</label></div><div class="seg">${f.options.map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</div>`;
      $$('button', wrap).forEach((b) => b.addEventListener('click', () => set(f.key, b.dataset.v)));
      entry.sync = () => $$('button', wrap).forEach((b) => b.classList.toggle('active', String(params[f.key]) === b.dataset.v));
    } else if (f.type === 'select') {
      wrap.innerHTML = `<div class="field-head"><label>${f.label}</label></div><select></select>`;
      const sel = $('select', wrap);
      sel.addEventListener('change', () => set(f.key, sel.value));
      entry.sync = () => {
        const opts = f.options(params);
        sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
        sel.value = params[f.key];
      };
    } else {
      const pct = f.unit === '%';
      wrap.innerHTML = `<div class="field-head"><label>${f.label}</label>${pct || !f.unit ? '<output></output>' : `<span><input class="num" type="number" step="${f.step}"> <span class="muted">${f.unit}</span></span>`}</div>
        <input type="range" min="${f.min}" max="${f.max}" step="${f.step}">`;
      const range = $('input[type=range]', wrap);
      const num = $('input.num', wrap);
      const out = $('output', wrap);
      range.addEventListener('input', () => set(f.key, Number(range.value)));
      if (num) num.addEventListener('change', () => set(f.key, Number(num.value)));
      entry.sync = () => {
        range.value = params[f.key];
        if (num && document.activeElement !== num) num.value = params[f.key];
        if (out) out.textContent = fmt(f, params[f.key]);
      };
    }
    fieldEls.push(entry);
    return wrap;
  }

  function buildAppliances(d) {
    const runOpts = (key) => (p) => G.runOptions(p.layout, p.island)
      .filter((r) => key !== 'fridgeRun' || !r.freestanding)
      .map((r) => [r.id, r.label]);
    const rows = [
      { name: 'Sink', color: '#4f86b8', run: 'sinkRun', pos: 'sinkPos' },
      { name: 'Cooktop', color: '#3b3936', run: 'cookRun', pos: 'cookPos' },
      { name: 'Fridge', color: '#9aa0a6', run: 'fridgeRun', pos: 'fridgePos' },
    ];
    for (const r of rows) {
      const head = document.createElement('div');
      head.className = 'app-row';
      head.innerHTML = `<div class="name"><span class="swatch" style="background:${r.color}"></span>${r.name}</div>`;
      const sel = buildField({ key: r.run, label: '', type: 'select', options: runOpts(r.run) });
      sel.querySelector('.field-head').remove();
      sel.style.margin = 0;
      head.appendChild(sel);
      d.appendChild(head);
      d.appendChild(buildField({ key: r.pos, label: `${r.name} position`, min: 0, max: 1, step: 0.01, unit: '%' }));
    }
    d.appendChild(buildField({ key: 'sinkW', label: 'Sink unit', type: 'seg', options: [['600', '600'], ['800', '800'], ['900', '900'], ['1000', '1000']] }));
    d.appendChild(buildField({ key: 'dwSide', label: 'Dishwasher', type: 'seg', options: [['left', 'Left of sink'], ['right', 'Right of sink'], ['none', 'None']] }));
    d.appendChild(buildField({ key: 'cookW', label: 'Cooktop unit', type: 'seg', options: [['600', '600'], ['750', '750'], ['900', '900']] }));
    d.appendChild(buildField({ key: 'fridgeW', label: 'Fridge unit', type: 'seg', options: [['600', '600'], ['700', '700'], ['900', '900 (side-by-side)']] }));
    d.appendChild(buildField({ key: 'windowOverSink', label: 'Window over sink', type: 'toggle' }));
    d.appendChild(buildField({ key: 'windowW', label: 'Window width', min: 600, max: 2400, step: 50, unit: 'mm', show: (p) => p.windowOverSink }));
  }

  function buildFinish(d) {
    const pre = document.createElement('div');
    pre.className = 'seg';
    pre.style.marginBottom = '10px';
    pre.innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${p.name}</button>`).join('');
    $$('button', pre).forEach((b) => b.addEventListener('click', () => {
      const p = PRESETS[b.dataset.i];
      Object.assign(params, { frontColor: p.frontColor, counterColor: p.counterColor, floorColor: p.floorColor });
      refresh();
    }));
    d.appendChild(pre);
    const grid = document.createElement('div');
    grid.className = 'colors';
    for (const [k, l] of [['frontColor', 'Fronts'], ['counterColor', 'Worktop'], ['wallColor', 'Walls'], ['floorColor', 'Floor']]) {
      const c = document.createElement('label');
      c.className = 'color';
      c.innerHTML = `<input type="color"> ${l}`;
      const inp = $('input', c);
      inp.addEventListener('input', () => set(k, inp.value));
      fieldEls.push({ f: { key: k }, wrap: c, sync: () => (inp.value = params[k]) });
      grid.appendChild(c);
    }
    d.appendChild(grid);
  }

  // layout picker with live thumbnails drawn by the plan renderer
  function buildLayoutGrid() {
    const grid = $('#layout-grid');
    for (const [id, def] of Object.entries(G.LAYOUTS)) {
      const b = document.createElement('button');
      b.className = 'layout-card';
      b.dataset.layout = id;
      b.innerHTML = `<canvas></canvas><span>${def.label}</span>`;
      b.addEventListener('click', () => setLayout(id));
      grid.appendChild(b);
    }
    requestAnimationFrame(drawThumbs);
  }
  function drawThumbs() {
    for (const b of $$('.layout-card')) {
      const m = G.generate(Object.assign({}, G.DEFAULTS, G.LAYOUTS[b.dataset.layout].defaults, { layout: b.dataset.layout, wallCabs: false }));
      KitchenPlan.draw($('canvas', b), m, { thumb: true, dims: false });
    }
  }

  // ------------------------------------------------------------------ mutations
  function set(key, value) {
    if (typeof G.DEFAULTS[key] === 'number') value = Number(value);
    params[key] = value;
    refresh();
  }

  function setLayout(id) {
    const island = params.island && G.LAYOUTS[id].island;
    params = Object.assign({}, params, G.LAYOUTS[id].defaults, { layout: id, island });
    viewer.reframe();
    refresh();
  }

  $('#island-toggle input').addEventListener('change', (e) => {
    params.island = e.target.checked;
    if (params.island) {
      const patch = G.fitIsland(params);
      if (patch.roomW || patch.roomD) {
        toast(`Room enlarged to ${patch.roomW || params.roomW} × ${patch.roomD || params.roomD} mm to fit the island.`);
        viewer.reframe();
      }
      Object.assign(params, patch);
    } else {
      for (const k of ['sinkRun', 'cookRun']) if (params[k] === 'island') params[k] = G.LAYOUTS[params.layout].defaults[k];
    }
    refresh();
  });

  // ------------------------------------------------------------------ render
  const viewer = KitchenViewer($('#pane-3d'));
  const planCanvas = $('#plan');
  let planView = null;
  let raf = 0;
  let hashTimer = 0;

  function refresh() {
    model = G.generate(params);
    // reflect clamping / fallbacks back into the UI
    Object.assign(params, { sinkRun: model.assigned.sinkRun, cookRun: model.assigned.cookRun, fridgeRun: model.assigned.fridgeRun, island: model.params.island });
    for (const e of fieldEls) {
      e.sync();
      if (e.f.show) e.wrap.hidden = !e.f.show(params);
    }
    $$('.layout-card').forEach((b) => b.classList.toggle('active', b.dataset.layout === params.layout));
    const it = $('#island-toggle');
    it.hidden = !G.LAYOUTS[params.layout].island;
    $('input', it).checked = !!params.island;

    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      viewer.update(model);
      drawPlan();
      renderAnalysis();
    });
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHash, 250);
  }

  function drawPlan() {
    planView = KitchenPlan.draw(planCanvas, model, {
      triangle: $('#show-tri').checked, dims: $('#show-dims').checked, wallCabs: $('#show-wc').checked, highlight,
    });
  }

  function renderAnalysis() {
    const t = model.triangle;
    const tri = $('#triangle');
    if (t.legs) {
      const leg = (label, v) => `<span>${label}</span><span class="${v < 1200 || v > 2700 ? 'bad' : ''}">${(v / 1000).toFixed(2)} m</span>`;
      tri.innerHTML = leg('Sink → cooktop', t.legs.sinkCook) + leg('Cooktop → fridge', t.legs.cookFridge) + leg('Fridge → sink', t.legs.fridgeSink)
        + `<span class="total">Total</span><span class="total ${t.total > 7900 || t.total < 4000 ? 'bad' : ''}">${(t.total / 1000).toFixed(2)} m</span>`;
    } else tri.innerHTML = '<span class="muted">Not all appliances placed.</span>';

    const order = { error: 0, warn: 1, ok: 2 };
    $('#checks').innerHTML = model.checks.slice().sort((a, b) => order[a.level] - order[b.level])
      .map((c) => `<li class="${c.level}">${escapeHtml(c.msg)}</li>`).join('');

    const s = model.stats;
    $('#stats').innerHTML = [
      ['Room', `${(params.roomW / 1000).toFixed(2)} × ${(params.roomD / 1000).toFixed(2)} m (${s.floorArea} m²)`],
      ['Worktop', `${(s.worktopLength / 1000).toFixed(2)} m · ${s.worktopArea} m²`],
      ['Base units', s.baseUnits], ['Wall units', s.wallUnits], ['Tall units', s.tallUnits], ['Seats', s.seats],
      ['Elements', model.boxes.length + model.walls.length + model.openings.length],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

    $('#schedule tbody').innerHTML = model.schedule.map((r) =>
      `<tr><td>${r.code}</td><td>${escapeHtml(r.description)}</td><td>${r.width}×${r.depth}×${r.height}</td><td>${r.qty}</td></tr>`).join('');
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // plan hover / click
  function hit(ev) {
    if (!planView) return null;
    const r = planCanvas.getBoundingClientRect();
    const [x, y] = planView.toWorld(ev.clientX - r.left, ev.clientY - r.top);
    const pri = { sinkBowl: 0, cooktop: 0, stool: 1, fridge: 1, pantry: 1, dishwasher: 2, sinkBase: 2, cookBase: 2, base: 2, corner: 2, filler: 2 };
    const cands = model.boxes.filter((b) => b.kind in pri).filter((b) => {
      const a = G.aabb(b);
      return x >= a[0] && x <= a[2] && y >= a[1] && y <= a[3];
    }).sort((a, b) => pri[a.kind] - pri[b.kind]);
    return cands[0] || null;
  }
  planCanvas.addEventListener('mousemove', (ev) => {
    const b = hit(ev);
    const tip = $('#tooltip');
    if (!b) { tip.hidden = true; return; }
    const r = planCanvas.getBoundingClientRect();
    tip.hidden = false;
    tip.textContent = `${b.label} · ${Math.round(b.L)}×${Math.round(b.D)}×${Math.round(b.H)}`;
    tip.style.left = ev.clientX - r.left + 14 + 'px';
    tip.style.top = ev.clientY - r.top + 14 + 'px';
  });
  planCanvas.addEventListener('mouseleave', () => ($('#tooltip').hidden = true));
  planCanvas.addEventListener('click', (ev) => { const b = hit(ev); highlight = b ? b.id : null; drawPlan(); });
  ['#show-tri', '#show-dims', '#show-wc'].forEach((s) => $(s).addEventListener('change', drawPlan));
  new ResizeObserver(() => { if (model) drawPlan(); }).observe($('#pane-plan'));

  // view switching
  $$('.views button').forEach((b) => b.addEventListener('click', () => {
    $$('.views button').forEach((x) => x.classList.toggle('active', x === b));
    $('#stage').dataset.view = b.dataset.view;
  }));
  $$('[data-cam]').forEach((b) => b.addEventListener('click', () => viewer.setView(b.dataset.cam, params)));
  $('#cutaway').addEventListener('change', (e) => viewer.setCutaway(e.target.checked));

  // top bar actions
  $('#btn-reset').addEventListener('click', () => {
    params = Object.assign({}, G.DEFAULTS, G.LAYOUTS[params.layout].defaults, { layout: params.layout });
    viewer.reframe();
    refresh();
  });
  $('#btn-link').addEventListener('click', async () => {
    writeHash();
    try { await navigator.clipboard.writeText(location.href); toast('Link copied.'); } catch (e) { toast('Copy the URL from the address bar.'); }
  });
  $('#btn-export').addEventListener('click', (e) => { e.stopPropagation(); $('#export-menu').classList.toggle('open'); });
  document.addEventListener('click', () => $('#export-menu').classList.remove('open'));
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => exportAs(b.dataset.export)));

  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportAs(kind) {
    const base = `kitchen-${params.layout}${params.island ? '-island' : ''}`;
    if (kind === 'json') download(`${base}.json`, JSON.stringify(model, null, 2), 'application/json');
    if (kind === 'params') download(`${base}-params.json`, JSON.stringify(params, null, 2), 'application/json');
    if (kind === 'csv') {
      const rows = [['Code', 'Description', 'Category', 'Width', 'Depth', 'Height', 'Qty']]
        .concat(model.schedule.map((r) => [r.code, r.description, r.category, r.width, r.depth, r.height, r.qty]));
      download(`${base}-schedule.csv`, rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
    }
    if (kind === 'png-plan') planCanvas.toBlob((b) => download(`${base}-plan.png`, b));
    if (kind === 'png-3d') fetch(viewer.snapshot()).then((r) => r.blob()).then((b) => download(`${base}-3d.png`, b));
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), 2600);
  }

  // ------------------------------------------------------------------ Archicad bridge (serve.py)
  const dlg = $('#ac-dialog');
  const log = (msg) => { const l = $('#ac-log'); l.textContent += msg + '\n'; l.scrollTop = l.scrollHeight; };
  let bridge = null;

  async function checkBridge() {
    try {
      const r = await fetch('api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      bridge = await r.json();
    } catch (e) {
      bridge = { bridge: false };
    }
    $('#ac-dot').classList.toggle('on', !!bridge.archicad);
    return bridge;
  }

  async function openArchicad() {
    $('#ac-log').textContent = '';
    dlg.showModal();
    $('#ac-status').textContent = 'Checking connection…';
    const s = await checkBridge();
    const ready = !!s.archicad;
    $('#ac-build').disabled = !ready;
    $('#ac-test').disabled = !ready;
    if (!s.bridge) {
      $('#ac-status').innerHTML = 'The local bridge is not running. This page is static; to build in Archicad run <code>python3 serve.py</code> in the project folder and open <code>http://localhost:8000</code>.';
    } else if (!s.archicad) {
      $('#ac-status').textContent = `Bridge running, but Archicad was not found on ports ${s.ports || '19723–19744'}. Open a project in Archicad with Tapir installed.`;
    } else {
      $('#ac-status').textContent = `Connected: Archicad on port ${s.port}, Tapir ${s.tapir || '?'}${s.missing && s.missing.length ? ` — missing commands: ${s.missing.join(', ')}` : ''}.`;
    }
  }

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    (j.log || []).forEach(log);
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  $('#btn-archicad').addEventListener('click', openArchicad);
  $('#ac-build').addEventListener('click', async () => {
    const b = $('#ac-build');
    b.disabled = true;
    log(`→ Building ${model.boxes.length} elements…`);
    try {
      const j = await post('api/build', {
        model, options: { walls: $('#ac-walls').checked, replace: $('#ac-replace').checked, floorIndex: Number($('#ac-floor').value) || 0 },
      });
      log(`✓ Done: ${j.created} elements created${j.failed ? `, ${j.failed} failed` : ''}.`);
    } catch (e) { log('✗ ' + e.message); }
    b.disabled = false;
  });
  $('#ac-test').addEventListener('click', async () => {
    log('→ Test placement (one of each element type, then removed)…');
    try { await post('api/test', { model }); } catch (e) { log('✗ ' + e.message); }
  });

  // ------------------------------------------------------------------ boot
  buildLayoutGrid();
  buildFields();
  refresh();
  checkBridge();
  window.addEventListener('hashchange', () => { params = Object.assign({}, G.DEFAULTS, readHash()); refresh(); });
})();

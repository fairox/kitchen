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
  // The site (room size, walls, openings — G.ROOM_KEYS) becomes fixed the first
  // time it is edited by hand. A fixed site is kept in this browser and in the
  // link, and nothing else (layouts, island, reset) may change it.
  const SITE_STORE = 'kitchen-configurator.site.v1';
  const pickRoom = (p) => Object.fromEntries(G.ROOM_KEYS.map((k) => [k, JSON.parse(JSON.stringify(p[k]))]));
  function loadSite() {
    try { const v = JSON.parse(localStorage.getItem(SITE_STORE)); return v && v.roomW ? v : null; } catch (e) { return null; }
  }
  function saveSite() {
    try {
      if (params.siteFixed) localStorage.setItem(SITE_STORE, JSON.stringify(pickRoom(params)));
      else localStorage.removeItem(SITE_STORE);
    } catch (e) { /* storage unavailable: the link still carries the site */ }
  }

  // the hash stores a diff against DEFAULTS, so it is applied on top of DEFAULTS alone;
  // without a hash, a site fixed earlier in this browser is restored
  const fromHash = readHash();
  const storedSite = Object.keys(fromHash).length ? null : loadSite();
  let params = Object.keys(fromHash).length
    ? Object.assign({}, G.DEFAULTS, fromHash)
    : storedSite
      ? Object.assign({}, G.DEFAULTS, G.layoutDefaults(G.DEFAULTS.layout, storedSite), storedSite, { siteFixed: true })
      : Object.assign({}, G.DEFAULTS, G.LAYOUTS[G.DEFAULTS.layout].defaults, { siteFixed: false });
  let model = null;
  let highlight = null;
  let highlightOpening = null;

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
      ],
    },
    { title: 'Openings', open: true, custom: 'openings' },
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
    {
      title: 'Walls', open: true, fields: [
        ...['back', 'left', 'right', 'front'].map((w) => ({
          key: `style${w[0].toUpperCase()}${w.slice(1)}`, label: `${w[0].toUpperCase()}${w.slice(1)} wall`, type: 'seg',
          options: [['standard', 'Base + wall'], ['tall', 'Tall to ceiling'], ['base', 'Base only']], show: has(w),
        })),
        { key: 'tallNiche', label: 'Open niche in tall walls', min: 0, max: 2400, step: 50, unit: 'mm',
          show: (p) => ['Back', 'Left', 'Right', 'Front'].some((w) => p[`style${w}`] === 'tall' && G.LAYOUTS[p.layout].runs.includes(w.toLowerCase())) },
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
        { key: 'fronts', label: 'Door & drawer fronts with handles', type: 'toggle' },
      ],
    },
    {
      title: 'Wall & tall units', open: false, fields: [
        { key: 'wallCabs', label: 'Wall cabinets', type: 'toggle' },
        { key: 'wallCabElev', label: 'Wall unit bottom', min: 1300, max: 1700, step: 10, unit: 'mm', show: (p) => p.wallCabs },
        { key: 'wallCabH', label: 'Wall unit height', min: 300, max: 1100, step: 10, unit: 'mm', show: (p) => p.wallCabs },
        { key: 'wallCabDepth', label: 'Wall unit depth', min: 250, max: 450, step: 10, unit: 'mm', show: (p) => p.wallCabs },
        { key: 'alignTops', label: 'Tall and wall units up to the ceiling', type: 'toggle' },
        { key: 'tallH', label: 'Tall unit height', min: 1800, max: 3000, step: 10, unit: 'mm', show: (p) => !p.alignTops },
        { key: 'pantryCount', label: 'Tall pantry units by the fridge', min: 0, max: 3, step: 1, unit: '' },
        { key: 'ovenTowers', label: 'Oven towers', min: 0, max: 3, step: 1, unit: '' },
        { key: 'ovenRun', label: 'Oven towers on', type: 'select', show: (p) => p.ovenTowers > 0,
          options: (p) => G.runOptions(p.layout, false).filter((r) => !r.freestanding).map((r) => [r.id, r.label]) },
        { key: 'ovenPos', label: 'Oven tower position', min: 0, max: 1, step: 0.01, unit: '%', show: (p) => p.ovenTowers > 0 },
        { key: 'handles', label: 'Handles', type: 'seg', options: [['bar', 'Bar handles'], ['none', 'Handleless']], show: (p) => p.fronts },
      ],
    },
    { title: 'Finish', open: false, custom: 'finish' },
  ];

  const PRESETS = [
    // after the reference photos: oak base and tall units with cashmere wall units; mocha tall wall over stone
    { name: 'Oak & cashmere', frontColor: '#b08f6e', wallFrontColor: '#ddd4c6', tallFrontColor: '#a9876a', woodBase: true, woodWall: false, woodTall: true, counterColor: '#e4ddd2', floorColor: '#d9d2c7', wallColor: '#ece7df', handles: 'none' },
    { name: 'Mocha & stone', frontColor: '#5b4842', wallFrontColor: '#5b4842', tallFrontColor: '#57443e', woodBase: false, woodWall: false, woodTall: false, counterColor: '#e7e3dc', floorColor: '#8e8a84', wallColor: '#d9d6d0', handles: 'none' },
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
      if (sec.title === 'Room') buildSiteBar(d);
      if (sec.custom === 'openings') buildOpenings(d);
      else if (sec.custom === 'appliances') buildAppliances(d);
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
    d.appendChild(buildField({ key: 'prepSink', label: 'Prep sink on the island', type: 'toggle', show: (p) => p.island }));
    d.appendChild(buildField({ key: 'windowOverSink', label: 'Sink under a window (adds one if the room is not fixed)', type: 'toggle' }));
    d.appendChild(buildField({ key: 'windowW', label: 'Window width', min: 600, max: 2400, step: 50, unit: 'mm', show: (p) => p.windowOverSink }));
  }

  // ------------------------------------------------------------------ site (fixed room) bar
  let siteBar = null;
  function buildSiteBar(d) {
    siteBar = document.createElement('div');
    siteBar.className = 'site-bar';
    siteBar.innerHTML = `<span class="site-state"></span><button class="site-toggle"></button>`;
    $('.site-toggle', siteBar).addEventListener('click', () => {
      if (params.siteFixed) {
        params.siteFixed = false;
        toast('Room released — layouts may resize it again.');
      } else {
        params.siteFixed = true;
        toast('Room and openings fixed.');
      }
      refresh();
    });
    d.appendChild(siteBar);
  }
  function renderSiteBar() {
    if (!siteBar) return;
    siteBar.classList.toggle('fixed', !!params.siteFixed);
    const from = params.siteSource ? ` from ${escapeHtml(params.siteSource)}, placed at ${Math.round(params.originX)}, ${Math.round(params.originY)} mm` : '';
    $('.site-state', siteBar).innerHTML = params.siteFixed
      ? `<b>Room fixed</b> ${params.roomW} × ${params.roomD} × ${params.wallH} mm${from} · ${params.openings.length} opening${params.openings.length === 1 ? '' : 's'}. Layouts are fitted around it.`
      : '<b>Room not fixed</b> — layouts use their own sample room. Edit any size or opening to fix it.';
    $('.site-toggle', siteBar).textContent = params.siteFixed ? 'Release' : 'Fix room';
  }

  // ------------------------------------------------------------------ openings editor
  // Each opening is placed by wall, reference corner and an exact offset in mm
  // from that interior corner to the opening's near edge (see generator.js).
  const TYPE_LABEL = { door: 'Door', window: 'Window', threshold: 'Threshold' };
  const WALL_LABEL = { back: 'Back', front: 'Front', left: 'Left', right: 'Right' };
  const cornerNames = (wall) => (wall === 'back' || wall === 'front' ? ['left', 'right'] : ['front', 'back']);
  let opList = null;
  let opSignature = '';

  function buildOpenings(d) {
    opList = document.createElement('div');
    opList.className = 'op-list';
    d.appendChild(opList);
    const add = document.createElement('div');
    add.className = 'op-add';
    add.innerHTML = '<button data-t="door">+ Door</button><button data-t="window">+ Window</button><button data-t="threshold">+ Threshold</button>';
    $$('button', add).forEach((b) => b.addEventListener('click', () => addOpening(b.dataset.t)));
    d.appendChild(add);
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Offset = distance from the chosen interior corner to the near edge of the opening. Corners are named as seen in plan.';
    d.appendChild(hint);
  }

  function addOpening(type) {
    const walls = model.walls.map((w) => w.id);
    const pref = { door: 'front', window: 'back', threshold: 'right' }[type];
    const wall = walls.includes(pref) ? pref : walls[0];
    const len = wall === 'back' || wall === 'front' ? params.roomW : params.roomD;
    const width = { door: 900, window: 1200, threshold: 1200 }[type];
    const prefix = { door: 'D', window: 'W', threshold: 'T' }[type];
    const n = 1 + Math.max(0, ...params.openings.map((o) => (o.id || '').startsWith(prefix) ? Number(o.id.slice(1)) || 0 : 0));
    const o = { id: `${prefix}${n}`, type, wall, from: 'start', offset: Math.max(0, Math.round((len - width) / 20) * 10), width };
    if (type === 'door') Object.assign(o, { height: 2100, hinge: 'start', swing: 'in' });
    if (type === 'window') Object.assign(o, { height: 1200, sill: 1050 });
    if (type === 'threshold') Object.assign(o, { height: Math.min(2200, params.wallH - 300), beamWidth: 0, bearing: 200 });
    params.openings = params.openings.concat([o]);
    fixSite();
    refresh();
  }

  function setOpening(i, key, value) {
    const patch = { [key]: value };
    if (key === 'from') { // keep the opening where it is, just measure it from the other corner
      const placed = model.openings.find((x) => x.id === params.openings[i].id);
      if (placed) patch.offset = value === 'start' ? placed.fromStart : placed.fromEnd;
    }
    params.openings = params.openings.map((o, j) => (j === i ? Object.assign({}, o, patch) : o));
    fixSite();
    refresh();
  }

  function renderOpenings() {
    if (!opList) return;
    const ops = model.params.openings;
    const walls = model.walls.map((w) => w.id);
    const sig = ops.map((o) => `${o.id}:${o.type}:${o.wall}`).join('|') + '#' + walls.join(',');
    if (sig !== opSignature) {
      opSignature = sig;
      opList.innerHTML = ops.length ? '' : '<p class="hint">No openings. Add a door, window or threshold.</p>';
      ops.forEach((o, i) => opList.appendChild(openingCard(o, i, walls)));
    }
    ops.forEach((o, i) => {
      const card = opList.children[i];
      if (!card || !card.classList.contains('op-card')) return;
      for (const inp of $$('input[data-k]', card)) if (document.activeElement !== inp) inp.value = o[inp.dataset.k];
      for (const sg of $$('.seg[data-k]', card)) $$('button', sg).forEach((b) => b.classList.toggle('active', o[sg.dataset.k] === b.dataset.v));
      const placed = model.openings.find((x) => x.id === o.id);
      const [c0, c1] = cornerNames(o.wall);
      const ro = $('.op-readout', card);
      if (!placed) { ro.textContent = 'Ignored: this wall is open in the current layout.'; ro.classList.add('bad'); return; }
      ro.classList.remove('bad');
      let txt = `${placed.fromStart} mm from ${c0} corner · ${placed.fromEnd} mm from ${c1} corner`;
      if (placed.kind === 'threshold') txt += ` · beam ${placed.beamW}×${placed.beamD} mm`;
      if (placed.kind === 'window') txt += ` · head at ${placed.sill + placed.h} mm`;
      ro.textContent = txt;
    });
  }

  function openingCard(o, i, walls) {
    const card = document.createElement('div');
    card.className = `op-card op-${o.type}`;
    const [c0, c1] = cornerNames(o.wall);
    const num = (k, label, step = 10) => `<label class="op-num"><span>${label}</span><input type="number" step="${step}" data-k="${k}"><em>mm</em></label>`;
    const seg = (k, opts) => `<div class="seg" data-k="${k}">${opts.map(([v, l]) => `<button data-v="${v}">${l}</button>`).join('')}</div>`;
    card.innerHTML = `
      <div class="op-head"><span class="op-tag">${o.id}</span><strong>${TYPE_LABEL[o.type]}</strong>
        <select data-wall>${['back', 'front', 'left', 'right'].map((w) => `<option value="${w}" ${w === o.wall ? 'selected' : ''} ${walls.includes(w) ? '' : 'disabled'}>${WALL_LABEL[w]} wall</option>`).join('')}</select>
        <button class="op-del" title="Remove">×</button></div>
      <div class="op-row"><span class="op-lbl">From</span>${seg('from', [['start', `${c0} corner`], ['end', `${c1} corner`]])}</div>
      <div class="op-grid">
        ${num('offset', 'Offset')}${num('width', 'Width')}${num('height', o.type === 'threshold' ? 'Clear ht' : 'Height')}
        ${o.type === 'window' ? num('sill', 'Sill') : ''}
        ${o.type === 'threshold' ? num('beamWidth', 'Beam w') + num('bearing', 'Bearing') : ''}
      </div>
      ${o.type === 'door' ? `<div class="op-row"><span class="op-lbl">Hinge</span>${seg('hinge', [['start', c0], ['end', c1]])}<span class="op-lbl">Swing</span>${seg('swing', [['in', 'In'], ['out', 'Out']])}</div>` : ''}
      <div class="op-readout"></div>`;
    $('[data-wall]', card).addEventListener('change', (e) => setOpening(i, 'wall', e.target.value));
    $('.op-del', card).addEventListener('click', () => { params.openings = params.openings.filter((_, j) => j !== i); fixSite(); refresh(); });
    for (const inp of $$('input[data-k]', card)) {
      inp.addEventListener('change', () => setOpening(i, inp.dataset.k, Number(inp.value)));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    }
    for (const sg of $$('.seg[data-k]', card)) {
      $$('button', sg).forEach((b) => b.addEventListener('click', () => setOpening(i, sg.dataset.k, b.dataset.v)));
    }
    const beamW = $('input[data-k="beamWidth"]', card);
    if (beamW) beamW.placeholder = 'wall';
    card.addEventListener('mouseenter', () => { highlightOpening = o.id; drawPlan(); });
    card.addEventListener('mouseleave', () => { highlightOpening = null; drawPlan(); });
    return card;
  }

  function buildFinish(d) {
    const pre = document.createElement('div');
    pre.className = 'seg presets';
    pre.style.marginBottom = '10px';
    pre.innerHTML = PRESETS.map((p, i) => `<button data-i="${i}">${p.name}</button>`).join('');
    $$('button', pre).forEach((b) => b.addEventListener('click', () => {
      const p = PRESETS[b.dataset.i];
      const { name, ...look } = p;
      Object.assign(params, { wallFrontColor: p.frontColor, tallFrontColor: p.frontColor, woodBase: false, woodWall: false, woodTall: false }, look);
      refresh();
    }));
    d.appendChild(pre);
    const grid = document.createElement('div');
    grid.className = 'colors';
    for (const [k, l] of [['frontColor', 'Base fronts'], ['wallFrontColor', 'Wall units'], ['tallFrontColor', 'Tall units'], ['counterColor', 'Worktop'], ['wallColor', 'Walls'], ['floorColor', 'Floor']]) {
      const c = document.createElement('label');
      c.className = 'color';
      c.innerHTML = `<input type="color"> ${l}`;
      const inp = $('input', c);
      inp.addEventListener('input', () => set(k, inp.value));
      fieldEls.push({ f: { key: k }, wrap: c, sync: () => (inp.value = params[k]) });
      grid.appendChild(c);
    }
    d.appendChild(grid);
    const wood = document.createElement('div');
    wood.className = 'wood-row';
    wood.innerHTML = '<span class="op-lbl">Wood grain</span>';
    for (const [k, l] of [['woodBase', 'Base'], ['woodWall', 'Wall'], ['woodTall', 'Tall']]) {
      const lab = document.createElement('label');
      lab.className = 'toggle';
      lab.innerHTML = `<input type="checkbox"><span>${l}</span>`;
      const inp = $('input', lab);
      inp.addEventListener('change', () => set(k, inp.checked));
      fieldEls.push({ f: { key: k }, wrap: lab, sync: () => (inp.checked = !!params[k]) });
      wood.appendChild(lab);
    }
    d.appendChild(wood);
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
  // With a fixed site each thumbnail is that layout generated in *this* room,
  // with a badge counting the errors it would have there.
  let thumbSig = '';
  function drawThumbs() {
    const room = params.siteFixed ? pickRoom(params) : null;
    const sig = JSON.stringify(room);
    if (sig === thumbSig) return;
    thumbSig = sig;
    for (const b of $$('.layout-card')) {
      const id = b.dataset.layout;
      const base = room
        ? Object.assign({}, params, G.layoutDefaults(id, room), room, { layout: id, island: false })
        : Object.assign({}, G.DEFAULTS, G.LAYOUTS[id].defaults, { layout: id });
      const m = G.generate(Object.assign(base, { wallCabs: false }));
      KitchenPlan.draw($('canvas', b), m, { thumb: true, dims: false });
      const errors = room ? m.checks.filter((c) => c.level === 'error') : [];
      let badge = $('.layout-badge', b);
      if (!badge) { badge = document.createElement('i'); badge.className = 'layout-badge'; b.appendChild(badge); }
      badge.hidden = !errors.length;
      badge.textContent = errors.length;
      b.title = errors.length ? `In this room: ${errors.map((c) => c.msg).join(' ')}` : '';
    }
  }

  // ------------------------------------------------------------------ mutations
  function set(key, value) {
    if (typeof G.DEFAULTS[key] === 'number') value = Number(value);
    params[key] = value;
    if (G.ROOM_KEYS.includes(key)) fixSite();
    refresh();
  }

  function fixSite() {
    if (params.siteFixed) return;
    params.siteFixed = true;
    toast('Room and openings are now fixed — layouts will be fitted around them.');
  }

  function setLayout(id) {
    const room = params.siteFixed ? pickRoom(params) : null;
    const defaults = room ? G.layoutDefaults(id, room) : G.layoutDefaults(id);
    const wantIsland = ('island' in defaults ? defaults.island : params.island) && G.LAYOUTS[id].island;
    params = Object.assign({}, params, defaults, room || {}, { layout: id, island: false });
    if (wantIsland) { // keep the island, re-fitted to this layout (and to the fixed room)
      const patch = G.fitIsland(params, { fixedRoom: !!room });
      if (patch.fail) toast(`Island removed: ${patch.fail}`);
      else Object.assign(params, patch);
    }
    viewer.reframe();
    refresh();
  }

  $('#island-toggle input').addEventListener('change', (e) => {
    params.island = e.target.checked;
    if (params.island) {
      const patch = G.fitIsland(params, { fixedRoom: !!params.siteFixed });
      if (patch.fail) {
        params.island = false;
        e.target.checked = false;
        toast(patch.fail);
      } else {
        if (patch.roomW || patch.roomD) {
          toast(`Room enlarged to ${patch.roomW || params.roomW} × ${patch.roomD || params.roomD} mm to fit the island. Edit the room to fix its size.`);
          viewer.reframe();
        }
        Object.assign(params, patch);
      }
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
    renderOpenings();
    renderSiteBar();
    saveSite();
    drawThumbs();
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
      triangle: $('#show-tri').checked, dims: $('#show-dims').checked, wallCabs: $('#show-wc').checked, highlight, highlightOpening,
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
      ['Openings', model.openings.length ? model.openings.map((o) => o.id).join(', ') : '—'],
      ['Elements', model.boxes.length + model.walls.reduce((a, w) => a + w.segments.length, 0) + model.openings.length + model.beams.length],
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
  // Reset rebuilds the kitchen; a fixed site stays as it is
  $('#btn-reset').addEventListener('click', () => {
    const room = params.siteFixed ? pickRoom(params) : null;
    params = Object.assign({}, G.DEFAULTS, room ? G.layoutDefaults(params.layout, room) : G.LAYOUTS[params.layout].defaults,
      room || {}, { layout: params.layout, siteFixed: !!room });
    toast(room ? 'Kitchen reset — the fixed room and openings were kept.' : 'Reset to layout defaults.');
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
    $('#ac-walls').checked = params.acWalls !== false;
    $('#ac-floor').value = params.acFloor || 0;
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
  if (storedSite) toast('Restored your fixed room and openings.');
  checkBridge();
  window.addEventListener('hashchange', () => { params = Object.assign({}, G.DEFAULTS, readHash()); refresh(); });
})();

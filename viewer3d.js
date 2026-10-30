/*
 * 3D view — Three.js r128 (UMD) + OrbitControls. Builds meshes from the same
 * element list the Archicad builder uses. The scene works in z-up millimetres
 * inside a group that is rotated/scaled into Three's y-up metres.
 */
(function (root) {
  'use strict';

  function KitchenViewer(container) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#eef0f2').convertSRGBToLinear();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;

    scene.add(new THREE.HemisphereLight(0xffffff, 0xa89f92, 0.9));
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target);

    const world = new THREE.Group();
    world.rotation.x = -Math.PI / 2; // z-up -> y-up
    world.scale.setScalar(0.001); // mm -> m
    scene.add(world);

    // Colours are given as sRGB hex; r128 materials expect linear values when
    // the renderer outputs sRGB, otherwise everything washes out towards white.
    const mats = {};
    const mat = (key, color, opts) => {
      if (!mats[key]) mats[key] = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.7, metalness: 0 }, opts));
      mats[key].color.set(color).convertSRGBToLinear();
      return mats[key];
    };
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x2b2a28, transparent: true, opacity: 0.28 });

    // light oak planks, 1200 x 800 mm per tile, tinted by the floor colour
    const floorTex = (() => {
      const c = document.createElement('canvas');
      c.width = 1200; c.height = 800;
      const g = c.getContext('2d');
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let row = 0; row < 4; row++) {
        const off = (row % 2) * 600 + (row === 3 ? 300 : 0);
        for (let k = -1; k < 2; k++) {
          const x = off + k * 1200;
          const v = 225 + Math.round(rnd() * 22);
          g.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
          g.fillRect(x, row * 200, 1200, 200);
          g.strokeStyle = 'rgba(80,60,40,0.10)';
          for (let i = 0; i < 6; i++) { // grain
            g.beginPath();
            const y = row * 200 + 20 + rnd() * 160;
            g.moveTo(x, y); g.bezierCurveTo(x + 400, y + rnd() * 10 - 5, x + 800, y + rnd() * 10 - 5, x + 1200, y);
            g.stroke();
          }
          g.fillStyle = 'rgba(60,45,30,0.35)';
          g.fillRect(x, row * 200, 3, 200);
        }
        g.fillStyle = 'rgba(60,45,30,0.35)';
        g.fillRect(0, row * 200, 1200, 2);
      }
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.encoding = THREE.sRGBEncoding;
      t.anisotropy = 4;
      return t;
    })();

    let framed = null;
    let cutaway = true;
    let wallMeshes = [];

    function clear() {
      while (world.children.length) {
        const o = world.children.pop();
        o.traverse((c) => { if (c.geometry) c.geometry.dispose(); });
      }
      wallMeshes = [];
    }

    function addBox(b, material, opts) {
      opts = opts || {};
      const g = new THREE.BoxGeometry(b.L, b.D, b.H);
      const m = new THREE.Mesh(g, material);
      m.position.set(b.cx, b.cy, b.z + b.H / 2);
      m.rotation.z = Math.atan2(b.uy, b.ux);
      m.castShadow = opts.shadow !== false;
      m.receiveShadow = true;
      m.userData.id = b.id;
      if (opts.edges !== false) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat));
      world.add(m);
      return m;
    }

    // a handle bar on the front face of a cabinet box (only when fronts are off)
    function addHandle(b, zRel, vertical) {
      const hm = mat('handle', '#8a8780', { metalness: 0.6, roughness: 0.35 });
      const len = vertical ? Math.min(400, b.H * 0.4) : Math.min(b.L * 0.5, 320);
      const g = vertical ? new THREE.BoxGeometry(14, 22, len) : new THREE.BoxGeometry(len, 22, 14);
      const m = new THREE.Mesh(g, hm);
      const t = b.D / 2 + 11; // in front of the face, along n
      m.position.set(b.cx + b.nx * t, b.cy + b.ny * t, b.z + zRel);
      m.rotation.z = Math.atan2(b.uy, b.ux);
      world.add(m);
    }

    function update(model) {
      clear();
      const p = model.params;
      const front = mat('front', p.frontColor, { roughness: 0.5 });
      const carcass = mat('carcass', p.frontColor, { roughness: 0.75 });
      const top = mat('counter', p.counterColor, { roughness: 0.3 });
      const steel = mat('steel', '#c4c7ca', { metalness: 0.6, roughness: 0.32 });
      const steelDoor = mat('steelDoor', '#d2d5d8', { metalness: 0.55, roughness: 0.28 });
      const glass = mat('glass', '#141414', { roughness: 0.12, metalness: 0.3 });
      const oven = mat('oven', '#202122', { roughness: 0.1, metalness: 0.4 });
      const handle = mat('handle', '#77756f', { metalness: 0.7, roughness: 0.3 });
      const plinth = mat('plinth', '#3f3e3b');
      const bowl = mat('bowl', '#b8bcbf', { metalness: 0.8, roughness: 0.22 });
      const stool = mat('stool', '#8a6a4c', { roughness: 0.6 });
      const wallM = mat('wall', p.wallColor, { roughness: 0.95 });
      const floorM = mat('floor', p.floorColor, { roughness: 0.8, map: floorTex });
      const wood = mat('frame', '#efece6', { roughness: 0.6 });
      const pane = mat('pane', '#bcd6e8', { transparent: true, opacity: 0.3, roughness: 0.05, metalness: 0.1 });
      const finishes = { front, steel: steelDoor, oven };

      // floor
      const fw = p.roomW + 2 * p.wallT, fd = p.roomD + 2 * p.wallT;
      floorTex.repeat.set(fw / 1200, fd / 800);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), floorM);
      floor.position.set(p.roomW / 2, p.roomD / 2, 0);
      floor.receiveShadow = true;
      world.add(floor);

      for (const b of model.boxes) {
        switch (b.kind) {
          case 'base': case 'corner': case 'sinkBase': case 'cookBase': case 'filler': case 'dishwasher': {
            addBox(b, p.fronts ? carcass : front);
            if (!p.fronts && b.kind !== 'filler' && b.L > 250) addHandle(b, b.H - 60, false);
            break;
          }
          case 'pantry': addBox(b, p.fronts ? carcass : front); if (!p.fronts) addHandle(b, b.H * 0.45, true); break;
          case 'fridge': addBox(b, steel); if (!p.fronts) addHandle(b, b.H * 0.55, true); break;
          case 'wallCab': addBox(b, p.fronts ? carcass : front); if (!p.fronts) addHandle(b, 60, false); break;
          case 'front': addBox(b, finishes[b.finish] || front); break;
          case 'handle': addBox(b, handle, { edges: false }); break;
          case 'plinth': addBox(b, plinth, { shadow: false, edges: false }); break;
          case 'counter': addBox(b, top); break;
          case 'panel': case 'wallFiller': addBox(b, front); break;
          case 'sinkBowl': addBox(b, bowl, { shadow: false }); break;
          case 'tap': addBox(b, steel, { edges: false }); break;
          case 'cooktop': addBox(b, glass, { shadow: false }); break;
          case 'hood': addBox(b, steel); break;
          case 'stool': {
            const seat = new THREE.Mesh(new THREE.CylinderGeometry(175, 160, 60, 28), stool);
            seat.rotation.x = Math.PI / 2;
            seat.position.set(b.cx, b.cy, b.H - 30);
            seat.castShadow = true;
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(22, 30, b.H - 60, 12), steel);
            leg.rotation.x = Math.PI / 2;
            leg.position.set(b.cx, b.cy, (b.H - 60) / 2);
            leg.castShadow = true;
            const foot = new THREE.Mesh(new THREE.CylinderGeometry(150, 160, 14, 28), steel);
            foot.rotation.x = Math.PI / 2;
            foot.position.set(b.cx, b.cy, 7);
            const ring = new THREE.Mesh(new THREE.TorusGeometry(130, 9, 8, 32), steel);
            ring.position.set(b.cx, b.cy, b.H * 0.4);
            world.add(seat, leg, foot, ring);
            break;
          }
          default: addBox(b, front);
        }
      }

      // walls split around openings, with window frames and an open door leaf
      for (const w of model.walls) {
        const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
        const ux = (w.x2 - w.x1) / len, uy = (w.y2 - w.y1) / len;
        const nx = -uy, ny = ux;
        const at = (d, o) => [w.x1 + ux * d + nx * o, w.y1 + uy * d + ny * o];
        const piece = (a, b, z0, z1, D, o, material, tag) => {
          const [cx, cy] = at((a + b) / 2, o || 0);
          const m = addBox({ cx, cy, z: z0, L: b - a, D, H: z1 - z0, ux, uy, nx, ny, id: w.id }, material);
          if (tag !== false) { m.userData.wall = w.id; wallMeshes.push(m); }
          return m;
        };
        const ops = model.openings.filter((o) => o.wall === w.id).sort((a, b) => a.offset - b.offset);
        let cur = 0;
        for (const o of ops) {
          const a = o.offset - o.w / 2, b = o.offset + o.w / 2;
          if (a > cur) piece(cur, a, 0, w.h, w.t);
          if (o.sill > 0) piece(a, b, 0, o.sill, w.t);
          if (o.sill + o.h < w.h) piece(a, b, o.sill + o.h, w.h, w.t);
          const F = 60, FD = Math.min(80, w.t); // frame width and depth
          if (o.kind === 'window') {
            piece(a, a + F, o.sill, o.sill + o.h, FD, 0, wood);
            piece(b - F, b, o.sill, o.sill + o.h, FD, 0, wood);
            piece(a, b, o.sill, o.sill + F, FD, 0, wood);
            piece(a, b, o.sill + o.h - F, o.sill + o.h, FD, 0, wood);
            if (o.w > 900) piece(o.offset - 25, o.offset + 25, o.sill + F, o.sill + o.h - F, FD * 0.8, 0, wood);
            piece(a + F, b - F, o.sill + F, o.sill + o.h - F, 10, 0, pane);
          } else {
            // casing on both faces, then the leaf standing open at 90° into the room
            for (const side of [-1, 1]) {
              const off = side * (w.t / 2 + 8);
              piece(a - 60, a, 0, o.h + 60, 16, off, wood);
              piece(b, b + 60, 0, o.h + 60, 16, off, wood);
              piece(a - 60, b + 60, o.h, o.h + 60, 16, off, wood);
            }
            const mid = at(o.offset, 0);
            const room = ((p.roomW / 2 - mid[0]) * nx + (p.roomD / 2 - mid[1]) * ny) > 0 ? 1 : -1;
            const leafU = [nx * room, ny * room];
            const hinge = at(a + 20, room * w.t / 2);
            const leafW = o.w - 40;
            const leaf = { cx: hinge[0] + leafU[0] * leafW / 2, cy: hinge[1] + leafU[1] * leafW / 2, z: 5, L: leafW, D: 40, H: o.h - 10, ux: leafU[0], uy: leafU[1], id: o.id };
            const kh = { cx: leaf.cx + leafU[0] * (leafW / 2 - 70) + ux * 30, cy: leaf.cy + leafU[1] * (leafW / 2 - 70) + uy * 30, z: 1000, L: 120, D: 20, H: 20, ux: leafU[0], uy: leafU[1] };
            for (const m of [addBox(leaf, wood), addBox(kh, handle, { edges: false })]) { // hidden with its wall
              m.userData.wall = w.id;
              wallMeshes.push(m);
            }
          }
          cur = b;
        }
        if (cur < len) piece(cur, len, 0, w.h, w.t);
      }

      // lights & first framing
      const cx = p.roomW / 2 / 1000, cz = -p.roomD / 2 / 1000;
      sun.position.set(cx - 3, 6, cz + 5);
      sun.target.position.set(cx, 0, cz);
      const ext = Math.max(p.roomW, p.roomD) / 1000;
      Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 0.5, far: 20 });
      sun.shadow.camera.updateProjectionMatrix();
      const key = `${p.layout}:${p.roomW}x${p.roomD}`;
      if (framed !== key) { frame(p); framed = key; }
      applyCutaway();
    }

    // fit the room's bounding sphere, using whichever of the two FOVs is narrower
    let lastParams = null;
    let userMoved = false;
    controls.addEventListener('start', () => { userMoved = true; });
    function fitDistance(p, margin) {
      const r = 0.5 * Math.hypot(p.roomW + 2 * p.wallT, p.roomD + 2 * p.wallT, p.wallH) / 1000;
      const v = THREE.MathUtils.degToRad(camera.fov);
      const h = 2 * Math.atan(Math.tan(v / 2) * camera.aspect);
      return (r * margin) / Math.sin(Math.min(v, h) / 2);
    }
    function frame(p, dir) {
      lastParams = p;
      userMoved = false;
      const cx = p.roomW / 2000, cz = -p.roomD / 2000;
      const def = p.layout === 'galley' ? [1, 0.75, 0.3] : [0.42, 0.62, 1]; // galleys read best from an open end
      const d = new THREE.Vector3(...(dir || def)).normalize().multiplyScalar(fitDistance(p, 1.0));
      controls.target.set(cx, p.wallH / 3000, cz);
      camera.position.copy(controls.target).add(d);
      controls.update();
    }

    // hide walls between the camera and the room so the kitchen stays visible
    function applyCutaway() {
      const t = controls.target;
      const dx = camera.position.x - t.x, dz = camera.position.z - t.z;
      for (const m of wallMeshes) {
        if (!cutaway) { m.visible = true; continue; }
        const wid = m.userData.wall;
        const hide = (wid === 'front' && dz > 0.6) || (wid === 'back' && dz < -0.6) || (wid === 'left' && dx < -0.6) || (wid === 'right' && dx > 0.6);
        m.visible = !hide;
      }
    }

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + 'px';
      renderer.domElement.style.height = h + 'px';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (lastParams && !userMoved) frame(lastParams);
    }

    let running = true;
    function loop() {
      if (!running) return;
      requestAnimationFrame(loop);
      controls.update();
      applyCutaway();
      renderer.render(scene, camera);
    }
    new ResizeObserver(resize).observe(container);
    resize();
    loop();

    return {
      update,
      reframe: () => { framed = null; },
      setCutaway: (v) => { cutaway = v; applyCutaway(); },
      snapshot: () => renderer.domElement.toDataURL('image/png'),
      setView(name, p) {
        frame(p, name === 'top' ? [0, 1, 0.001] : name === 'front' ? [0, 0.25, 1] : null);
      },
    };
  }

  root.KitchenViewer = KitchenViewer;
})(typeof self !== 'undefined' ? self : this);

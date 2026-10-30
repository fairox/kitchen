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
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#eef0f2');
    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b0a4, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target);

    const world = new THREE.Group();
    world.rotation.x = -Math.PI / 2; // z-up -> y-up
    world.scale.setScalar(0.001); // mm -> m
    scene.add(world);

    const mats = {};
    const mat = (key, color, opts) => {
      if (!mats[key]) mats[key] = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.7, metalness: 0 }, opts));
      else mats[key].color.set(color);
      return mats[key];
    };

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
      world.add(m);
      return m;
    }

    // a handle bar on the front face of a cabinet box
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
      const front = mat('front', p.frontColor, { roughness: 0.55 });
      const top = mat('counter', p.counterColor, { roughness: 0.35 });
      const steel = mat('steel', '#b9bcbf', { metalness: 0.75, roughness: 0.3 });
      const glass = mat('glass', '#151515', { roughness: 0.15, metalness: 0.2 });
      const plinth = mat('plinth', '#4b4a47');
      const bowl = mat('bowl', '#c9ccce', { metalness: 0.8, roughness: 0.25 });
      const stool = mat('stool', '#6b5a48', { roughness: 0.6 });
      const wallM = mat('wall', p.wallColor, { roughness: 0.95 });
      const floorM = mat('floor', p.floorColor, { roughness: 0.85 });

      // floor
      const fg = new THREE.PlaneGeometry(p.roomW + 2 * p.wallT, p.roomD + 2 * p.wallT);
      const floor = new THREE.Mesh(fg, floorM);
      floor.position.set(p.roomW / 2, p.roomD / 2, 0);
      floor.receiveShadow = true;
      world.add(floor);

      for (const b of model.boxes) {
        switch (b.kind) {
          case 'base': case 'corner': case 'sinkBase': case 'cookBase': case 'filler': {
            addBox(b, front);
            if (b.kind !== 'filler' && b.L > 250) addHandle(b, b.H - 60, false);
            break;
          }
          case 'dishwasher': addBox(b, front); addHandle(b, b.H - 60, false); break;
          case 'pantry': addBox(b, front); addHandle(b, b.H * 0.45, true); break;
          case 'fridge': addBox(b, steel); addHandle(b, b.H * 0.55, true); break;
          case 'wallCab': addBox(b, front); addHandle(b, 60, false); break;
          case 'plinth': addBox(b, plinth, { shadow: false }); break;
          case 'counter': addBox(b, top); break;
          case 'panel': addBox(b, front); break;
          case 'sinkBowl': addBox(b, bowl, { shadow: false }); break;
          case 'cooktop': addBox(b, glass, { shadow: false }); break;
          case 'hood': addBox(b, steel); break;
          case 'stool': {
            const g = new THREE.CylinderGeometry(175, 160, 60, 24);
            const seat = new THREE.Mesh(g, stool);
            seat.rotation.x = Math.PI / 2;
            seat.position.set(b.cx, b.cy, b.H - 30);
            seat.castShadow = true;
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(22, 30, b.H - 60, 12), steel);
            leg.rotation.x = Math.PI / 2;
            leg.position.set(b.cx, b.cy, (b.H - 60) / 2);
            leg.castShadow = true;
            world.add(seat, leg);
            break;
          }
          default: addBox(b, front);
        }
      }

      // walls, split around openings
      for (const w of model.walls) {
        const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
        const ux = (w.x2 - w.x1) / len, uy = (w.y2 - w.y1) / len;
        const ops = model.openings.filter((o) => o.wall === w.id).sort((a, b) => a.offset - b.offset);
        const pieces = []; // [a, b, z0, z1]
        let cur = 0;
        for (const o of ops) {
          const a = o.offset - o.w / 2, b = o.offset + o.w / 2;
          if (a > cur) pieces.push([cur, a, 0, w.h]);
          if (o.sill > 0) pieces.push([a, b, 0, o.sill]);
          if (o.sill + o.h < w.h) pieces.push([a, b, o.sill + o.h, w.h]);
          if (o.kind === 'window') {
            const gm = mat('pane', '#a8c8de', { transparent: true, opacity: 0.35, roughness: 0.05 });
            const c = (a + b) / 2;
            const pane = addBox({ cx: w.x1 + ux * c, cy: w.y1 + uy * c, z: o.sill, L: o.w, D: 20, H: o.h, ux, uy, id: o.id }, gm, { shadow: false });
            pane.userData.wall = w.id; wallMeshes.push(pane);
          }
          cur = b;
        }
        if (cur < len) pieces.push([cur, len, 0, w.h]);
        for (const [a, b, z0, z1] of pieces) {
          const c = (a + b) / 2;
          const m = addBox({ cx: w.x1 + ux * c, cy: w.y1 + uy * c, z: z0, L: b - a, D: w.t, H: z1 - z0, ux, uy, id: w.id }, wallM);
          m.userData.wall = w.id;
          wallMeshes.push(m);
        }
      }

      // lights & first framing
      const cx = p.roomW / 2 / 1000, cz = -p.roomD / 2 / 1000;
      sun.position.set(cx - 3, 6, cz + 5);
      sun.target.position.set(cx, 0, cz);
      const ext = Math.max(p.roomW, p.roomD) / 1000;
      Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 0.5, far: 20 });
      sun.shadow.camera.updateProjectionMatrix();
      const key = `${p.roomW}x${p.roomD}`;
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
      const d = new THREE.Vector3(...(dir || [0.42, 0.62, 1])).normalize().multiplyScalar(fitDistance(p, 1.0));
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

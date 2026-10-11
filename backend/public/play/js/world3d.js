// Builds New Meridian's Maple Court from the same data file the server uses for collision (world.json),
// so what you see is exactly what you can bump into.
import * as THREE from 'three';
import { buildingBoxes, WALL } from '/shared/sim.mjs';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.9, metalness: 0, ...o });
const BOX = new THREE.BoxGeometry(1, 1, 1);

function box(w, h, d, m, x, y, z, shadow = true) {
  const o = new THREE.Mesh(BOX, m); o.scale.set(w, h, d); o.position.set(x, y, z);
  o.castShadow = shadow; o.receiveShadow = true; return o;
}

function textSprite(text, w, h, bg = '#1e2a44', fg = '#ffffff', px = 56) {
  const c = document.createElement('canvas'); c.width = 512; c.height = Math.round(512 * h / w);
  const g = c.getContext('2d'); g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, c.width, c.height, 26); g.fill();
  g.fillStyle = fg; g.font = `800 ${px}px system-ui, "Segoe UI", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 3);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
}

function emojiTexture(emoji) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'); g.font = '88px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(emoji, 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const CONE = new THREE.ConeGeometry(1, 1, 7), SPH = new THREE.IcosahedronGeometry(1, 1), CYL = new THREE.CylinderGeometry(1, 1, 1, 8);
const part = (g, m, sx, sy, sz, x, y, z) => { const o = new THREE.Mesh(g, m); o.scale.set(sx, sy, sz); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; return o; };
const palm = (x, z, h = 6) => { const g = new THREE.Group(); g.add(part(CYL, mat('#8a6a43'), 0.22, h, 0.22, 0, h / 2, 0)); for (let i = 0; i < 6; i++) { const l = part(CONE, mat('#3e9a4d'), 0.35, 3.2, 0.35, Math.cos(i * 1.05) * 1.3, h + 0.1, Math.sin(i * 1.05) * 1.3); l.rotation.set(Math.sin(i * 1.05) * 1.2, 0, -Math.cos(i * 1.05) * 1.2); g.add(l); } g.position.set(x, 0, z); return g; };
const acacia = (x, z, s = 1) => { const g = new THREE.Group(); g.add(part(CYL, mat('#6b4f35'), 0.18 * s, 3.2 * s, 0.18 * s, 0, 1.6 * s, 0)); g.add(part(SPH, mat('#6f9a3c'), 2.6 * s, 0.7 * s, 2.6 * s, 0, 3.4 * s, 0)); g.position.set(x, 0, z); return g; };
const bush = (x, z, s = 1.2, c = '#2f8a46') => part(SPH, mat(c), s * 1.4, s * 1.6, s * 1.4, x, s * 0.9, z);

/** Distant, non-collidable scenery that gives each city its own skyline (the street layout itself is shared). */
function buildLandmark(kind, B, root) {
  const g = new THREE.Group(); root.add(g);
  const cx = (B.minX + B.maxX) / 2, cz = (B.minZ + B.maxZ) / 2;
  const water = (x, z, w, d) => { const m = box(w, 0.1, d, mat('#3a8fc9', { roughness: 0.25, metalness: 0.15 }), x, 0.03, z, false); g.add(m); };
  if (kind === 'sea' || kind === 'harbour') {
    g.add(box(10, 0.06, 160, mat('#e8d8a8'), B.maxX + 9, 0.02, cz, false));           // beach
    water(B.maxX + 55, cz, 90, 200);
    if (kind === 'sea') for (let i = -3; i <= 3; i++) g.add(palm(B.maxX + 6 + (i % 2) * 1.5, cz + i * 9 + 3));
    else { // harbour cranes and containers
      for (let i = 0; i < 3; i++) { const c = new THREE.Group(); c.add(box(1, 14, 1, mat('#e2572f'), 0, 7, 0), box(14, 0.8, 1, mat('#e2572f'), 4, 14, 0), box(0.6, 6, 0.6, mat('#555'), 10, 11, 0)); c.position.set(B.maxX + 12, 0, cz - 30 + i * 28); g.add(c); }
      ['#c0392b', '#2980b9', '#e0b030', '#27ae60'].forEach((col, i) => g.add(box(6, 2.4, 2.4, mat(col), B.maxX + 20 + (i % 2) * 7, 1.2, cz - 22 + i * 14)));
    }
    g.add(bush(B.minX - 8, B.minZ - 10), bush(B.minX - 14, B.maxZ + 8));
  } else if (kind === 'rock') {
    const rm = mat('#8c7d6c'); const r = part(SPH, rm, 16, 12, 11, cx + 4, 9, B.minZ - 24); g.add(r);
    g.add(part(SPH, mat('#7a6c5d'), 9, 8, 7, cx - 14, 5, B.minZ - 22), part(SPH, mat('#9a8b79'), 7, 6, 6, cx + 21, 4, B.minZ - 28));
    for (let i = 0; i < 9; i++) g.add(bush(B.minX - 8 - i * 4, B.minZ - 8 - (i % 3) * 3, 1.1 + (i % 3) * 0.3, '#4f8a3a'));
  } else if (kind === 'walls') {
    const mud = mat('#c58f5b'), mud2 = mat('#b37a46'); const z0 = B.minZ - 7;
    g.add(box(W2(B) + 30, 5, 1.6, mud, cx, 2.5, z0));
    for (let x = B.minX - 14; x < B.maxX + 14; x += 3) g.add(box(1.4, 1.1, 1.8, mud2, x, 5.5, z0));
    g.add(box(6, 9, 3, mud2, cx + 10, 4.5, z0), box(3.4, 5.5, 3.2, mat('#2a1c12'), cx + 10, 2.8, z0 + 0.1));
    for (const dx of [-4, 4]) g.add(part(CYL, mud2, 1.5, 11, 1.5, cx + 10 + dx, 5.5, z0));
    for (let i = 0; i < 5; i++) g.add(acacia(B.maxX + 6 + i * 3, B.minZ + i * 9, 0.8));
  } else if (kind === 'jungle') {
    for (let i = 0; i < 46; i++) { const side = i % 4, t = (i * 37 % 100) / 100; const x = side < 2 ? B.minX - 5 - (i % 5) * 3 : B.minX + t * (B.maxX - B.minX), z = side < 2 ? B.minZ + t * (B.maxZ - B.minZ) : (side === 2 ? B.minZ - 6 - (i % 4) * 3 : B.maxZ + 6 + (i % 4) * 3); g.add(i % 3 ? palm(x, z, 5 + (i % 4)) : bush(x, z, 1.8 + (i % 3) * 0.5, '#1f6f3a')); }
  } else if (kind === 'hills') {
    [['#8aa65a', 26, 9, -34, -34], ['#7b9a4e', 20, 7, 4, -44], ['#a3a35d', 24, 8, 40, -32], ['#6f8f48', 18, 6, 60, -8]].forEach(([c, r, h, x, z]) => g.add(part(SPH, mat(c), r, h, r, cx + x, h * 0.4, cz + z)));
    for (let i = 0; i < 9; i++) g.add(acacia(B.minX - 6 - (i % 3) * 6, B.minZ + i * 6, 0.9 + (i % 3) * 0.2));
    g.add(box(2, 18, 2, mat('#cfd3d8'), cx - 30, 9, B.maxZ + 16), box(3.2, 3.2, 3.2, mat('#aeb4bb'), cx - 30, 19.6, B.maxZ + 16));   // skyline tower
  } else if (kind === 'tower') {
    const stone = mat('#b9a98a'), tx = B.maxX + 9, tz = B.minZ - 9;
    g.add(box(5, 22, 5, stone, tx, 11, tz), box(6, 1.2, 6, mat('#9a8a6e'), tx, 22.6, tz), part(CONE, mat('#3f5a4a'), 4.2, 8, 4.2, tx, 27.2, tz));
    for (const [dx, dz, ry] of [[0, 2.55, 0], [0, -2.55, Math.PI], [2.55, 0, Math.PI / 2], [-2.55, 0, -Math.PI / 2]]) { const f = textSprite('🕰', 3.2, 3.2, '#f6efd9', '#222', 160); f.position.set(tx + dx, 17.5, tz + dz); f.rotation.y = ry; g.add(f); }
    [['#3d6fb0', 0], ['#c9372c', 1], ['#7a7f87', 2]].forEach(([c, i]) => g.add(box(14, 16 + i * 4, 10, mat(c), B.minX - 14 - i * 16, (16 + i * 4) / 2, B.minZ - 12)));
    water(B.minX + 40, B.minZ - 16, 140, 10);
  }
  return g;
}
const W2 = (B) => B.maxX - B.minX;

export function createWorld3D(world, scene) {
  const lamps = [], windows = [], buildings = [], markers = [], doors = [];
  const root = new THREE.Group(); scene.add(root);

  // ---- lights ----
  const hemi = new THREE.HemisphereLight('#cfe8ff', '#6f8a55', 1); root.add(hemi);
  const sun = new THREE.DirectionalLight('#fff3d6', 2.2);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 120 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  root.add(sun, sun.target);

  // ---- ground, road, sidewalks ----
  const B = world.bounds, W = B.maxX - B.minX, D = B.maxZ - B.minZ;
  const T = { ground: '#8fcf72', road: '#4b505d', sidewalk: '#cdc9bd', park: '#7bbd5f', hedge: '#5e9f4d', ...(world.theme ?? {}) };
  const ground = box(W + 320, 0.4, D + 320, mat(T.ground), 0, -0.2, 0, false); root.add(ground);
  const pk = world.park ?? { cx: -23, cz: -16, sx: 22, sz: 20 };
  const parkMat = new THREE.Color(T.ground).lerp(new THREE.Color('#2f7a3a'), 0.25);
  const park = box(pk.sx, 0.05, pk.sz, mat(parkMat), pk.cx, 0.03, pk.cz, false); park.castShadow = false; root.add(park);
  const R = world.road, roadW = R.maxZ - R.minZ;
  root.add(box(W, 0.08, roadW, mat(T.road), 0, 0.04, (R.minZ + R.maxZ) / 2, false));
  for (const side of [-1, 1]) root.add(box(W, 0.12, 1.8, mat(T.sidewalk), 0, 0.06, side * (roadW / 2 + 0.9), false));
  const dash = mat('#f4efe0');
  for (let x = B.minX + 2; x < B.maxX; x += 4) root.add(box(2, 0.01, 0.16, dash, x, 0.09, 0, false));
  for (let i = -3; i <= 3; i++) root.add(box(0.6, 0.01, 1.6, dash, 0.5, 0.09, i * 1.1, false));   // zebra crossing
  if (world.landmark) buildLandmark(world.landmark, B, root);
  const hedge = mat(T.hedge);
  root.add(box(W, 0.9, 0.5, hedge, 0, 0.45, B.minZ - 0.25), box(W, 0.9, 0.5, hedge, 0, 0.45, B.maxZ + 0.25),
    box(0.5, 0.9, D + 1, hedge, B.minX - 0.25, 0.45, 0), box(0.5, 0.9, D + 1, hedge, B.maxX + 0.25, 0.45, 0));

  // ---- shared materials ----
  const winMat = new THREE.MeshStandardMaterial({ color: '#31465f', emissive: '#ffd98a', emissiveIntensity: 0, roughness: 0.3 });
  const doorMat = mat('#6b3f1d');
  const winGeo = new THREE.PlaneGeometry(1.1, 1.2);

  // ---- buildings ----
  for (const b of world.buildings) {
    const g = new THREE.Group(); root.add(g);
    const wallM = mat(b.wall), roofM = mat(b.roof);
    const { walls, gate, frontZ } = buildingBoxes(b);
    const wallMeshes = [];
    for (const w of walls) {
      const m = box(1, 1, 1, wallM, 0, 0, 0);
      const sx = w.maxX - w.minX, sz = w.maxZ - w.minZ;
      m.userData = { sx, sz, cx: (w.minX + w.maxX) / 2, cz: (w.minZ + w.maxZ) / 2 };
      m.scale.set(sx, b.height, sz); m.position.set(m.userData.cx, b.height / 2, m.userData.cz);
      g.add(m); wallMeshes.push(m);
    }
    let lintel = null;
    if (gate) {
      const lh = b.height - 2.7;
      lintel = box(b.doorWidth, lh, WALL, wallM, b.cx, 2.7 + lh / 2, frontZ); g.add(lintel);
      if (b.gate) {
        const hinge = new THREE.Group(); hinge.position.set(b.cx - b.doorWidth / 2, 0, frontZ);
        hinge.add(box(b.doorWidth, 2.7, 0.14, doorMat, b.doorWidth / 2, 1.35, 0));
        hinge.add(box(0.1, 0.1, 0.18, mat('#e8c46a'), b.doorWidth - 0.2, 1.3, 0));
        g.add(hinge); doors.push({ b, hinge, open: 0 });
      }
    }
    if (b.enterable) g.add(box(b.sx - 2 * WALL, 0.07, b.sz - 2 * WALL, mat(b.floor ?? '#ddd'), b.cx, 0.04, b.cz, false));
    const roof = box(b.sx + 0.7, 0.4, b.sz + 0.7, roofM, b.cx, b.height + 0.2, b.cz); g.add(roof);
    g.add(box(b.sx + 0.7, 0.18, 0.2, mat('#ffffff'), b.cx, b.height + 0.05, b.cz + (b.sz / 2 + 0.3)));

    // windows + sign on the face toward the road
    const faceSign = b.cz < 0 ? 1 : -1;
    const faceZ = b.cz + faceSign * (b.sz / 2 + 0.025);
    const winPlaces = b.doorSide ? [-1, 1].flatMap((s) => [s * (b.doorWidth / 2 + 1.7), s * (b.doorWidth / 2 + 3.6)]).filter((x) => Math.abs(x) < b.sx / 2 - 0.9)
      : [-3, -1, 1, 3].filter((x) => Math.abs(x) < b.sx / 2 - 0.9);
    for (const dx of winPlaces) for (const y of (b.doorSide ? [1.6] : [1.2, 2.6])) {
      if (y + 0.6 > b.height) continue;
      const w = new THREE.Mesh(winGeo, winMat); w.position.set(b.cx + dx, y, faceZ); if (faceSign < 0) w.rotation.y = Math.PI; g.add(w);
    }
    const sign = b.kind === 'house' ? null : textSprite(b.sign ?? b.name, b.doorSide ? 4.6 : 6.2, b.doorSide ? 0.62 : 0.9, b.doorSide ? b.roof : '#1e2a44', '#fff', b.doorSide ? 40 : 46);
    if (sign) { sign.position.set(b.cx, b.doorSide ? 3.05 : b.height - 0.7, faceZ + faceSign * 0.03); if (faceSign < 0) sign.rotation.y = Math.PI; g.add(sign); }

    buildings.push({ b, group: g, wallMeshes, lintel, roof, cut: 0, minX: b.cx - b.sx / 2, maxX: b.cx + b.sx / 2, minZ: b.cz - b.sz / 2, maxZ: b.cz + b.sz / 2 });
  }

  // ---- furniture & goods ----
  const goodsColors = ['#e94f4f', '#4fa3e9', '#f2c94c', '#6fcf97', '#bb6bd9', '#f2994a'];
  for (const f of world.furniture) {
    const g = new THREE.Group(); root.add(g);
    g.add(box(f.sx, f.h, f.sz, mat(f.color), f.x, f.h / 2, f.z));
    if (f.id === 'bed') g.add(box(0.7, 0.18, 1.0, mat('#ffffff'), f.x - 0.6, f.h + 0.09, f.z), box(0.25, 0.8, f.sz, mat('#7a5230'), f.x - f.sx / 2 + 0.12, 0.4, f.z));
    if (f.id === 'sofa') g.add(box(f.sx, 0.55, 0.22, mat('#7e2b2b'), f.x, f.h + 0.27, f.z - f.sz / 2 + 0.11));
    if (f.id === 'counter') { g.add(box(0.7, 0.35, 0.5, mat('#2d3a5a'), f.x + 1.6, f.h + 0.17, f.z)); for (let i = 0; i < 6; i++) g.add(box(0.28, 0.28, 0.28, mat(goodsColors[i]), f.x - 2 + i * 0.45, f.h + 0.14, f.z - 0.1)); }
    if (f.id === 'crate') g.add(box(0.9, 0.9, 0.9, mat('#e6bd2c'), f.x + 0.1, f.h + 0.45, f.z - 0.05));
    if (f.id.startsWith('shelf')) for (let r = 0; r < 3; r++) for (let i = 0; i < Math.floor(f.sx / 0.55); i++) g.add(box(0.4, 0.3, 0.3, mat(goodsColors[(i + r) % 6]), f.x - f.sx / 2 + 0.35 + i * 0.55, 0.5 + r * 0.6, f.z));
  }

  // ---- props ----
  const trunk = mat('#7a5230'), leaf1 = mat('#4f9d45'), leaf2 = mat('#66b955');
  const trunkG = new THREE.CylinderGeometry(0.14, 0.2, 1, 6), leafG = new THREE.IcosahedronGeometry(1, 0), poleG = new THREE.CylinderGeometry(0.05, 0.07, 1, 6);
  const lampHead = new THREE.MeshStandardMaterial({ color: '#fff2c0', emissive: '#ffcf70', emissiveIntensity: 0.1 });
  const binM = mat('#4b6b57'), benchM = mat('#a5703c'), darkM = mat('#33363f');
  for (const p of world.props) {
    if (p.type === 'tree') {
      const s = p.s ?? 1, g = new THREE.Group(); g.position.set(p.x, 0, p.z);
      const t = new THREE.Mesh(trunkG, trunk); t.scale.set(s, 1.6 * s, s); t.position.y = 0.8 * s; t.castShadow = true; g.add(t);
      const l1 = new THREE.Mesh(leafG, leaf1); l1.scale.set(1.5 * s, 1.3 * s, 1.5 * s); l1.position.y = 2.4 * s; l1.castShadow = true; l1.receiveShadow = true;
      const l2 = new THREE.Mesh(leafG, leaf2); l2.scale.set(1.1 * s, 1.0 * s, 1.1 * s); l2.position.set(0.3 * s, 3.3 * s, 0.1 * s); l2.castShadow = true;
      g.add(l1, l2); root.add(g);
    } else if (p.type === 'lamp') {
      const g = new THREE.Group(); g.position.set(p.x, 0, p.z);
      const pole = new THREE.Mesh(poleG, darkM); pole.scale.set(1, 4.2, 1); pole.position.y = 2.1; pole.castShadow = true; g.add(pole);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), lampHead); head.position.y = 4.3; g.add(head);
      const light = new THREE.PointLight('#ffc873', 0, 13, 1.6); light.position.y = 4.1; g.add(light);
      lamps.push(light); root.add(g);
    } else if (p.type === 'bench') {
      const g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.ry ?? 0;
      g.add(box(1.6, 0.1, 0.5, benchM, 0, 0.5, 0), box(1.6, 0.5, 0.08, benchM, 0, 0.8, -0.24), box(0.1, 0.5, 0.45, darkM, -0.7, 0.25, 0), box(0.1, 0.5, 0.45, darkM, 0.7, 0.25, 0));
      root.add(g);
    } else if (p.type === 'bin') {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.2, 0.7, 8), binM); m.position.set(p.x, 0.35, p.z); m.castShadow = true; root.add(m);
    }
  }

  // ---- interaction markers ----
  const ICON = { door: '🏠', shop: '🛒', work: '💼' };
  for (const z of world.zones) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 40), new THREE.MeshBasicMaterial({ color: '#ffe36e', transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(z.x, 0.12, z.z); root.add(ring);
    const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture(ICON[z.kind]), transparent: true, depthWrite: false }));
    icon.scale.set(1.1, 1.1, 1.1); icon.position.set(z.x, 2.6, z.z); root.add(icon);
    markers.push({ z, ring, icon });
  }

  // ---- lots: clickable houses, apartment block and empty plots with status banners ----
  const lots = new Map(), pickables = [];
  const bannerTex = (lines, bg, fg) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 56 + lines.length * 62;
    const g = c.getContext('2d'); g.fillStyle = bg; g.beginPath(); g.roundRect(4, 4, c.width - 8, c.height - 8, 30); g.fill();
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((t, i) => { let px = i ? 40 : 46; const font = (n) => `${i ? 600 : 800} ${n}px system-ui, "Segoe UI", sans-serif`; g.font = font(px); while (g.measureText(t).width > 470 && px > 18) { px -= 2; g.font = font(px); } g.fillText(t, 256, 52 + i * 62); });
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return { t, w: c.width, h: c.height };
  };
  const fenceM = mat('#8a6a43'), padM = new THREE.Color(T.ground).lerp(new THREE.Color('#d8c48a'), 0.35);
  for (const l of world.lots ?? []) {
    const g = new THREE.Group(); root.add(g);
    const top = l.kind === 'land' ? 0.2 : (world.buildings.find((b) => b.id === l.building)?.height ?? 3.4) + 0.6;
    if (l.kind === 'land') {
      g.add(box(l.sx, 0.06, l.sz, mat(padM), l.cx, 0.05, l.cz, false));
      for (const [x, z, w, d] of [[0, -l.sz / 2, l.sx, 0.12], [0, l.sz / 2, l.sx, 0.12], [-l.sx / 2, 0, 0.12, l.sz], [l.sx / 2, 0, 0.12, l.sz]]) g.add(box(w, 0.7, d, fenceM, l.cx + x, 0.35, l.cz + z));
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(box(0.2, 1.1, 0.2, fenceM, l.cx + x * l.sx / 2, 0.55, l.cz + z * l.sz / 2));
    }
    const pick = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ visible: false }));
    pick.scale.set(l.sx, l.kind === 'land' ? 3 : top, l.sz); pick.position.set(l.cx, (l.kind === 'land' ? 3 : top) / 2, l.cz); pick.userData.lotId = l.id; g.add(pick); pickables.push(pick);
    const banner = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false })); banner.position.set(l.cx, top + 1.8, l.cz); banner.visible = false; g.add(banner);
    lots.set(l.id, { l, g, banner, house: null, top });
  }
  const miniHouse = (l) => { const h = new THREE.Group(); h.add(box(l.sx * 0.55, 2.6, l.sz * 0.55, mat('#e8d9b5'), l.cx, 1.3, l.cz), box(l.sx * 0.62, 0.35, l.sz * 0.62, mat('#b4553a'), l.cx, 2.8, l.cz), box(1.0, 1.8, 0.1, mat('#6b4a2b'), l.cx, 0.9, l.cz + (l.cz < 0 ? 1 : -1) * (l.sz * 0.275 + 0.03))); return h; };

  const skyDay = new THREE.Color('#8ec9f7'), skyDusk = new THREE.Color('#f4a874'), skyNight = new THREE.Color('#0e1633');
  const sunWarm = new THREE.Color('#ffb877'), sunWhite = new THREE.Color('#fff3d6'), moonBlue = new THREE.Color('#7b93d8');
  const tmp = new THREE.Color();
  let time = 0;

  return {
    buildings, markers, cityId: world.cityId,
    /** states: { lotId: { lines: [..], tone: 'free'|'taken'|'yours', house?: boolean } } */
    setLotStates(states) {
      for (const [id, st] of Object.entries(states)) {
        const o = lots.get(id); if (!o) continue;
        const col = { free: ['#1f8a5b', '#ffffff'], taken: ['#59606b', '#e6e8ec'], yours: ['#f4b942', '#2a1d00'] }[st.tone] ?? ['#1e2a44', '#fff'];
        const { t, w, h } = bannerTex(st.lines, col[0], col[1]);
        o.banner.material.map?.dispose(); o.banner.material.map = t; o.banner.material.needsUpdate = true; o.banner.scale.set(w / 85, h / 85, 1); o.banner.visible = true;
        if (st.house && !o.house && o.l.kind === 'land') { o.house = miniHouse(o.l); o.g.add(o.house); }
        if (!st.house && o.house) { o.g.remove(o.house); o.house = null; }
      }
    },
    /** The lot under a screen point (ndc -1..1), or null. */
    pickLot(ndcX, ndcY, camera) {
      const ray = new THREE.Raycaster(); ray.setFromCamera({ x: ndcX, y: ndcY }, camera);
      const hit = ray.intersectObjects(pickables, false)[0]; return hit ? hit.object.userData.lotId : null;
    },
    dispose() {
      scene.remove(root);
      root.traverse((o) => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { m.map?.dispose(); m.dispose(); } } if (o.geometry && o.geometry !== BOX) o.geometry.dispose(); });
      scene.background = null; scene.fog = null;
    },
    /** hour 0..24, me = {x,z}, hasAccess = bool (apartment gate), focus = point the sun's shadow box follows */
    update(dt, hour, me, hasAccess) {
      time += dt;
      const elev = Math.sin(((hour - 6) / 12) * Math.PI);
      const day = smooth(-0.1, 0.32, elev);
      const dusk = 1 - clamp(Math.abs(elev) / 0.3);
      // sky
      tmp.copy(skyNight).lerp(skyDay, day).lerp(skyDusk, dusk * 0.7 * (1 - Math.abs(day - 0.5) * 0.6));
      scene.background = scene.background ?? new THREE.Color(); scene.background.copy(tmp);
      scene.fog = scene.fog ?? new THREE.Fog(tmp, 45, 130); scene.fog.color.copy(tmp);
      // light
      hemi.intensity = 0.62 + day * 0.7; hemi.color.set('#cfe8ff').lerp(new THREE.Color('#5a6aa8'), 1 - day);
      const az = ((hour - 6) / 12) * Math.PI;
      const dir = day > 0.02 ? new THREE.Vector3(-Math.cos(az) * 0.9, Math.max(Math.sin(az), 0.18), 0.55) : new THREE.Vector3(-0.4, 0.8, 0.3);
      dir.normalize();
      sun.position.copy(dir.multiplyScalar(60)).add(new THREE.Vector3(me.x, 0, me.z)); sun.target.position.set(me.x, 0, me.z); sun.target.updateMatrixWorld();
      sun.intensity = 0.8 + day * 1.7;
      sun.color.copy(moonBlue).lerp(sunWhite, day).lerp(sunWarm, dusk * 0.6 * day);
      // lamps and windows turn on as it gets dark
      const dark = 1 - smooth(0.0, 0.35, elev);
      for (const l of lamps) l.intensity = dark * 28;
      lampHead.emissiveIntensity = 0.1 + dark * 2.4;
      winMat.emissiveIntensity = dark * 0.9;
      // roofs lift and walls drop to a cut-away when you step inside, so you can see the room
      for (const bd of buildings) {
        const inside = me.x > bd.minX && me.x < bd.maxX && me.z > bd.minZ && me.z < bd.maxZ && bd.b.enterable;
        bd.cut += ((inside ? 1 : 0) - bd.cut) * Math.min(1, dt * 8);
        const h = bd.b.height * (1 - bd.cut * 0.78);
        for (const w of bd.wallMeshes) { w.scale.y = h; w.position.y = h / 2; }
        bd.roof.visible = bd.cut < 0.5; if (bd.lintel) bd.lintel.visible = bd.cut < 0.5;
      }
      // door swings open for tenants who are close
      for (const d of doors) {
        const near = hasAccess && Math.hypot(me.x - d.b.cx, me.z - (d.b.cz + (d.b.sz / 2) * (d.b.doorSide === '+z' ? 1 : -1))) < 3.2;
        d.open += ((near ? 1 : 0) - d.open) * Math.min(1, dt * 6);
        d.hinge.rotation.y = -d.open * 1.75 * (d.b.doorSide === '+z' ? -1 : 1);
      }
      for (const m of markers) {
        const pulse = 1 + Math.sin(time * 3 + m.z.x) * 0.08;
        m.ring.scale.set(pulse, pulse, pulse); m.icon.position.y = 2.6 + Math.sin(time * 2.4 + m.z.z) * 0.12;
        m.ring.material.opacity = 0.55 + Math.sin(time * 3) * 0.2;
      }
    },
  };
}

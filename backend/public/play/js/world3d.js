// Builds New Meridian's Maple Court from the same data file the server uses for collision (world.json),
// so what you see is exactly what you can bump into.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildingBoxes, WALL } from '/shared/sim.mjs';

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const matCache = new Map();
/** Materials are shared by colour so static parts can be merged into a few meshes (far fewer draw calls). */
const mat = (c, o = {}) => { const k = `${c instanceof THREE.Color ? c.getHexString() : c}|${JSON.stringify(o)}`; let m = matCache.get(k); if (!m) { m = new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.9, metalness: 0, ...o }); matCache.set(k, m); } return m; };
/** Merge every plain mesh of a group into one mesh per material. Keep anything marked userData.dynamic. */
function mergeStatic(group) {
  group.updateMatrixWorld(true);
  const byMat = new Map();
  for (const ch of [...group.children]) {
    if (!ch.isMesh || ch.userData.dynamic) continue;
    const geo = ch.geometry.clone(); geo.applyMatrix4(ch.matrix);
    if (!byMat.has(ch.material)) byMat.set(ch.material, []);
    byMat.get(ch.material).push(geo); group.remove(ch);
  }
  for (const [m, geos] of byMat) { const merged = mergeGeometries(geos, false); if (!merged) continue; const mesh = new THREE.Mesh(merged, m); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); }
  return group;
}
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


// ---------------------------------------------------------------- points of interest (landmarks and businesses)
const LABEL_H = 0.034;
function makeLabel(emoji, text, tone) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 96;
  const g = c.getContext('2d'); g.font = '800 40px system-ui, "Segoe UI", sans-serif';
  const label = text.length > 22 ? text.slice(0, 21) + '…' : text;
  const tw = g.measureText(label).width, w = Math.min(620, tw + 112);
  const x0 = (c.width - w) / 2;
  g.fillStyle = tone === 'biz' ? 'rgba(255,248,226,.97)' : 'rgba(255,255,255,.97)'; g.shadowColor = 'rgba(0,0,0,.28)'; g.shadowBlur = 10; g.shadowOffsetY = 3;
  g.beginPath(); g.roundRect(x0, 10, w, 68, 34); g.fill(); g.shadowColor = 'transparent';
  g.font = '44px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(emoji, x0 + 18, 46);
  g.fillStyle = '#1b2a33'; g.font = '800 38px system-ui, "Segoe UI", sans-serif'; g.fillText(label, x0 + 78, 47);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 2;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false }));
  sp.scale.set(LABEL_H * (c.width / c.height), LABEL_H, 1); sp.renderOrder = 20; return sp;
}
const PALMS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];

function buildPOI(p, root, labelGroup) {
  const g = new THREE.Group(); root.add(g);
  const wall = mat(p.wall), roof = mat(p.roof), white = mat('#f3f1ea'), dark = mat('#2d3340');
  const add = (sx, h, sz, m, x = 0, y = 0, z = 0) => { const o = box(sx, h, sz, m, p.x + x, y + h / 2, p.z + z); g.add(o); return o; };
  const f = p.face === '+z' ? 1 : -1;
  const front = (sx, sz) => f * (sz / 2 + 0.05);
  const windows = (sx, sz, h) => { for (let i = -2; i <= 2; i++) { const w = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1), winMatP); w.position.set(p.x + i * (sx / 5.5), Math.min(2, h - 1), p.z + f * (sz / 2 + 0.03)); if (f < 0) w.rotation.y = Math.PI; g.add(w); } };
  const door = (sx, sz) => add(1.3, 2.1, 0.12, mat('#5a381c'), 0, 0, f * (sz / 2 + 0.04));
  const awning = (sx, sz, m) => add(sx * 0.9, 0.25, 1.6, m, 0, 2.6, f * (sz / 2 + 0.8));
  const tree = (x, z, s = 1) => { const t = new THREE.Mesh(CYL_T, mat('#7a5230')); t.scale.set(s, 1.5 * s, s); t.position.set(p.x + x, 0.75 * s, p.z + z); t.castShadow = true; const l = new THREE.Mesh(ICO, mat('#4f9d45')); l.scale.set(1.4 * s, 1.2 * s, 1.4 * s); l.position.set(p.x + x, 2.2 * s, p.z + z); l.castShadow = true; g.add(t, l); };
  const palmAt = (x, z) => { const t = box(0.22, 4.5, 0.22, mat('#8a6a43'), p.x + x, 2.25, p.z + z); g.add(t); for (let i = 0; i < 6; i++) { const l = new THREE.Mesh(CONE_P, mat('#3e9a4d')); l.scale.set(0.35, 3, 0.35); l.position.set(p.x + x + Math.cos(i * 1.05) * 1.1, 4.5, p.z + z + Math.sin(i * 1.05) * 1.1); l.rotation.set(Math.sin(i * 1.05) * 1.2, 0, -Math.cos(i * 1.05) * 1.2); g.add(l); } };
  switch (p.type) {
    case 'church': {
      add(p.sx * 0.8, p.h * 0.7, p.sz * 0.7, white, 0, 0, f * 1.2); add(p.sx * 0.9, 0.5, p.sz * 0.8, roof, 0, p.h * 0.7, f * 1.2);
      add(3, p.h * 1.7, 3, white, 0, 0, -f * (p.sz / 2 - 2)); const cone = new THREE.Mesh(CONE_P, roof); cone.scale.set(2.4, 3.5, 2.4); cone.position.set(p.x, p.h * 1.7 + 1.75, p.z - f * (p.sz / 2 - 2)); g.add(cone);
      add(0.25, 1.6, 0.25, mat('#e8c46a'), 0, p.h * 1.7 + 3.5, -f * (p.sz / 2 - 2)); add(1, 0.25, 0.25, mat('#e8c46a'), 0, p.h * 1.7 + 4.4, -f * (p.sz / 2 - 2)); break;
    }
    case 'mosque': {
      add(p.sx * 0.8, 4, p.sz * 0.8, white); const dome = new THREE.Mesh(DOME, mat('#4fa58f')); dome.scale.set(3.4, 3.4, 3.4); dome.position.set(p.x, 4, p.z); dome.castShadow = true; g.add(dome);
      for (const sx of [-1, 1]) { add(1, 9, 1, white, sx * (p.sx / 2 - 0.8), 0, f * (p.sz / 2 - 0.8)); const c = new THREE.Mesh(CONE_P, mat('#4fa58f')); c.scale.set(0.9, 1.6, 0.9); c.position.set(p.x + sx * (p.sx / 2 - 0.8), 9.8, p.z + f * (p.sz / 2 - 0.8)); g.add(c); } break;
    }
    case 'market': {
      add(p.sx, 0.12, p.sz, mat('#b9b6ac'), 0, 0, 0); const cols = ['#e94f4f', '#4fa3e9', '#f2c94c', '#6fcf97', '#bb6bd9', '#f2994a'];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) { const c = cols[(i * 2 + j) % cols.length]; add(2.6, 0.9, 1.8, mat('#8a5a2b'), (i - 1.5) * 3.1, 0.12, (j - 0.5) * 3.6); add(3.1, 0.2, 2.6, mat(c), (i - 1.5) * 3.1, 2.3, (j - 0.5) * 3.6); add(0.12, 2.2, 0.12, dark, (i - 1.5) * 3.1 - 1.4, 0.1, (j - 0.5) * 3.6 - 1.2); } break;
    }
    case 'hospital': case 'clinic': {
      add(p.sx * 0.94, p.h, p.sz * 0.9, white); add(p.sx * 0.97, 0.4, p.sz * 0.95, mat('#d9dde3'), 0, p.h);
      add(2.4, 0.4, 0.5, mat('#e23b3b'), 0, p.h * 0.62, front(p.sx, p.sz) + f * 0.2); add(0.5, 2.4, 0.5, mat('#e23b3b'), 0, p.h * 0.62 - 1.0, front(p.sx, p.sz) + f * 0.2); windows(p.sx, p.sz, p.h); door(p.sx, p.sz); break;
    }
    case 'police': { add(p.sx * 0.9, p.h, p.sz * 0.9, mat('#5b7bb0')); add(p.sx * 0.95, 0.4, p.sz * 0.95, mat('#2f4a7a'), 0, p.h); add(1.2, 0.5, 0.6, mat('#e23b3b'), -0.7, p.h + 0.4); add(1.2, 0.5, 0.6, mat('#3b6fe2'), 0.7, p.h + 0.4); windows(p.sx, p.sz, p.h); door(p.sx, p.sz); break; }
    case 'school': case 'university': {
      add(p.sx * 0.95, p.h, p.sz * 0.6, wall); add(p.sx * 1, 0.4, p.sz * 0.66, roof, 0, p.h); add(2.6, p.h + 3, 2.6, white, 0, 0, f * 0.8); add(0.15, 5, 0.15, dark, p.sx * 0.35, p.h, f * 1.2); add(1.2, 0.7, 0.05, mat('#e94f4f'), p.sx * 0.35 + 0.6, p.h + 4, f * 1.2); windows(p.sx, p.sz * 0.6, p.h); break;
    }
    case 'stadium': {
      add(p.sx, 4.5, 1.6, mat('#c9ced6'), 0, 0, -p.sz / 2 + 0.8); add(p.sx, 4.5, 1.6, mat('#c9ced6'), 0, 0, p.sz / 2 - 0.8); add(1.6, 4.5, p.sz - 3.2, mat('#c9ced6'), -p.sx / 2 + 0.8, 0, 0); add(1.6, 4.5, p.sz - 3.2, mat('#c9ced6'), p.sx / 2 - 0.8, 0, 0);
      add(p.sx - 3.4, 0.1, p.sz - 3.4, mat('#4fa14b'), 0, 0, 0); add(0.2, 0.12, p.sz - 3.4, white, 0, 0.1, 0);
      for (const [x, z] of PALMS) add(0.3, 8, 0.3, dark, x * (p.sx / 2), 0, z * (p.sz / 2)); break;
    }
    case 'park': { add(p.sx, 0.08, p.sz, mat('#6cae55'), 0, 0, 0); add(1.4, 0.1, p.sz, mat('#d8c9a0'), 0, 0.06, 0); for (let i = 0; i < 7; i++) tree(Math.cos(i * 2.1) * p.sx * 0.36, Math.sin(i * 1.7) * p.sz * 0.36, 0.9 + (i % 3) * 0.2); break; }
    case 'beach': { add(p.sx, 0.08, p.sz, mat('#ecd9a3'), 0, 0, 0); add(p.sx, 0.06, 3, mat('#5aa7d6'), 0, 0.08, -f * (p.sz / 2 - 1.5)); palmAt(-4, 1); palmAt(3, 2); palmAt(0, 3.5); for (const x of [-2, 2.6]) { add(0.1, 2, 0.1, white, x, 0.1, -1); const u = new THREE.Mesh(CONE_P, mat(x < 0 ? '#e94f4f' : '#f2c94c')); u.scale.set(1.5, 0.7, 1.5); u.position.set(p.x + x, 2.2, p.z - 1); g.add(u); } break; }
    case 'golf': { add(p.sx, 0.08, p.sz, mat('#58a64d'), 0, 0, 0); add(3, 0.1, 3, mat('#e9d9a5'), -4, 0.06, 2); add(0.08, 3, 0.08, white, 4, 0.1, -2); add(0.9, 0.5, 0.04, mat('#e94f4f'), 4.45, 2.6, -2); tree(-6, -4, 1); tree(6, 4, 1.1); break; }
    case 'dock': { add(p.sx, 0.2, p.sz, mat('#8a6a43'), 0, 0, 0); for (const x of [-3.5, 3]) { add(2.4, 0.7, 5, mat('#e8e6e0'), x, 0.2, 0.5); add(1.4, 1, 1.6, mat('#2d6fa8'), x, 0.9, 0.2); } break; }
    case 'hotel': case 'office': case 'tech': {
      add(p.sx * 0.86, p.h, p.sz * 0.86, wall); for (let y = 2; y < p.h - 0.8; y += 2.2) add(p.sx * 0.88, 0.7, p.sz * 0.88, mat('#2b3d52'), 0, y);
      add(p.sx * 0.9, 0.5, p.sz * 0.9, roof, 0, p.h); if (p.type === 'hotel') add(p.sx * 0.5, 0.2, 3, mat('#e94f4f'), 0, 3.2, f * (p.sz * 0.43 + 1.2)); break;
    }
    case 'museum': case 'gov': {
      add(p.sx * 0.9, p.h, p.sz * 0.8, mat('#e6dfcf')); add(p.sx * 0.96, 0.8, p.sz * 0.9, roof, 0, p.h);
      for (let i = -2; i <= 2; i++) add(0.7, p.h, 0.7, white, i * (p.sx * 0.17), 0, f * (p.sz * 0.4 + 0.7)); add(p.sx * 0.9, 0.7, 1.8, white, 0, p.h, f * (p.sz * 0.4 + 0.7)); add(p.sx * 0.92, 0.3, 2.4, mat('#cfc8b7'), 0, 0, f * (p.sz * 0.4 + 1)); break;
    }
    case 'mall': { add(p.sx * 0.95, p.h, p.sz * 0.9, wall); add(p.sx, 0.6, p.sz * 0.95, roof, 0, p.h); add(p.sx * 0.7, 0.35, 2.4, mat('#e94f4f'), 0, 3, f * (p.sz * 0.45 + 1.2)); windows(p.sx, p.sz * 0.9, p.h); door(p.sx, p.sz * 0.9); break; }
    default: { add(p.sx * 0.92, p.h, p.sz * 0.9, wall); add(p.sx * 0.97, 0.35, p.sz * 0.95, roof, 0, p.h); awning(p.sx * 0.92, p.sz * 0.9, mat(p.roof)); windows(p.sx, p.sz * 0.9, p.h); door(p.sx, p.sz * 0.9); }
  }
  mergeStatic(g);
  const lab = makeLabel(p.emoji, p.name, p.business ? 'biz' : 'civic');
  lab.position.set(p.x, Math.max(p.h, 1.5) + (p.type === 'church' ? 8 : p.type === 'mosque' ? 6 : 2.6), p.z); labelGroup.add(lab);
  return g;
}
const CYL_T = new THREE.CylinderGeometry(0.14, 0.2, 1, 6), ICO = new THREE.IcosahedronGeometry(1, 0), CONE_P = new THREE.ConeGeometry(1, 1, 7), DOME = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const winMatP = new THREE.MeshStandardMaterial({ color: '#31465f', emissive: '#ffd98a', emissiveIntensity: 0, roughness: 0.3 });

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

  // ---- ground, districts, roads, water ----
  const B = world.bounds, W = B.maxX - B.minX, D = B.maxZ - B.minZ;
  const districts = world.districts ?? [{ id: world.cityId, bounds: world.bounds, theme: world.theme, park: world.park, road: world.road, center: { x: 0, z: 0 }, names: world.names }];
  const T = { ground: '#8fcf72', road: '#4b505d', sidewalk: '#cdc9bd', park: '#7bbd5f', hedge: '#5e9f4d', ...(districts[0].theme ?? world.theme ?? {}) };
  const themeOf = (area) => ({ ...T, ...(districts.find((d) => d.id === area)?.theme ?? {}) });
  root.add(box(W + 320, 0.4, D + 320, mat(new THREE.Color(T.ground).lerp(new THREE.Color('#9fb58a'), 0.35)), (B.minX + B.maxX) / 2, -0.2, (B.minZ + B.maxZ) / 2, false));
  for (const d of districts) {
    const th = { ...T, ...(d.theme ?? {}) }, bd = d.bounds;
    root.add(box(bd.maxX - bd.minX, 0.2, bd.maxZ - bd.minZ, mat(th.ground), (bd.minX + bd.maxX) / 2, -0.09, (bd.minZ + bd.maxZ) / 2, false));
    const pk = d.park;
    const parkMat = new THREE.Color(th.ground).lerp(new THREE.Color('#2f7a3a'), 0.25);
    const park = box(pk.sx, 0.05, pk.sz, mat(parkMat), pk.cx, 0.03, pk.cz, false); park.castShadow = false; root.add(park);
  }
  const roads = world.roads ?? [{ minX: B.minX, maxX: B.maxX, minZ: world.road.minZ, maxZ: world.road.maxZ, kind: 'street' }];
  const dash = mat('#f4efe0'), roadM = mat(T.road), walkM = mat(T.sidewalk);
  const dashMats = [];   // every lane marking is one instance of one mesh
  for (const r of roads) {
    const w = r.maxX - r.minX, d = r.maxZ - r.minZ, cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
    root.add(box(w, 0.08, d, roadM, cx, 0.04, cz, false));
    if (r.kind === 'avenue') {
      for (const s of [-1, 1]) root.add(box(1.8, 0.12, d, walkM, cx + s * (w / 2 + 0.9), 0.06, cz, false));
      for (let z = r.minZ + 2; z < r.maxZ; z += 4) dashMats.push([0.16, 0.01, 2, cx, 0.09, z]);
    } else {
      for (const s of [-1, 1]) root.add(box(w, 0.12, 1.8, walkM, cx, 0.06, cz + s * (d / 2 + 0.9), false));
      for (let x = r.minX + 2; x < r.maxX; x += 4) dashMats.push([2, 0.01, 0.16, x, 0.09, cz]);
    }
  }
  for (const d of districts) for (let i = -3; i <= 3; i++) dashMats.push([0.6, 0.01, 1.6, d.center.x + 0.5, 0.09, (d.road.minZ + d.road.maxZ) / 2 + i * 1.1]);   // zebra crossing
  { const im = new THREE.InstancedMesh(BOX, dash, dashMats.length), m4 = new THREE.Matrix4(); dashMats.forEach(([sx, sy, sz, x, y, z], i) => { m4.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz)); im.setMatrixAt(i, m4); }); im.receiveShadow = true; root.add(im); }
  const waterM = mat('#3a8fc9', { roughness: 0.25, metalness: 0.15 }), deckM = mat('#8d8f98'), railM = mat('#cfd3d8');
  for (const q of world.water ?? []) root.add(box(q.maxX - q.minX, 0.1, q.maxZ - q.minZ, waterM, (q.minX + q.maxX) / 2, 0.03, (q.minZ + q.maxZ) / 2, false));
  { const bg = new THREE.Group(); root.add(bg); for (const br of world.bridges ?? []) {
    bg.add(box(br.w, 0.3, br.d + 2, deckM, br.x, 0.12, br.z));
    for (const sx of [-1, 1]) bg.add(box(0.25, 0.9, br.d + 2, railM, br.x + sx * (br.w / 2 - 0.15), 0.7, br.z));
  } mergeStatic(bg); }
  if (world.landmark) buildLandmark(world.landmark, B, root);
  const hedge = mat(T.hedge), cx0 = (B.minX + B.maxX) / 2, cz0 = (B.minZ + B.maxZ) / 2;
  root.add(box(W, 0.9, 0.5, hedge, cx0, 0.45, B.minZ - 0.25), box(W, 0.9, 0.5, hedge, cx0, 0.45, B.maxZ + 0.25),
    box(0.5, 0.9, D + 1, hedge, B.minX - 0.25, 0.45, cz0), box(0.5, 0.9, D + 1, hedge, B.maxX + 0.25, 0.45, cz0));
  const nearestRow = (z) => (world.rowZ ?? [0]).reduce((best, r) => (Math.abs(r - z) < Math.abs(best - z) ? r : best), (world.rowZ ?? [0])[0]);

  // ---- shared materials ----
  const winMat = new THREE.MeshStandardMaterial({ color: '#31465f', emissive: '#ffd98a', emissiveIntensity: 0, roughness: 0.3 });
  const doorMat = mat('#6b3f1d');
  const winGeo = new THREE.PlaneGeometry(1.1, 1.2);

  const winList = [];
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
    const faceSign = nearestRow(b.cz) > b.cz ? 1 : -1;
    const faceZ = b.cz + faceSign * (b.sz / 2 + 0.025);
    const winPlaces = b.doorSide ? [-1, 1].flatMap((s) => [s * (b.doorWidth / 2 + 1.7), s * (b.doorWidth / 2 + 3.6)]).filter((x) => Math.abs(x) < b.sx / 2 - 0.9)
      : [-3, -1, 1, 3].filter((x) => Math.abs(x) < b.sx / 2 - 0.9);
    for (const dx of winPlaces) for (const y of (b.doorSide ? [1.6] : [1.2, 2.6])) {
      if (y + 0.6 > b.height) continue;
      winList.push([b.cx + dx, y, faceZ, faceSign < 0 ? Math.PI : 0]);
    }
    const sign = b.kind === 'house' ? null : textSprite(b.sign ?? b.name, b.doorSide ? 4.6 : 6.2, b.doorSide ? 0.62 : 0.9, b.doorSide ? b.roof : '#1e2a44', '#fff', b.doorSide ? 40 : 46);
    if (sign) { sign.position.set(b.cx, b.doorSide ? 3.05 : b.height - 0.7, faceZ + faceSign * 0.03); if (faceSign < 0) sign.rotation.y = Math.PI; g.add(sign); }

    buildings.push({ b, group: g, wallMeshes, lintel, roof, cut: 0, minX: b.cx - b.sx / 2, maxX: b.cx + b.sx / 2, minZ: b.cz - b.sz / 2, maxZ: b.cz + b.sz / 2 });
  }

  { const im = new THREE.InstancedMesh(winGeo, winMat, Math.max(1, winList.length)), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(); im.count = winList.length;
    winList.forEach(([x, y, z, ry], i) => { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry); m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1)); im.setMatrixAt(i, m4); }); root.add(im); }

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

  // ---- props (instanced: one draw call per kind) ----
  const trunkG = new THREE.CylinderGeometry(0.14, 0.2, 1, 6), leafG = new THREE.IcosahedronGeometry(1, 0), poleG = new THREE.CylinderGeometry(0.05, 0.07, 1, 6), headG = new THREE.SphereGeometry(0.22, 8, 6), binG = new THREE.CylinderGeometry(0.22, 0.2, 0.7, 8);
  const lampHead = new THREE.MeshStandardMaterial({ color: '#fff2c0', emissive: '#ffcf70', emissiveIntensity: 0.1 });
  const binM = mat('#4b6b57'), benchM = mat('#a5703c'), darkM = mat('#33363f');
  const trees = world.props.filter((p) => p.type === 'tree'), lampsP = world.props.filter((p) => p.type === 'lamp'), binsP = world.props.filter((p) => p.type === 'bin');
  const inst = (geo, m, list, f, shadow = true) => { if (!list.length) return null; const im = new THREE.InstancedMesh(geo, m, list.length), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(); list.forEach((p, i) => { const [x, y, z, sx, sy, sz] = f(p); m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz)); im.setMatrixAt(i, m4); }); im.castShadow = shadow; im.receiveShadow = true; root.add(im); return im; };
  inst(trunkG, mat('#7a5230'), trees, (p) => { const s = p.s ?? 1; return [p.x, 0.8 * s, p.z, s, 1.6 * s, s]; });
  inst(leafG, mat('#4f9d45'), trees, (p) => { const s = p.s ?? 1; return [p.x, 2.4 * s, p.z, 1.5 * s, 1.3 * s, 1.5 * s]; });
  inst(leafG, mat('#66b955'), trees, (p) => { const s = p.s ?? 1; return [p.x + 0.3 * s, 3.3 * s, p.z + 0.1 * s, 1.1 * s, 1.0 * s, 1.1 * s]; });
  inst(poleG, darkM, lampsP, (p) => [p.x, 2.1, p.z, 1, 4.2, 1]);
  inst(headG, lampHead, lampsP, (p) => [p.x, 4.3, p.z, 1, 1, 1], false);
  inst(binG, binM, binsP, (p) => [p.x, 0.35, p.z, 1, 1, 1]);
  { const bg = new THREE.Group(); root.add(bg);
    for (const p of world.props) if (p.type === 'bench') { const g = new THREE.Group(); g.position.set(p.x, 0, p.z); g.rotation.y = p.ry ?? 0; g.add(box(1.6, 0.1, 0.5, benchM, 0, 0.5, 0), box(1.6, 0.5, 0.08, benchM, 0, 0.8, -0.24), box(0.1, 0.5, 0.45, darkM, -0.7, 0.25, 0), box(0.1, 0.5, 0.45, darkM, 0.7, 0.25, 0)); g.updateMatrixWorld(true); for (const ch of [...g.children]) { ch.applyMatrix4(g.matrix); bg.add(ch); } }
    mergeStatic(bg); }
  // Streetlight glow: a small pool of real lights follows the player to the nearest lamps (hundreds of lights would be far too slow).
  const lampPos = lampsP.map((p) => ({ x: p.x, z: p.z }));
  for (let i = 0; i < 8; i++) { const l = new THREE.PointLight('#ffc873', 0, 14, 1.6); l.position.set(0, 4.1, 0); root.add(l); lamps.push(l); }
  let lampAt = -1;
  const placeLamps = (me) => { if (!lampPos.length) return; const near = lampPos.map((l) => ({ l, d: (l.x - me.x) ** 2 + (l.z - me.z) ** 2 })).sort((a, b) => a.d - b.d); lamps.forEach((light, i) => { const n = near[i]; if (n) light.position.set(n.l.x, 4.1, n.l.z); }); };

  // ---- interaction markers ----
  const ICON = { door: '🏠', shop: '🛒', work: '💼' };
  for (const z of world.zones) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 40), new THREE.MeshBasicMaterial({ color: '#ffe36e', transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(z.x, 0.12, z.z); root.add(ring);
    const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture(ICON[z.kind]), transparent: true, depthWrite: false }));
    icon.scale.set(1.1, 1.1, 1.1); icon.position.set(z.x, 2.6, z.z); root.add(icon);
    markers.push({ z, ring, icon });
  }

  // ---- landmarks and businesses with floating name labels ----
  const labelGroup = new THREE.Group(); root.add(labelGroup);
  for (const p of world.pois ?? []) buildPOI(p, root, labelGroup);
  const BUILDING_EMOJI = { apt: '🏢', grocery: '🛒', cafe: '☕', jobs: '💼', bank: '🏦' };
  for (const b of world.buildings) { if (b.kind === 'house') continue; const lab = makeLabel(BUILDING_EMOJI[b.short ?? b.id] ?? '🏠', b.name, 'biz'); lab.position.set(b.cx, b.height + 2.4, b.cz); labelGroup.add(lab); }

  // ---- lots: clickable houses, apartment block and empty plots with status banners ----
  const lots = new Map(), pickables = []; let bannersOn = true;
  const bannerTex = (lines, bg, fg) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 56 + lines.length * 62;
    const g = c.getContext('2d'); g.fillStyle = bg; g.beginPath(); g.roundRect(4, 4, c.width - 8, c.height - 8, 30); g.fill();
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((t, i) => { let px = i ? 40 : 46; const font = (n) => `${i ? 600 : 800} ${n}px system-ui, "Segoe UI", sans-serif`; g.font = font(px); while (g.measureText(t).width > 470 && px > 18) { px -= 2; g.font = font(px); } g.fillText(t, 256, 52 + i * 62); });
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return { t, w: c.width, h: c.height };
  };
  const fenceM = mat('#8a6a43');
  for (const l of world.lots ?? []) {
    const g = new THREE.Group(); root.add(g);
    const top = l.kind === 'land' ? 0.2 : (world.buildings.find((b) => b.id === l.building)?.height ?? 3.4) + 0.6;
    if (l.kind === 'land') {
      const fg = new THREE.Group(); g.add(fg);
      fg.add(box(l.sx, 0.06, l.sz, mat(new THREE.Color(themeOf(l.area).ground).lerp(new THREE.Color('#d8c48a'), 0.35)), l.cx, 0.05, l.cz, false));
      for (const [x, z, w, d] of [[0, -l.sz / 2, l.sx, 0.12], [0, l.sz / 2, l.sx, 0.12], [-l.sx / 2, 0, 0.12, l.sz], [l.sx / 2, 0, 0.12, l.sz]]) fg.add(box(w, 0.7, d, fenceM, l.cx + x, 0.35, l.cz + z));
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) fg.add(box(0.2, 1.1, 0.2, fenceM, l.cx + x * l.sx / 2, 0.55, l.cz + z * l.sz / 2));
      mergeStatic(fg);
    }
    const pick = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ visible: false }));
    pick.scale.set(l.sx, l.kind === 'land' ? 3 : top, l.sz); pick.position.set(l.cx, (l.kind === 'land' ? 3 : top) / 2, l.cz); pick.userData.lotId = l.id; g.add(pick); pickables.push(pick);
    const banner = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false })); banner.position.set(l.cx, top + 1.8, l.cz); banner.visible = false; g.add(banner);
    lots.set(l.id, { l, g, banner, house: null, top });
  }
  const miniHouse = (l) => { const h = new THREE.Group(); h.add(box(l.sx * 0.55, 2.6, l.sz * 0.55, mat('#e8d9b5'), l.cx, 1.3, l.cz), box(l.sx * 0.62, 0.35, l.sz * 0.62, mat('#b4553a'), l.cx, 2.8, l.cz), box(1.0, 1.8, 0.1, mat('#6b4a2b'), l.cx, 0.9, l.cz + (l.cz < 0 ? 1 : -1) * (l.sz * 0.275 + 0.03))); return h; };

  // ---- furniture (only the player's own, inside their home) ----
  const furnRoot = new THREE.Group(); root.add(furnRoot); const furnMeshes = new Map();
  const buildModel = (def) => { const g = new THREE.Group(); for (const p of def.parts) g.add(box(p.w, p.h, p.d, mat(p.c), p.x, p.y, p.z)); return g; };
  const ghost = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: '#6fe0a0', transparent: true, opacity: 0.45, depthWrite: false })); ghost.visible = false; root.add(ghost);
  const ndcRay = (x, y, camera) => { const r = new THREE.Raycaster(); r.setFromCamera({ x, y }, camera); return r; };

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
        o.banner.material.map?.dispose(); o.banner.material.map = t; o.banner.material.needsUpdate = true; o.banner.scale.set(w / 85, h / 85, 1); o.banner.visible = bannersOn;
        if (st.house && !o.house && o.l.kind === 'land') { o.house = miniHouse(o.l); o.g.add(o.house); }
        if (!st.house && o.house) { o.g.remove(o.house); o.house = null; }
      }
    },
    /** list: [{furnitureId,itemId,x,z,yaw}], catalog: Map(itemId -> {parts,...}) */
    setFurniture(list, catalog) {
      const keep = new Set(list.map((f) => f.furnitureId));
      for (const [id, g] of furnMeshes) if (!keep.has(id)) { furnRoot.remove(g); furnMeshes.delete(id); }
      for (const f of list) {
        const def = catalog.get(f.itemId); if (!def) continue;
        let g = furnMeshes.get(f.furnitureId);
        if (!g) { g = buildModel(def); g.userData.fid = f.furnitureId; furnRoot.add(g); furnMeshes.set(f.furnitureId, g); }
        g.position.set(f.x, 0, f.z); g.rotation.y = f.yaw ?? 0;
      }
    },
    /** Placement preview: def = catalog entry or null to hide. */
    setGhost(def, x, z, yaw, ok) {
      if (!def) { ghost.visible = false; return; }
      const quarter = Math.abs(Math.round(Math.sin(yaw))) === 1; const w = quarter ? def.sz : def.sx, d = quarter ? def.sx : def.sz, h = Math.max(def.h, 0.08);
      ghost.visible = true; ghost.scale.set(w, h, d); ghost.position.set(x, h / 2, z); ghost.material.color.set(ok ? '#6fe0a0' : '#ff6b6b');
    },
    /** Floating name labels are shown when the camera is pulled back (city view). */
    setCameraDistance(d) { labelGroup.visible = d > 21; const sh = d < 60; if (sun.castShadow !== sh) sun.castShadow = sh; },
    showBanners(on) { bannersOn = on; for (const o of lots.values()) o.banner.visible = on && !!o.banner.material.map; },
    pickFurniture(ndcX, ndcY, camera) {
      const hit = ndcRay(ndcX, ndcY, camera).intersectObjects(furnRoot.children, true)[0]; if (!hit) return null;
      let o = hit.object; while (o && !o.userData.fid) o = o.parent; return o?.userData.fid ?? null;
    },
    floorPoint(ndcX, ndcY, camera) {
      const r = ndcRay(ndcX, ndcY, camera), p = new THREE.Vector3();
      return r.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? { x: p.x, z: p.z } : null;
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
      scene.fog = scene.fog ?? new THREE.Fog(tmp, 140, 900); scene.fog.color.copy(tmp);
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
      if (time - lampAt > 0.4) { lampAt = time; placeLamps(me); }
      for (const l of lamps) l.intensity = dark * 28;
      lampHead.emissiveIntensity = 0.1 + dark * 2.4;
      winMat.emissiveIntensity = dark * 0.9; winMatP.emissiveIntensity = dark * 0.9;
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
        const near = hasAccess(d.b.gate) && Math.hypot(me.x - d.b.cx, me.z - (d.b.cz + (d.b.sz / 2) * (d.b.doorSide === '+z' ? 1 : -1))) < 3.2;
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

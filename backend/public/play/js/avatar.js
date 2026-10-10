// Low-poly people. Built from a handful of primitives so a whole street of them is cheap to draw.
import * as THREE from 'three';

export const SKIN = ['#fbd8c0', '#f3c19c', '#e0a37a', '#c98a5e', '#a8693f', '#8a5230', '#6b3d24', '#4a2a1a'];
export const HAIR = { black: '#1d1a1a', brown: '#5a3a22', blonde: '#e2c06a', red: '#b8472a', grey: '#a9a9b0', blue: '#3a64d8' };
export const OUTFIT = {
  casual_1: { top: '#3a7bd5', bottom: '#2d3a5a' }, casual_2: { top: '#59b36b', bottom: '#c9b48a' },
  smart_1: { top: '#f4f4f4', bottom: '#2b2b36' }, work_1: { top: '#f08a2c', bottom: '#555a63' },
};
export const BODY = { body_a: { w: 1, h: 1 }, body_b: { w: 0.9, h: 1.04 }, body_c: { w: 1.12, h: 0.98 }, body_d: { w: 0.96, h: 0.9 } };
export const EMOTE_ICON = { wave: '👋', dance: '💃', laugh: '😂', heart: '❤️', thumbs: '👍' };

const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  head: new THREE.IcosahedronGeometry(0.26, 2),
  cap: new THREE.SphereGeometry(0.275, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.56),
  ball: new THREE.IcosahedronGeometry(0.07, 1),
  eye: new THREE.SphereGeometry(0.032, 8, 6),
  ring: new THREE.RingGeometry(0.42, 0.5, 28),
  torso: new THREE.CapsuleGeometry(0.22, 0.3, 3, 8),
  leg: new THREE.CapsuleGeometry(0.1, 0.5, 3, 7),
  arm: new THREE.CapsuleGeometry(0.075, 0.4, 3, 7),
  hand: new THREE.IcosahedronGeometry(0.085, 1),
};
const mat = (c, extra = {}) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.85, metalness: 0, ...extra });
const part = (geo, m, x, y, z, sx = 1, sy = 1, sz = 1) => {
  const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.scale.set(sx, sy, sz); o.castShadow = true; return o;
};

const emojiTextures = new Map();
function emojiSprite(emoji) {
  if (!emojiTextures.has(emoji)) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'); g.font = '92px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(emoji, 64, 70);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; emojiTextures.set(emoji, t);
  }
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTextures.get(emoji), transparent: true, depthWrite: false }));
  s.scale.set(0.7, 0.7, 0.7); return s;
}

export function createAvatar(a = {}, opts = {}) {
  const skin = mat(SKIN[a.skinTone] ?? SKIN[2]);
  const outfit = OUTFIT[a.outfit] ?? OUTFIT.casual_1;
  const top = mat(outfit.top), bottom = mat(outfit.bottom);
  const hairM = mat(HAIR[a.hairColor] ?? HAIR.brown);
  const body = BODY[a.bodyPreset] ?? BODY.body_a;
  const root = new THREE.Group();
  const rig = new THREE.Group(); rig.scale.set(body.w, body.h, body.w); root.add(rig);

  const torso = part(G.torso, top, 0, 1.1, 0, 1, 1, 0.78);
  const head = part(G.head, skin, 0, 1.63, 0);
  const eyeM = mat('#241a18', { roughness: 0.4 });
  const eyeL = part(G.eye, eyeM, -0.09, 1.65, 0.235), eyeR = part(G.eye, eyeM, 0.09, 1.65, 0.235);
  rig.add(torso, head, eyeL, eyeR);

  const style = a.hairstyle ?? 'short';
  const capH = style === 'buzz' ? 0.94 : 1;
  rig.add(part(G.cap, hairM, 0, 1.64, -0.01, capH, capH, capH));
  if (style === 'long') rig.add(part(G.box, hairM, 0, 1.46, -0.19, 0.5, 0.6, 0.13));
  if (style === 'bun') rig.add(part(G.head, hairM, 0, 1.97, -0.06, 0.55, 0.55, 0.55));
  if (style === 'curly') for (let i = 0; i < 10; i++) { const t = (i / 10) * Math.PI * 2; rig.add(part(G.ball, hairM, Math.sin(t) * 0.25, 1.74 + (i % 2) * 0.04, Math.cos(t) * 0.22 - 0.04, 1.7, 1.7, 1.7)); }
  if (style === 'braids') { rig.add(part(G.box, hairM, -0.23, 1.46, -0.06, 0.08, 0.5, 0.08)); rig.add(part(G.box, hairM, 0.23, 1.46, -0.06, 0.08, 0.5, 0.08)); }

  const shoeM = mat('#2a2d36');
  const limb = (geo, x, y, drop, m, extra) => { const g = new THREE.Group(); g.position.set(x, y, 0); g.add(part(geo, m, 0, -drop, 0)); if (extra) extra(g); rig.add(g); return g; };
  const shoe = (g) => g.add(part(G.box, shoeM, 0, -0.74, 0.04, 0.2, 0.1, 0.32));
  const legL = limb(G.leg, -0.12, 0.82, 0.36, bottom, shoe), legR = limb(G.leg, 0.12, 0.82, 0.36, bottom, shoe);
  const hand = (g) => g.add(part(G.hand, skin, 0, -0.5, 0));
  const armL = limb(G.arm, -0.32, 1.36, 0.27, top, hand), armR = limb(G.arm, 0.32, 1.36, 0.27, top, hand);

  if (opts.me) {
    const ring = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04; root.add(ring);
  }

  let phase = Math.random() * 6, emote = null, emoteT = 0, bubble = null;
  const api = {
    group: root,
    setEmote(e) {
      emote = e; emoteT = 0;
      if (bubble) { root.remove(bubble); bubble.material.dispose(); }
      bubble = emojiSprite(EMOTE_ICON[e] ?? '💬'); bubble.position.set(0, 2.5, 0); root.add(bubble);
    },
    /** t = seconds, dt = frame time, moving = bool */
    update(dt, moving) {
      phase += dt * (moving ? 9 : 1.6);
      const swing = moving ? Math.sin(phase) * 0.75 : 0;
      legL.rotation.x = swing; legR.rotation.x = -swing; armL.rotation.x = -swing * 0.9; armR.rotation.x = swing * 0.9;
      rig.position.y = moving ? Math.abs(Math.sin(phase)) * 0.05 : Math.sin(phase) * 0.012;
      rig.rotation.z = 0; rig.rotation.y = 0;
      if (emote) {
        emoteT += dt;
        if (emote === 'wave' || emote === 'thumbs') { armR.rotation.x = -Math.PI + 0.3; armR.rotation.z = emote === 'wave' ? Math.sin(emoteT * 12) * 0.5 : 0; }
        if (emote === 'dance') { rig.rotation.y = Math.sin(emoteT * 7) * 0.5; rig.position.y = Math.abs(Math.sin(emoteT * 7)) * 0.12; armL.rotation.x = armR.rotation.x = -2.4 + Math.sin(emoteT * 14) * 0.4; }
        if (emote === 'laugh') { rig.position.y = Math.abs(Math.sin(emoteT * 16)) * 0.07; rig.rotation.z = Math.sin(emoteT * 16) * 0.05; }
        if (bubble) { bubble.position.y = 2.5 + Math.min(emoteT, 0.4) * 0.3 + Math.sin(emoteT * 4) * 0.04; bubble.material.opacity = emoteT > 2.2 ? Math.max(0, 1 - (emoteT - 2.2) / 0.4) : 1; }
        if (emoteT > 2.6) { emote = null; armR.rotation.z = 0; if (bubble) { root.remove(bubble); bubble.material.dispose(); bubble = null; } }
      }
    },
    dispose() { for (const m of [skin, top, bottom, hairM, eyeM]) m.dispose(); },
  };
  return api;
}

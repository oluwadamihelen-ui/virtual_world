// Shared movement + collision rules. Used by BOTH the game server (authority) and the browser (prediction),
// so they can never disagree about where a wall is. Units: metres, seconds. Plain JS so it runs in both places.

export const PLAYER_RADIUS = 0.4;
export const WALK_SPEED = 4.0;
export const RUN_SPEED = 6.5;
export const WALL = 0.3;

const box = (cx, cz, sx, sz) => ({ minX: cx - sx / 2, maxX: cx + sx / 2, minZ: cz - sz / 2, maxZ: cz + sz / 2 });

/** Wall boxes of a hollow building with a door gap; also returns the gate box that fills the doorway. */
export function buildingBoxes(b) {
  if (!b.doorSide) return { walls: [box(b.cx, b.cz, b.sx, b.sz)], gate: null };
  const t = WALL, hx = b.sx / 2, hz = b.sz / 2, dw = b.doorWidth;
  const front = b.doorSide === '+z' ? b.cz + hz - t / 2 : b.cz - hz + t / 2;
  const back = b.doorSide === '+z' ? b.cz - hz + t / 2 : b.cz + hz - t / 2;
  const seg = (b.sx - dw) / 2;
  return {
    walls: [
      box(b.cx, back, b.sx, t),
      box(b.cx - hx + t / 2, b.cz, t, b.sz - 2 * t),
      box(b.cx + hx - t / 2, b.cz, t, b.sz - 2 * t),
      box(b.cx - dw / 2 - seg / 2, front, seg, t),
      box(b.cx + dw / 2 + seg / 2, front, seg, t),
    ],
    gate: box(b.cx, front, dw, t),
    frontZ: front,
  };
}

export function buildColliders(world) {
  const boxes = [], gates = [];
  for (const b of world.buildings) {
    const { walls, gate } = buildingBoxes(b);
    boxes.push(...walls);
    if (gate && b.gate) gates.push({ gate: b.gate, ...gate });
    else if (gate) { /* open doorway: nothing to add */ }
  }
  for (const f of world.furniture) boxes.push(box(f.x, f.z, f.sx, f.sz));
  for (const p of world.props) {
    if (p.type === 'tree') boxes.push(box(p.x, p.z, 0.7, 0.7));
    else if (p.type === 'lamp') boxes.push(box(p.x, p.z, 0.4, 0.4));
    else if (p.type === 'bench') boxes.push(box(p.x, p.z, p.ry && Math.abs(Math.sin(p.ry)) > 0.7 ? 0.7 : 1.7, p.ry && Math.abs(Math.sin(p.ry)) > 0.7 ? 1.7 : 0.7));
    else if (p.type === 'bin') boxes.push(box(p.x, p.z, 0.5, 0.5));
  }
  return { boxes, gates };
}

function hits(x, z, r, c, hasGate) {
  for (const b of c.boxes) if (x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r) return true;
  for (const g of c.gates) {
    if (hasGate && hasGate(g.gate)) continue;
    if (x > g.minX - r && x < g.maxX + r && z > g.minZ - r && z < g.maxZ + r) return true;
  }
  return false;
}

export function isBlocked(x, z, colliders, hasGate, bounds) {
  if (x < bounds.minX + PLAYER_RADIUS || x > bounds.maxX - PLAYER_RADIUS || z < bounds.minZ + PLAYER_RADIUS || z > bounds.maxZ - PLAYER_RADIUS) return true;
  return hits(x, z, PLAYER_RADIUS, colliders, hasGate);
}

/**
 * Advance one entity. input = {dx, dz, run}: only the DIRECTION matters; speed is fixed here, so a client can never
 * move faster than the rules allow no matter what it sends. Mutates p = {x, z, ry, moving}.
 */
export function stepPlayer(p, input, dt, colliders, hasGate, bounds) {
  let dx = Number(input.dx) || 0, dz = Number(input.dz) || 0;
  const len = Math.hypot(dx, dz);
  p.moving = false;
  if (len < 0.01) return p;
  dx /= len; dz /= len;
  const speed = input.run ? RUN_SPEED : WALK_SPEED;
  p.ry = Math.atan2(dx, dz);
  // sub-step so a fast mover can never skip over a thin wall
  let remaining = dt;
  while (remaining > 1e-6) {
    const h = Math.min(remaining, 0.04);
    remaining -= h;
    const nx = p.x + dx * speed * h, nz = p.z + dz * speed * h;
    let moved = false;
    if (!isBlocked(nx, p.z, colliders, hasGate, bounds)) { p.x = nx; moved = true; }
    if (!isBlocked(p.x, nz, colliders, hasGate, bounds)) { p.z = nz; moved = true; }
    if (moved) p.moving = true;
  }
  return p;
}

export const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** In-game clock: 1 real minute = 1 game hour (a full day lasts 24 real minutes). */
export function gameClock(nowMs) {
  const dayMs = 24 * 60_000;
  const t = ((nowMs % dayMs) + dayMs) % dayMs;
  const hour = t / 60_000;
  const dayIndex = Math.floor(nowMs / dayMs);
  return { hour, dayIndex };
}

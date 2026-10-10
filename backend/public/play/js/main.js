import * as THREE from 'three';
import { createWorld3D } from './world3d.js';
import { createAvatar } from './avatar.js';
import { stepPlayer, buildColliders, gameClock, dist2 } from '/shared/sim.mjs';
import { api, friendlyError, Connection } from './net.js';
import * as U from './ui.js';

// ============================================================================ renderer
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

// ============================================================================ state
const S = { token: sessionStorage.getItem('mvw.token'), world: null, w3d: null, colliders: null, clockOffset: 0, conn: null, char: null, mode: 'menu', orbit: 0 };
let G = null; // in-game state, exists only while connected to a world

const GOALS = [
  { id: 'first_home', icon: '🏠', title: 'Rent your first home', sub: 'Visit Maple Court Apartments' },
  { id: 'first_purchase', icon: '🥪', title: 'Buy something to eat', sub: 'Try the Corner Grocery' },
  { id: 'first_shift', icon: '💼', title: 'Finish a work shift', sub: 'Use the stock room work station' },
];
const PLACES = [
  { id: 'apt_door', icon: '🏠', label: 'Apartments' }, { id: 'grocery_counter', icon: '🛒', label: 'Grocery' }, { id: 'grocery_work', icon: '💼', label: 'Work station' },
];

// ============================================================================ boot / menus
async function boot() {
  try { S.world = await api.world(); } catch { document.body.innerHTML = '<p style="color:#fff;padding:30px">Cannot reach the game server. Is it running?</p>'; return; }
  S.colliders = buildColliders(S.world);
  S.w3d = createWorld3D(S.world, scene);
  requestAnimationFrame(frame);
  if (S.token) { try { await showCharacterScreen(); return; } catch { /* token expired */ } }
  showLogin();
}
function showLogin() {
  S.token = null; sessionStorage.removeItem('mvw.token');
  U.showAuth({ onSubmit: async (mode, email, pw) => {
    try {
      if (mode === 'register') await api.register(email, pw);
      const r = await api.login(email, pw);
      S.token = r.token; sessionStorage.setItem('mvw.token', r.token);
      await showCharacterScreen();
    } catch (e) { throw new Error(friendlyError(e)); }
  } });
}
async function showCharacterScreen() {
  const { characters } = await api.characters(S.token);
  if (!characters.length) return showCreateScreen(false);
  U.showCharacters(characters, { onPlay: play, onNew: () => showCreateScreen(true), onLogout: showLogin });
}
function showCreateScreen(canGoBack) {
  U.showCreator({ canGoBack, onBack: showCharacterScreen,
    onSubmit: async (name, appearance) => {
      try { const c = await api.createCharacter(S.token, name, appearance); await play({ characterId: c.characterId, displayName: c.displayName }); }
      catch (e) { throw new Error(friendlyError(e)); }
    } });
}

// ============================================================================ entering the world
function play(char) {
  S.char = char; U.clear();
  document.getElementById('ui').innerHTML = '<div class="screen"><div class="card"><h1>Entering New Meridian…</h1><p class="sub">Connecting to the game server.</p></div></div>';
  S.conn?.close();
  S.conn = new Connection({
    getTicket: async () => (await api.ticket(S.token, char.characterId)).ticket,
    onMessage: onServer,
    onStatus: (st) => {
      document.querySelector('.banner')?.remove();
      if (st === 'reconnecting') document.body.insertAdjacentHTML('beforeend', '<div class="banner">Connection lost. Reconnecting…</div>');
      if (st === 'replaced') endSession('You signed in from another place, so this session was closed.');
      if (st === 'kicked') endSession('You were disconnected for sending too many messages.');
      if (st === 'failed') endSession('Could not reconnect to the game server.');
    },
  });
  S.conn.open();
}
function endSession(text) {
  teardown(); S.mode = 'menu';
  document.getElementById('ui').innerHTML = `<div class="screen"><div class="card"><h1>Disconnected</h1><p class="sub">${U.esc(text)}</p><button class="btn" id="again">Back to the menu</button></div></div>`;
  document.getElementById('again').onclick = () => showCharacterScreen().catch(showLogin);
}
function teardown() {
  if (G) { for (const e of G.ents.values()) { scene.remove(e.av.group); e.tag.remove(); } scene.remove(G.me.av.group); G.me.tag.remove(); clearInterval(G.sendTimer); clearInterval(G.pingTimer); clearInterval(G.mapTimer); }
  G = null; S.conn?.close();
}

const keys = new Set();
function onServer(m) {
  switch (m.t) {
    case 'welcome': return enterWorld(m);
    case 'snap': return G && onSnap(m);
    case 'chat': return G && onChat(m);
    case 'emote': return G && onEmote(m);
    case 'toast': return U.toast(m.kind, m.text);
    case 'summary': return G && onSummary(m.summary, m.door);
    case 'shopinfo': if (G) { G.shop[m.zone] = { items: m.items, at: performance.now() }; G.ctxKey = null; } return;
    case 'phone': return G && onPhone(m);
    case 'pong': if (G) G.ping = Math.round(performance.now() - m.c); return;
  }
}

function makeTag(name, { me = false, npc = false } = {}) {
  const el = document.createElement('div'); el.className = `tag${me ? ' me' : ''}${npc ? ' npc' : ''}`;
  el.innerHTML = `<div class="name">${npc ? '' : '<i></i>'}${U.esc(name)}</div>`; document.getElementById('tags').append(el); return el;
}

function enterWorld(w) {
  const reconnect = !!G; if (G) teardown();
  S.world = w.world; S.colliders = buildColliders(w.world);
  S.clockOffset = w.serverNow - Date.now(); S.mode = 'game'; S.conn = S.conn ?? null;
  const me = { x: w.you.x, z: w.you.z, ry: 0, moving: false, av: createAvatar(w.you.appearance, { me: true }), tag: makeTag(w.you.name, { me: true }), name: w.you.name };
  scene.add(me.av.group);
  G = { w, me, ents: new Map(), summary: w.summary, door: w.door, access: new Set(w.summary.tenancy ? ['apartment'] : []), jobs: w.jobs ?? [],
    yaw: -0.75, pitch: 0.8, dist: 19, camT: new THREE.Vector3(me.x, 1, me.z), seq: 0, lastSent: { dx: 0, dz: 0, run: false, t: 0 }, ctxKey: null, shop: {},
    auto: null, nextTaskAt: 0, ping: 0, online: 1, sheet: null, minSeconds: 20 };
  const gj = G.jobs.find((j) => j.jobId === 'job_grocery_assistant'); if (gj) G.minSeconds = gj.minSecondsPerTask;
  U.buildHud({ places: PLACES, openSheet, say: sendChat, emote: (e) => S.conn.send({ t: 'emote', e }), walkTo });
  U.setGoals(GOALS, w.summary.achievements, w.summary.reputation); U.setMoney(w.summary.balance);
  { const c = gameClock(Date.now() + S.clockOffset); U.setClock(c.hour, c.dayIndex); U.setOnline(1); }
  G.sendTimer = setInterval(sendInput, 50);
  G.pingTimer = setInterval(() => G && S.conn.send({ t: 'ping', c: Math.round(performance.now()) }), 3000);
  if (!reconnect) U.toast('info', `Welcome, ${w.you.name}!`);
}

function onSummary(summary, door) {
  const prevDone = G.summary.activeShift?.tasksDone ?? -1;
  G.summary = summary; G.door = door; G.access = new Set(summary.tenancy ? ['apartment'] : []);
  U.setMoney(summary.balance); U.setGoals(GOALS, summary.achievements, summary.reputation);
  if (summary.activeShift && summary.activeShift.tasksDone > prevDone) G.nextTaskAt = performance.now() + G.minSeconds * 1000;
  G.ctxKey = null;
}

// ============================================================================ snapshots & entities
function onSnap(m) {
  G.online = m.online; U.setOnline(m.online);
  const [sx, sz] = m.you; const err = Math.hypot(sx - G.me.x, sz - G.me.z);
  if (err > 1.5) { G.me.x = sx; G.me.z = sz; } else if (err > 0.04) { G.me.x += (sx - G.me.x) * 0.12; G.me.z += (sz - G.me.z) * 0.12; }
  for (const s of m.spawns) {
    if (G.ents.has(s.id)) continue;
    const av = createAvatar(s.appearance); scene.add(av.group);
    const ent = { id: s.id, name: s.name, npc: s.npc, av, tag: makeTag(s.name ?? 'Resident', { npc: s.npc }), x: 0, z: 0, ry: 0, tx: 0, tz: 0, tr: 0, moving: false, first: true, bubble: null };
    if (!s.npc) ent.tag.onclick = (ev) => playerMenu(ent, ev);
    G.ents.set(s.id, ent);
  }
  for (const id of m.gone) { const e = G.ents.get(id); if (e) { scene.remove(e.av.group); e.tag.remove(); G.ents.delete(id); } }
  for (const [id, x, z, ry, mv, emote] of m.ps) {
    const e = G.ents.get(id); if (!e) continue;
    e.tx = x; e.tz = z; e.tr = ry; e.moving = !!mv;
    if (e.first) { e.x = x; e.z = z; e.ry = ry; e.first = false; }
    if (emote && emote !== e.lastEmote) { e.av.setEmote(emote); } e.lastEmote = emote;
  }
}
function onEmote(m) { if (m.id === G.w.you.id) G.me.av.setEmote(m.e); else G.ents.get(m.id)?.av.setEmote(m.e); }
function onChat(m) {
  U.addChatLine(m.name, m.text);
  const target = m.id === G.w.you.id ? G.me : G.ents.get(m.id); if (!target) return;
  target.tag.querySelector('.bubble')?.remove();
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = m.text; target.tag.prepend(b);
  clearTimeout(target.bubbleT); target.bubbleT = setTimeout(() => b.remove(), 6500);
}
function playerMenu(ent, ev) {
  U.showMenu(ev.clientX, ev.clientY, ent.name, [
    { label: '🚫 Block', run: () => S.conn.send({ t: 'block', targetId: ent.id }) },
    { label: '⚠️ Report…', run: () => S.conn.send({ t: 'report', targetId: ent.id, category: 'harassment', detail: 'Reported from the game menu' }) },
  ]);
}

// ============================================================================ input
const typing = () => /INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '');
addEventListener('keydown', (e) => {
  if (!G) return;
  if (typing()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) { keys.add(k); G.auto = null; e.preventDefault(); }
  if (k === 'e' || k === ' ') { primaryAction(); e.preventDefault(); }
  if (k === 'enter') { document.getElementById('say')?.focus(); e.preventDefault(); }
  if (k === 'escape') U.closeSheet();
  if (k === 'm') openSheet('map');
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

const joy = { active: false, id: null, dx: 0, dz: 0 };
const joyEl = document.getElementById('joy'), knob = document.getElementById('joyknob');
if (matchMedia('(pointer: coarse)').matches) joyEl.hidden = false;
joyEl.addEventListener('pointerdown', (e) => { joy.active = true; joy.id = e.pointerId; joyEl.setPointerCapture(e.pointerId); moveJoy(e); G && (G.auto = null); });
joyEl.addEventListener('pointermove', (e) => joy.active && e.pointerId === joy.id && moveJoy(e));
const endJoy = (e) => { if (e.pointerId !== joy.id) return; joy.active = false; joy.dx = joy.dz = 0; knob.style.transform = ''; };
joyEl.addEventListener('pointerup', endJoy); joyEl.addEventListener('pointercancel', endJoy);
function moveJoy(e) {
  const r = joyEl.getBoundingClientRect(); let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
  const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; } joy.dx = x; joy.dz = y; knob.style.transform = `translate(${x * 35}px,${y * 35}px)`;
}

// camera drag / zoom
const pointers = new Map(); let pinch = 0;
canvas.addEventListener('pointerdown', (e) => { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId); if (!p || !G) return;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) G.dist = Math.min(30, Math.max(7, G.dist * (pinch / d))); pinch = d;
  } else { G.yaw -= (e.clientX - p.x) * 0.006; G.pitch = Math.min(1.25, Math.max(0.45, G.pitch + (e.clientY - p.y) * 0.004)); }
  p.x = e.clientX; p.y = e.clientY;
});
const upPtr = (e) => { pointers.delete(e.pointerId); pinch = 0; };
canvas.addEventListener('pointerup', upPtr); canvas.addEventListener('pointercancel', upPtr);
canvas.addEventListener('wheel', (e) => { if (G) G.dist = Math.min(30, Math.max(7, G.dist * (1 + e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });

/** Movement direction in WORLD space from keys/joystick, relative to where the camera looks. */
function wantedDirection() {
  let f = 0, r = 0;
  if (keys.has('w') || keys.has('arrowup')) f += 1; if (keys.has('s') || keys.has('arrowdown')) f -= 1;
  if (keys.has('d') || keys.has('arrowright')) r += 1; if (keys.has('a') || keys.has('arrowleft')) r -= 1;
  if (joy.active) { f += -joy.dz; r += joy.dx; }
  if (!f && !r && G.auto?.length) {
    const t = G.auto[0], dx = t.x - G.me.x, dz = t.z - G.me.z, d = Math.hypot(dx, dz);
    if (d < 0.7) { G.auto.shift(); return { dx: 0, dz: 0, run: false }; }
    return { dx: dx / d, dz: dz / d, run: d > 6 };
  }
  const l = Math.hypot(f, r); if (l > 1) { f /= l; r /= l; }
  const sin = Math.sin(G.yaw), cos = Math.cos(G.yaw);
  return { dx: -sin * f + cos * r, dz: -cos * f - sin * r, run: keys.has('shift') || (joy.active && Math.hypot(joy.dx, joy.dz) > 0.92) };
}
function sendInput() {
  if (!G) return;
  const d = wantedDirection(), now = performance.now(), L = G.lastSent;
  const dx = Math.round(d.dx * 100) / 100, dz = Math.round(d.dz * 100) / 100;
  const changed = dx !== L.dx || dz !== L.dz || d.run !== L.run;
  if (changed || ((dx || dz) && now - L.t > 250)) { S.conn.send({ t: 'input', seq: ++G.seq, dx, dz, run: d.run }); G.lastSent = { dx, dz, run: d.run, t: now }; }
  G.cur = { dx, dz, run: d.run };
}

function walkTo(zoneId) {
  const z = S.world.zones.find((q) => q.id === zoneId); if (!z) return;
  const inside = S.world.buildings.find((b) => b.enterable && G.me.x > b.cx - b.sx / 2 && G.me.x < b.cx + b.sx / 2 && G.me.z > b.cz - b.sz / 2 && G.me.z < b.cz + b.sz / 2);
  if (inside && !(z.building === inside.id)) return U.toast('info', 'Walk out of the building first.');
  const road = 0, path = [];
  if (z.building !== inside?.id) { path.push({ x: G.me.x, z: road }); path.push({ x: z.x, z: road }); }
  if (zoneId === 'apt_door' || zoneId.startsWith('grocery')) { if (zoneId !== 'apt_door') { const b = S.world.buildings.find((q) => q.id === 'grocery'); path.push({ x: b.cx, z: b.cz - b.sz / 2 - 1.5 }); path.push({ x: b.cx, z: b.cz - b.sz / 2 + 1.5 }); } }
  path.push({ x: z.x, z: z.z }); G.auto = path;
}

// ============================================================================ interactions & context card
const zoneNear = () => S.world.zones.find((z) => dist2(G.me.x, G.me.z, z.x, z.z) <= z.radius + 0.2);
function act(zone, item) { S.conn.send({ t: 'interact', zone, item }); }
function primaryAction() {
  const z = zoneNear(); if (!z) return;
  if (z.kind === 'door') return act(z.id);
  if (z.kind === 'shop') { const it = z.items[0]; return act(z.id, it.itemId); }
  if (z.kind === 'work') return act(z.id);
}
function renderCtx() {
  const z = zoneNear(); const s = G.summary;
  const key = z ? `${z.id}|${G.door?.state}|${s.activeShift?.tasksDone}|${s.balance}|${!!G.shop[z.id]}|${Math.ceil(Math.max(0, G.nextTaskAt - performance.now()) / 1000)}` : '';
  if (key === G.ctxKey) return; G.ctxKey = key;
  if (!z) return U.showCtx(null);
  const btn = (id, label, cls = '', dis = false) => `<button class="btn small ${cls}" data-a="${id}" ${dis ? 'disabled' : ''}>${label}</button>`;
  let body = '';
  if (z.kind === 'door') {
    const d = G.door;
    body = d.state === 'tenant' ? `<h3>🏠 ${U.esc(d.name)}</h3><p>This is your home. The door is unlocked for you.</p><div class="row">${btn('door', 'Unlock door [E]', 'green')}</div>`
      : d.state === 'free' ? `<h3>🏠 ${U.esc(d.name)}</h3><p>${U.mvc(d.rent)} MVC per week · you have ${U.mvc(s.balance)} MVC</p><div class="row">${btn('door', `Rent & move in [E]`, 'green', s.balance < d.rent)}${s.balance < d.rent ? '<small style="color:var(--red)">Not enough MVC yet</small>' : ''}</div>`
        : `<h3>🏠 ${U.esc(z.label)}</h3><p>Every room is taken right now. Check back soon!</p>`;
  } else if (z.kind === 'shop') {
    if (!G.shop[z.id]) { S.conn.send({ t: 'shopinfo', zone: z.id }); G.shop[z.id] = { items: z.items.map((i) => ({ ...i, price: null })), at: performance.now() }; }
    const items = G.shop[z.id].items;
    body = `<h3>🛒 ${U.esc(z.label)}</h3><p>You have ${U.mvc(s.balance)} MVC</p><div class="row">${items.map((i, n) => btn(`buy:${i.itemId}`, `${U.esc(i.label)}${i.price != null ? ` · ${i.price} MVC` : ''}${n === 0 ? ' [E]' : ''}`, 'green', i.price != null && s.balance < i.price)).join('')}</div>`;
  } else if (z.kind === 'work') {
    const sh = s.activeShift, wait = Math.ceil(Math.max(0, G.nextTaskAt - performance.now()) / 1000);
    const job = G.jobs.find((j) => j.jobId === z.jobId);
    body = sh ? `<h3>💼 Shift in progress</h3><p>${sh.tasksDone} of ${sh.tasksRequired} tasks done${wait ? ` · next task in ${wait}s` : ''}</p><div class="row">${btn('work', wait ? `Wait ${wait}s…` : 'Do the next task [E]', 'green', wait > 0)}</div>`
      : `<h3>💼 ${U.esc(job?.name ?? 'Work station')}</h3><p>${job ? `${job.tasksPerShift} tasks · pays ${U.mvc(job.wagePerShift)} MVC` : 'Earn MVC with a shift.'}</p><div class="row">${btn('work', 'Start a shift [E]', 'green')}</div>`;
  }
  U.showCtx(body, (el) => el.querySelectorAll('button[data-a]').forEach((b) => b.onclick = () => {
    const a = b.dataset.a; if (a === 'door' || a === 'work') act(z.id); else if (a.startsWith('buy:')) act(z.id, a.slice(4));
  }));
}

// ============================================================================ sheets (Home / Buy / Map / Phone)
function sendChat(input) { const t = input.value.trim(); if (!t) return; S.conn.send({ t: 'chat', text: t }); input.value = ''; input.blur(); }
function openSheet(tab, sub) {
  if (G.sheet === tab && !sub) { U.closeSheet(); G.sheet = null; return; }
  G.sheet = tab; clearInterval(G.mapTimer);
  if (tab === 'home') {
    if (G.summary.tenancy) { U.closeSheet(); G.sheet = null; S.conn.send({ t: 'home' }); return; }
    U.openSheet(tab, `${U.sheetTitle('Home')}<p>You don't have a home yet. Rent a room at <b>Maple Court Apartments</b> (the blue building) for ${U.mvc(G.door?.rent ?? 500)} MVC a week.</p><button class="btn green" id="goApt">Show me the way</button>`, () => { document.getElementById('goApt').onclick = () => { U.closeSheet(); G.sheet = null; walkTo('apt_door'); }; });
  } else if (tab === 'buy') {
    const z = zoneNear();
    U.openSheet(tab, `${U.sheetTitle('Buy')}${z?.kind === 'shop' ? `<p>You're at <b>${U.esc(z.label)}</b>. Tap an item to buy it.</p><div class="list">${(G.shop[z.id]?.items ?? z.items).map((i) => `<div class="li"><div><b>${U.esc(i.label)}</b><small>${i.price != null ? i.price + ' MVC' : ''}</small></div><button class="btn small green" data-i="${i.itemId}">Buy</button></div>`).join('')}</div>`
      : '<p>Walk up to a shop counter to buy things. Try the <b>Corner Grocery</b> on the south side of the street.</p><button class="btn green" id="goShop">Show me the way</button>'}`, (el) => {
      el.querySelectorAll('button[data-i]').forEach((b) => b.onclick = () => act(z.id, b.dataset.i));
      el.querySelector('#goShop')?.addEventListener('click', () => { U.closeSheet(); G.sheet = null; walkTo('grocery_counter'); });
    });
  } else if (tab === 'map') {
    U.openSheet(tab, `${U.sheetTitle('Map')}<div class="mapbox"><canvas id="mapc" width="560" height="430"></canvas></div>
      <div class="list" style="margin-top:10px"><div class="li"><div><b>📍 Residential District</b><small>You are here: Maple Court</small></div></div>
      ${['Market District', 'Central District', 'Waterfront District'].map((d) => `<div class="li" style="opacity:.55"><div><b>🔒 ${d}</b><small>Coming soon</small></div></div>`).join('')}</div>`);
    const draw = () => U.drawMap(document.getElementById('mapc'), S.world, G.me, [...G.ents.values()]); draw(); G.mapTimer = setInterval(draw, 250);
  } else {
    U.openSheet('phone', `${U.sheetTitle('Phone')}<div class="tabs"><button data-t="wallet">💰 Wallet</button><button data-t="jobs">💼 Jobs</button><button data-t="achievements">⭐ Goals</button></div><div id="phoneBody"><p>Loading…</p></div>`, (el) => {
      el.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => phoneTab(b.dataset.t));
    });
    phoneTab(sub ?? 'wallet');
  }
}
function phoneTab(t) { G.phoneTab = t; document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t)); S.conn.send({ t: 'phone', tab: t }); }
function onPhone(m) {
  const el = document.getElementById('phoneBody'); if (!el || m.tab !== G.phoneTab) return;
  el.innerHTML = m.tab === 'wallet' ? `<p style="margin:0 0 8px">Balance <b>${U.mvc(G.summary.balance)} MVC</b></p>${U.renderWallet(m.data)}` : m.tab === 'jobs' ? U.renderJobs(m.data) : U.renderGoals(m.data);
}

// ============================================================================ frame loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const clock = gameClock(Date.now() + S.clockOffset);

  if (G && S.mode === 'game') {
    const hasGate = (g) => G.access.has(g);
    const dir = G.cur ?? { dx: 0, dz: 0, run: false };
    stepPlayer(G.me, dir, dt, S.colliders, hasGate, S.world.bounds);
    G.me.av.group.position.set(G.me.x, 0, G.me.z);
    let dy = G.me.ry - G.me.av.group.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); G.me.av.group.rotation.y += dy * Math.min(1, dt * 14);
    G.me.av.update(dt, G.me.moving);
    const k = 1 - Math.exp(-dt * 11);
    for (const e of G.ents.values()) {
      e.x += (e.tx - e.x) * k; e.z += (e.tz - e.z) * k;
      let r = e.tr - e.ry; r = Math.atan2(Math.sin(r), Math.cos(r)); e.ry += r * k;
      e.av.group.position.set(e.x, 0, e.z); e.av.group.rotation.y = e.ry; e.av.update(dt, e.moving);
    }
    // camera follows with a little smoothing
    G.camT.lerp(new THREE.Vector3(G.me.x, 1.0, G.me.z), 1 - Math.exp(-dt * 9));
    const cp = Math.cos(G.pitch) * G.dist;
    camera.position.set(G.camT.x + Math.sin(G.yaw) * cp, G.camT.y + Math.sin(G.pitch) * G.dist, G.camT.z + Math.cos(G.yaw) * cp);
    camera.lookAt(G.camT);
    S.w3d.update(dt, clock.hour, G.me, G.access.has('apartment'));
    updateOverlay(clock);
  } else {
    // menu backdrop: a slow orbit around the neighbourhood
    S.orbit += dt * 0.05;
    camera.position.set(Math.sin(S.orbit) * 44, 20, Math.cos(S.orbit) * 36); camera.lookAt(0, 1, 0);
    if (S.w3d) S.w3d.update(dt, 15.2, { x: 0, z: 0 }, false); // the menu backdrop is always a sunny afternoon
  }
  renderer.render(scene, camera);
}

const v3 = new THREE.Vector3(); let hudT = 0;
function project(x, y, z) { v3.set(x, y, z).project(camera); return v3.z > 1 ? null : { x: (v3.x * 0.5 + 0.5) * innerWidth, y: (-v3.y * 0.5 + 0.5) * innerHeight }; }
function placeTag(tag, x, z, show) {
  const p = show ? project(x, 2.25, z) : null;
  if (!p) { tag.style.display = 'none'; return; }
  tag.style.display = ''; tag.style.left = `${p.x}px`; tag.style.top = `${p.y}px`;
}
function updateOverlay(clock) {
  placeTag(G.me.tag, G.me.x, G.me.z, true);
  let near = 1;
  for (const e of G.ents.values()) {
    const d = dist2(G.me.x, G.me.z, e.x, e.z);
    placeTag(e.tag, e.x, e.z, d < (e.npc ? 14 : 38));
    if (!e.npc && d <= 25) near++;
  }
  hudT += 1;
  if (hudT % 6 === 0) {
    U.setClock(clock.hour, clock.dayIndex); U.setSayPlaceholder(near);
    const ping = document.getElementById('ping'); if (ping) ping.textContent = G.ping ? `${G.ping} ms` : '--';
    const inside = S.world.buildings.find((b) => b.enterable && G.me.x > b.cx - b.sx / 2 && G.me.x < b.cx + b.sx / 2 && G.me.z > b.cz - b.sz / 2 && G.me.z < b.cz + b.sz / 2);
    const z = zoneNear();
    U.setPlace(inside ? inside.name : 'Maple Court', inside ? `Inside · ${S.world.district.name}` : z ? z.label : `${S.world.district.name} · New Meridian`);
    renderCtx();
  }
}

boot();

// debug handle for automated screenshots and console poking
window.mvw = { S, get G() { return G; }, scene, camera };

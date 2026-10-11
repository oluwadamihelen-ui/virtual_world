import * as THREE from 'three';
import { createWorld3D } from './world3d.js';
import { createAvatar } from './avatar.js';
import { stepPlayer, buildColliders, buildingBoxes, gameClock, dist2 } from '/shared/sim.mjs';
import { api, friendlyError, Connection } from './net.js';
import { createVoice } from './voice.js';
import * as U from './ui.js';
import { phoneApps } from './apps.js';

// ============================================================================ renderer
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 1000);
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

// ============================================================================ state
const S = { token: sessionStorage.getItem('mvw.token'), world: null, w3d: null, colliders: null, clockOffset: 0, conn: null, char: null, mode: 'menu', orbit: 0, geo: null };
let G = null; // in-game state, exists only while connected to a world
const now = () => Date.now() + S.clockOffset;

const GOALS = [
  { id: 'first_home', icon: 'home', title: 'Rent your first home', sub: 'Find the apartments' },
  { id: 'first_purchase', icon: 'coin', title: 'Buy something to eat', sub: 'Visit the grocery' },
  { id: 'first_shift', icon: 'brief', title: 'Finish a work shift', sub: 'Use the stock room work station' },
];

// ============================================================================ boot / menus
async function boot() {
  try { S.world = await api.world(); } catch { document.body.innerHTML = '<p style="color:#fff;padding:30px">Cannot reach the game server. Is it running?</p>'; return; }
  setWorld(S.world);
  requestAnimationFrame(frame);
  if (S.token) { try { await showCharacterScreen(); return; } catch { /* token expired */ } }
  showLogin();
}
function setWorld(world, force = false) {
  const key = `${world.metro ?? ''}|${world.cityId}|${world.districts?.length ?? 0}`;
  if (!force && S.w3d && S.w3d.key === key) { S.world = world; S.colliders = buildColliders(world); return; }
  S.w3d?.dispose();
  S.world = world; S.colliders = buildColliders(world); S.w3d = createWorld3D(world, scene); S.w3d.key = key;
}
function showLogin() {
  S.token = null; sessionStorage.removeItem('mvw.token');
  U.showAuth({ onSubmit: async (mode, email, pw, dob) => {
    try {
      if (mode === 'register') { if (!dob) throw new Error('Please enter your date of birth.'); await api.register(email, pw, dob); }
      const r = await api.login(email, pw);
      S.token = r.token; sessionStorage.setItem('mvw.token', r.token);
      await showCharacterScreen();
    } catch (e) { throw new Error(friendlyError(e)); }
  } });
}
async function showCharacterScreen() {
  const me = await api.me(S.token);
  if (!me.birthDateSet) {
    return U.showBirthdate({ onLogout: showLogin, onSubmit: async (dob) => { try { await api.setBirthDate(S.token, dob); } catch (e) { throw new Error(friendlyError(e)); } await showCharacterScreen(); } });
  }
  S.me = me;
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
  document.getElementById('ui').innerHTML = '<div class="screen"><div class="card"><h1>Entering the world…</h1><p class="sub">Connecting to the game server.</p></div></div>';
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
  teardownWorld(); S.conn?.close(); S.mode = 'menu';
  document.getElementById('ui').innerHTML = `<div class="screen"><div class="card"><h1>Disconnected</h1><p class="sub">${U.esc(text)}</p><button class="btn" id="again">Back to the menu</button></div></div>`;
  document.getElementById('again').onclick = () => showCharacterScreen().catch(showLogin);
}
function teardownWorld() {
  if (!G) return;
  G.voice?.close();
  for (const e of G.ents.values()) { scene.remove(e.av.group); e.tag.remove(); }
  scene.remove(G.me.av.group); G.me.tag.remove();
  clearInterval(G.estateTimer); clearInterval(G.sendTimer); clearInterval(G.pingTimer); clearInterval(G.mapTimer); G.hideTravel?.();
  G = null;
}

const keys = new Set();
function onServer(m) {
  switch (m.t) {
    case 'welcome': return enterWorld(m);
    case 'snap': return G && onSnap(m);
    case 'chat': return G && onChat(m);
    case 'voice': return G && G.voice.onRoom(m);
    case 'vsig': return G && G.voice.onSignal(m);
    case 'emote': return G && onEmote(m);
    case 'toast': return U.toast(m.kind, m.text);
    case 'summary': return G && onSummary(m.summary, m.door);
    case 'shopinfo': if (G) { G.shop[m.zone] = { items: m.items, at: performance.now() }; G.ctxKey = null; } return;
    case 'phone': return G?.phoneWait?.(m);
    case 'quote': return G && G.onQuote?.(m);
    case 'travel': return G && onTravelStart(m);
    case 'pong': if (G) G.ping = Math.round(performance.now() - m.c); return;
    case 'app': { const f = G?.pending.get(m.rid); if (f) { G.pending.delete(m.rid); f(m); } return; }
    case 'notify': return G && onNotify(m);
    case 'ride': if (G) { G.ride = m.on ? { mult: m.mult, until: m.seconds ? performance.now() + m.seconds * 1000 : Infinity, car: m.car ?? null } : null; setCar(G.me, m.on && m.car ? m.car.color : 0); carHud(m.on && m.car ? m.car : null); } return;
    case 'car': if (G?.ride?.car) { G.ride.mult = m.mult; G.ride.car = { ...G.ride.car, fuel: m.fuel, cond: m.cond }; carHud(G.ride.car); } return;
    case 'area': if (G) onArea(m); return;
    case 'arrived': if (G) { G.traveling = false; G.hideTravel?.(); G.hideTravel = null; G.auto = null; } return;
    case 'world': if (G) { G.w.world = m.world; setWorld(m.world, true); paintLots(); syncFurniture(); } return;
  }
}

function makeTag(name, { me = false, npc = false } = {}) {
  const el = document.createElement('div'); el.className = `tag${me ? ' me' : ''}${npc ? ' npc' : ''}`;
  el.innerHTML = `<div class="name">${npc ? '' : '<i></i>'}${U.esc(name)}</div>`; document.getElementById('tags').append(el); return el;
}

function enterWorld(w) {
  const keepSheet = !!G && !w.arrived;
  if (G) teardownWorld();
  setWorld(w.world);
  S.geo = w.geo; S.clockOffset = w.serverNow - Date.now(); S.mode = 'game';
  U.setCurrency(w.currency);
  const me = { x: w.you.x, z: w.you.z, ry: 0, moving: false, av: createAvatar(w.you.appearance, { me: true }), tag: makeTag(w.you.name, { me: true }), name: w.you.name };
  scene.add(me.av.group);
  G = { w, me, ents: new Map(), summary: w.summary, door: w.door, city: w.city, currency: w.currency, access: gatesFor(w.summary, w.city.id), catalog: new Map((w.furnitureCatalog ?? []).map((c) => [c.id, c])), jobs: w.jobs ?? [], local: w.localTransport,
    yaw: -0.75, pitch: 0.8, dist: 19, camT: new THREE.Vector3(me.x, 1, me.z), seq: 0, lastSent: { dx: 0, dz: 0, run: false, t: 0 }, ctxKey: null, shop: {},
    pending: new Map(), phone: w.phone ?? { adult: false, unread: 0 }, auto: null, nextTaskAt: 0, ping: 0, online: 1, minSeconds: 20, achievements: w.achievements };
  G.voice = createVoice({ send: (m) => S.conn.send(m), myId: w.you.id, toast: U.toast, iceServers: w.voiceIce, onChange: () => G && updateVoiceUi() });
  G.voice.resume(); window.mvwVoice = () => G.voice.debug();
  const gj = G.jobs.find((j) => j.jobId === 'job_grocery_assistant'); if (gj) G.minSeconds = gj.minSecondsPerTask;
  U.buildHud({
    openPhone: (app) => openPhone(app), openMap, furnish: () => toggleFurnish(), cityView: () => toggleCityView(), goHome: () => S.conn.send({ t: 'home' }),
    voice: () => G.voice.toggle(),
    say: sendChat, emote: (e) => S.conn.send({ t: 'emote', e }),
  });
  refreshHud(); U.setPhoneBadge(G.phone.unread);
  syncFurniture();   // show the furniture you already placed (nothing else triggers this when you come back online)
  G.sendTimer = setInterval(sendInput, 50);
  loadEstate(); G.estateTimer = setInterval(() => loadEstate(), 20000);
  G.pingTimer = setInterval(() => G && S.conn.send({ t: 'ping', c: Math.round(performance.now()) }), 3000);
  if (w.arrived) U.toast('ok', `Welcome to ${w.city.name}!`);
  else U.toast('info', `Welcome, ${w.you.name}!`);
  // coming back from a payment provider's page (…/play/?topup=<reference>): check that payment and show the Top up app
  const topupRef = new URLSearchParams(location.search).get('topup');
  if (topupRef) {
    history.replaceState(null, '', location.pathname);
    sendWait({ app: 'topup', a: 'ref', d: { ref: topupRef } }).then((r) => {
      if (r.ok) U.toast(r.data.credited ? 'ok' : 'info', r.data.credited ? `+${r.data.order.mvc.toLocaleString('en-US')} MVC added to your wallet.` : `Payment status: ${r.data.order.status}.`);
      openPhone('topup');
    });
  }
}
/** The player walked (or was carried) into another area of the same city: prices, place name and listings follow. */
function onArea(m) {
  G.city = m.city; G.currency = m.currency; U.setCurrency(m.currency); G.ctxKey = null; refreshHud();
  U.toast('info', `${m.city.name}, ${m.currency.countryName}`);
  loadEstate(); syncFurniture();
}
function onNotify(m) {
  if (m.kind === 'message') { G.phone.unread++; U.toast('info', `New message from ${m.from}`); }
  else if (m.kind === 'money') U.toast('ok', m.text);
  else if (m.kind === 'match') U.toast('ok', `It's a match with ${m.from}!`);
  G.onNotify?.(m); U.setPhoneBadge?.(G.phone.unread);
}
/** Mic button state, the room name, and a ring on the name tags of whoever is speaking. */
function updateVoiceUi() {
  const v = G.voice.state, b = document.getElementById('rMic'); if (!b) return;
  b.classList.toggle('on', v.on); b.classList.toggle('live', v.on && (v.mode === 'open' || v.talking));
  b.title = v.on ? (v.room ? `Voice on in ${v.room.name} (${v.peers.size} connected). Hold T to talk. Click to turn off.` : 'Voice is on. Walk into a building to talk with people inside. Click to turn off.') : 'Voice chat is off. Click to turn it on (18+).';
  G.me.tag.classList.toggle('speaking', v.speaking.has(G.w.you.id));
  for (const [id, e] of G.ents) e.tag.classList.toggle('speaking', v.speaking.has(id));
}
/** A simple car around an avatar while it is driving (color = 0 removes it). Everyone sees it: the server sends the color in snapshots. */
function setCar(ent, color) {
  ent.veh = color || 0;
  if (ent.carMesh) { ent.av.group.remove(ent.carMesh); ent.carMesh = null; }
  if (!color) return;
  const g = new THREE.Group(), body = new THREE.MeshStandardMaterial({ color, roughness: 0.5 }), dark = new THREE.MeshStandardMaterial({ color: '#1b1f27' }), glass = new THREE.MeshStandardMaterial({ color: '#9fc7e8', roughness: 0.2 });
  const box = (w, h, d, m, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); g.add(b); return b; };
  box(1.9, 0.6, 4.1, body, 0, 0.62, 0); box(1.7, 0.55, 2.0, glass, 0, 1.2, -0.35); box(1.8, 0.1, 2.1, body, 0, 1.52, -0.35);
  for (const [x, z] of [[-0.95, 1.3], [0.95, 1.3], [-0.95, -1.3], [0.95, -1.3]]) { const w = box(0.28, 0.7, 0.7, dark, x, 0.35, z); w.rotation.z = 0; }
  box(0.5, 0.18, 0.06, new THREE.MeshStandardMaterial({ color: '#fff4c2', emissive: '#ffe08a', emissiveIntensity: 0.6 }), -0.6, 0.75, 2.07); box(0.5, 0.18, 0.06, new THREE.MeshStandardMaterial({ color: '#fff4c2', emissive: '#ffe08a', emissiveIntensity: 0.6 }), 0.6, 0.75, 2.07);
  g.position.y = -0.0; ent.carMesh = g; ent.av.group.add(g);
}
/** Dashboard while driving: fuel, condition and a stop button. */
function carHud(car) {
  let el = document.getElementById('carHud');
  if (!car) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'carHud'; el.className = 'carhud'; document.getElementById('ui').append(el); }
  el.innerHTML = `<b>${U.esc(car.name)}</b><span>⛽ ${Number(car.fuel).toFixed(1)} L</span><span>🔧 ${Math.round(car.cond)}%</span><button id="carStop">Park</button>`;
  el.querySelector('#carStop').onclick = () => S.conn.send({ t: 'drive', on: false });
}
function refreshHp() {
  const h = G.summary.health; if (!h) return;
  let el = document.getElementById('hp');
  if (!el) { el = document.createElement('div'); el.id = 'hp'; el.className = 'hp'; el.title = 'Health. Open the Health app (phone) to get treated.'; document.getElementById('walletCard')?.after(el); el.onclick = () => openPhone('health'); }
  const c = h.value >= 70 ? '#5be0a8' : h.value >= 25 ? '#f4b942' : '#ff6b6b';
  el.innerHTML = `<span>❤ ${U.esc(h.label)}</span><i style="width:${Math.round(h.value)}%;background:${c}"></i>`;
}
function refreshHud() {
  const s = G.summary; refreshHp();
  U.setWallet({ name: G.me.name, mvcAmount: s.balance, cityName: G.city.name, country: G.currency });
  U.setGoals(GOALS, s.achievements, s.reputation);
  const c = gameClock(now()); U.setClock(c.hour, c.dayIndex, `${G.city.name} · ${G.online} online`);
}

const metroOfCity = (id) => S.geo.cities.find((c) => c.id === id)?.metro ?? id;
const gateOf = (area, lotId) => `${area}:${!lotId || lotId === 'apt' ? 'apartment' : lotId}`;
const gatesFor = (summary, cityId) => new Set(summary.tenancy && metroOfCity(summary.tenancy.district) === metroOfCity(cityId) ? [gateOf(summary.tenancy.district, summary.tenancy.lotId)] : []);
function onSummary(summary, door) {
  const prevDone = G.summary.activeShift?.tasksDone ?? -1;
  G.summary = summary; G.door = door; G.access = gatesFor(summary, G.city.id);
  if (summary.activeShift && summary.activeShift.tasksDone > prevDone) G.nextTaskAt = performance.now() + G.minSeconds * 1000;
  G.ctxKey = null; refreshHud(); G.onSummary?.(); syncFurniture();
}

// ============================================================================ travel
function onTravelStart(m) {
  G.hideTravel?.();
  const mode = S.geo.transport.find((t) => t.id === m.mode);
  G.traveling = true; U.closePanel();
  G.hideTravel = U.showTravel({ toName: m.toName, icon: mode?.icon ?? '🧳', mode: mode?.name ?? '', arrivesAt: m.arrivesAt, seconds: m.seconds, now });
}

// ============================================================================ snapshots & entities
function onSnap(m) {
  G.online = m.online;
  const [sx, sz] = m.you; const err = Math.hypot(sx - G.me.x, sz - G.me.z);
  if (err > 1.5) { G.me.x = sx; G.me.z = sz; } else if (err > 0.04) { G.me.x += (sx - G.me.x) * 0.12; G.me.z += (sz - G.me.z) * 0.12; }
  for (const s of m.spawns) {
    if (G.ents.has(s.id)) continue;
    const av = createAvatar(s.appearance); scene.add(av.group);
    const ent = { id: s.id, name: s.name, npc: s.npc, av, tag: makeTag(s.name ?? s.role ?? 'Resident', { npc: s.npc }), x: 0, z: 0, ry: 0, tx: 0, tz: 0, tr: 0, moving: false, first: true, bubble: null };
    if (!s.npc) ent.tag.onclick = (ev) => playerMenu(ent, ev);
    G.ents.set(s.id, ent);
  }
  for (const id of m.gone) { const e = G.ents.get(id); if (e) { scene.remove(e.av.group); e.tag.remove(); G.ents.delete(id); } }
  for (const [id, x, z, ry, mv, emote, veh] of m.ps) {
    const e = G.ents.get(id); if (!e) continue;
    if ((e.veh ?? 0) !== veh) setCar(e, veh);
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
    { label: 'Message', run: () => openPhone('chat', { id: ent.id, name: ent.name }) },
    { label: 'Block', run: () => S.conn.send({ t: 'block', targetId: ent.id }) },
    { label: 'Report…', run: () => U.reportDialog(ent.name ?? 'this player', (category, detail) => S.conn.send({ t: 'report', targetId: ent.id, category, detail })) },
  ]);
}

// ============================================================================ input
const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '');
addEventListener('keydown', (e) => {
  if (!G || G.traveling) return;
  if (typing()) { if (e.key === 'Escape') document.activeElement.blur(); return; }
  const k = e.key.toLowerCase();
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) { keys.add(k); G.auto = null; e.preventDefault(); }
  if (k === 'e' || k === ' ') { primaryAction(); e.preventDefault(); }
  if (k === 'enter') { document.getElementById('say')?.focus(); e.preventDefault(); }
  if (k === 'escape') { if (G.furn) endFurnish(); else U.closePanel(); }
  if (k === 'r' && G.furn) rotateFurn();
  if (k === 'm') openMap();
  if (k === 'p') openPhone();
  if (k === 'v') toggleCityView();
  if (k === 't' && !e.repeat) G.voice?.talk(true);
});
addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); if (e.key.toLowerCase() === 't') G?.voice?.talk(false); });
addEventListener('blur', () => { keys.clear(); G?.voice?.talk(false); });

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

const pointers = new Map(); let pinch = 0;
canvas.addEventListener('pointerdown', (e) => { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId); if (!p || !G) return;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) G.dist = Math.min(170, Math.max(7, G.dist * (pinch / d))); pinch = d;
  } else { G.yaw -= (e.clientX - p.x) * 0.006; G.pitch = Math.min(1.25, Math.max(0.45, G.pitch + (e.clientY - p.y) * 0.004)); }
  p.x = e.clientX; p.y = e.clientY;
});
const downAt = new Map();
canvas.addEventListener('pointerdown', (e) => downAt.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() }));
const upPtr = (e) => {
  pointers.delete(e.pointerId); pinch = 0;
  const d = downAt.get(e.pointerId); downAt.delete(e.pointerId);
  // a short tap (not a drag) on a house, plot or apartment block opens its listing
  if (d && G && S.w3d && e.type === 'pointerup' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && performance.now() - d.t < 450) {
    const r = canvas.getBoundingClientRect();
    const lot = S.w3d.pickLot(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1), camera);
    const lo = G.w.world.lots?.find((l) => l.id === lot); const inside = lo && Math.abs(G.me.x - lo.cx) < lo.sx / 2 && Math.abs(G.me.z - lo.cz) < lo.sz / 2;
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
    const label = G.furn ? null : S.w3d.pickLabel(nx, ny, camera);
    if (G.furn) onFurnTap(e, r);
    else if (label) openPlaceSheet(label);
    else if (lot && !inside) openEstateSheet(lot);
  }
};
canvas.addEventListener('pointerup', upPtr); canvas.addEventListener('pointercancel', upPtr);
canvas.addEventListener('wheel', (e) => { if (G) G.dist = Math.min(170, Math.max(7, G.dist * (1 + e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });

function wantedDirection() {
  if (G.traveling) return { dx: 0, dz: 0, run: false };
  let f = 0, r = 0;
  if (keys.has('w') || keys.has('arrowup')) f += 1; if (keys.has('s') || keys.has('arrowdown')) f -= 1;
  if (keys.has('d') || keys.has('arrowright')) r += 1; if (keys.has('a') || keys.has('arrowleft')) r -= 1;
  if (joy.active) { f += -joy.dz; r += joy.dx; }
  if (!f && !r && G.auto?.length) {
    const t = G.auto[0], dx = t.x - G.me.x, dz = t.z - G.me.z, d = Math.hypot(dx, dz);
    if (d < 0.7) { G.auto.shift(); if (!G.auto.length && G.ride) S.conn.send({ t: 'ride', on: false }); return { dx: 0, dz: 0, run: false }; }
    return { dx: dx / d, dz: dz / d, run: d > 6 };
  }
  const l = Math.hypot(f, r); if (l > 1) { f /= l; r /= l; }
  const sin = Math.sin(G.yaw), cos = Math.cos(G.yaw);
  return { dx: -sin * f + cos * r, dz: -cos * f - sin * r, run: keys.has('shift') || (joy.active && Math.hypot(joy.dx, joy.dz) > 0.92) };
}
function sendInput() {
  if (!G) return;
  const d = wantedDirection(), t = performance.now(), L = G.lastSent;
  const dx = Math.round(d.dx * 100) / 100, dz = Math.round(d.dz * 100) / 100;
  const changed = dx !== L.dx || dz !== L.dz || d.run !== L.run;
  if (changed || ((dx || dz) && t - L.t > 250)) { S.conn.send({ t: 'input', seq: ++G.seq, dx, dz, run: d.run }); G.lastSent = { dx, dz, run: d.run, t }; }
  G.cur = { dx, dz, run: d.run };
}

// ---- click-to-walk: out of the current building, along the road, in through the target's door
const inBuilding = (b, x, z) => x > b.cx - b.sx / 2 && x < b.cx + b.sx / 2 && z > b.cz - b.sz / 2 && z < b.cz + b.sz / 2;
function doorPoints(b) {
  const { frontZ } = buildingBoxes(b); const s = b.doorSide === '+z' ? 1 : -1;
  return { out: { x: b.cx, z: frontZ + s * 1.8 }, inn: { x: b.cx, z: frontZ - s * 1.8 } };
}
const rowRoad = (zz) => (S.world.rowZ ?? [0]).reduce((best, r) => (Math.abs(r - zz) < Math.abs(best - zz) ? r : best), (S.world.rowZ ?? [0])[0]);
/** Walk anywhere in the city: out of the current building, along the street, over a bridge if the target is on the other side, to the target. */
function routeTo(tx, tz, into = null) {
  const here = S.world.buildings.find((b) => b.enterable && inBuilding(b, G.me.x, G.me.z));
  const path = [];
  if (here) { const dp = doorPoints(here); path.push(dp.inn, dp.out); }
  const r0 = rowRoad(G.me.z), r1 = rowRoad(tz), startX = here ? doorPoints(here).out.x : G.me.x;
  path.push({ x: startX, z: r0 });
  if (r0 !== r1) { const ax = (S.world.avenueX ?? [0]).reduce((best, x) => (Math.abs(x - startX) < Math.abs(best - startX) ? x : best), (S.world.avenueX ?? [0])[0]); path.push({ x: ax, z: r0 }, { x: ax, z: r1 }); }
  if (into) { const d = doorPoints(into); path.push({ x: d.out.x, z: r1 }, d.out, d.inn); }
  else path.push({ x: tx, z: r1 });
  path.push({ x: tx, z: tz });
  G.auto = path; U.closePanel();
}
function walkToArea(areaId) { const d = S.world.districts.find((x) => x.id === areaId); if (!d) return; routeTo(d.spawn.x, d.spawn.z); U.toast('info', `Walking to ${d.name}…`); }
function walkToPlace(areaId, poiId) {
  const pl = S.geo.places[areaId]?.find((q) => q.id === poiId); if (!pl) return;
  routeTo(pl.x, pl.z + (pl.face === '+z' ? 1 : -1) * (pl.sz / 2 + 1.6)); U.toast('info', `Walking to ${pl.name}…`);
}
function walkTo(zoneId) {
  const z = S.world.zones.find((q) => q.id === zoneId); if (!z) return;
  const here = S.world.buildings.find((b) => b.enterable && inBuilding(b, G.me.x, G.me.z));
  const target = S.world.buildings.find((b) => b.id === z.building);
  const path = [];
  if (here) { const d = doorPoints(here); path.push(d.inn, d.out); }
  const roadZ = rowRoad(z.z);
  const targetInside = target && inBuilding(target, z.x, z.z);
  const entry = targetInside ? doorPoints(target).out : { x: z.x, z: z.z };
  if (!(here && here === target && targetInside)) { path.push({ x: here ? doorPoints(here).out.x : G.me.x, z: roadZ }); path.push({ x: entry.x, z: roadZ }); path.push(entry); }
  if (targetInside) path.push(doorPoints(target).inn);
  path.push({ x: z.x, z: z.z });
  G.auto = path; U.closePanel();
}

// ============================================================================ interactions & context card
const zoneNear = () => S.world.zones.find((z) => dist2(G.me.x, G.me.z, z.x, z.z) <= z.radius + 0.2);
function act(zone, item) { S.conn.send({ t: 'interact', zone, item }); }
function primaryAction() {
  const z = zoneNear(); if (!z) return;
  if (z.kind === 'door' || z.kind === 'work') return act(z.id);
  if (z.kind === 'shop') return act(z.id, z.items[0].itemId);
  if (z.kind === 'service' && z.bank) return openPhone('bank');
}
function renderCtx() {
  if (G.traveling) return U.showCtx(null);
  const z = zoneNear(); const s = G.summary;
  const key = z ? `${z.id}|${G.door?.state}|${s.activeShift?.tasksDone}|${s.balance}|${!!G.shop[z.id]}|${Math.ceil(Math.max(0, G.nextTaskAt - performance.now()) / 1000)}` : '';
  if (key === G.ctxKey) return; G.ctxKey = key;
  if (!z) return U.showCtx(null);
  const btn = (id, label, cls = '', dis = false) => `<button class="btn small ${cls}" data-a="${id}" ${dis ? 'disabled' : ''}>${label}</button>`;
  let body = '';
  if (z.kind === 'door' && z.lot && z.lot !== 'apt') {
    const mine = s.tenancy && s.tenancy.lotId === z.lot && s.tenancy.district === z.area;
    body = mine ? `<h3>${U.esc(s.tenancy.propertyName)}</h3><p>Your home. The door is unlocked for you.</p><div class="row">${btn('door', 'Unlock door [E]', 'go')}</div>`
      : `<h3>${U.esc(z.label)}</h3><p>The door is locked. See whether it is for sale or rent.</p><div class="row">${btn('details', 'See details', 'go')}</div>`;
  } else if (z.kind === 'door') {
    const d = G.door;
    body = d.state === 'house' ? `<h3>${U.esc(z.label)}</h3><p>You live in ${U.esc(d.name)}, a house on this street.</p>` : d.state === 'tenant' ? `<h3>${U.esc(d.name)}</h3><p>Your home. The door is unlocked for you.</p><div class="row">${btn('door', 'Unlock door [E]', 'go')}</div>`
      : d.state === 'free' ? `<h3>${U.esc(d.name)}</h3><p>${U.fmt(d.rent)} per week · you have ${U.fmt(s.balance)}</p><div class="row">${btn('door', 'Rent &amp; move in [E]', 'go', s.balance < d.rent)}${s.balance < d.rent ? '<small style="color:#a33">Not enough money yet</small>' : ''}</div>`
        : d.state === 'away' ? `<h3>${U.esc(z.label)}</h3><p>You already rent ${U.esc(d.name)} in ${U.esc(d.city)}. One home at a time.</p>`
          : `<h3>${U.esc(z.label)}</h3><p>Every room is taken right now. Check back soon!</p>`;
  } else if (z.kind === 'service') {
    body = `<h3>${U.esc(z.label)} · ${U.esc(z.title ?? '')}</h3><p>${U.esc(z.text)}</p>${z.bank ? `<div class="row">${btn('vault', 'Open my Vault [E]', 'go')}</div>` : ''}`;
  } else if (z.kind === 'shop') {
    if (!G.shop[z.id]) { S.conn.send({ t: 'shopinfo', zone: z.id }); G.shop[z.id] = { items: z.items.map((i) => ({ ...i, price: null })), at: performance.now() }; }
    const items = G.shop[z.id].items;
    body = `<h3>${U.esc(z.label)}</h3><p>You have ${U.fmt(s.balance)}</p><div class="row">${items.map((i, n) => btn(`buy:${i.itemId}`, `${U.esc(i.label)}${i.price != null ? ` · ${U.fmt(i.price)}` : ''}${n === 0 ? ' [E]' : ''}`, 'go', i.price != null && s.balance < i.price)).join('')}</div>`;
  } else if (z.kind === 'work') {
    const sh = s.activeShift, wait = Math.ceil(Math.max(0, G.nextTaskAt - performance.now()) / 1000);
    const job = G.jobs.find((j) => j.jobId === z.jobId);
    body = sh ? `<h3>Shift in progress</h3><p>${sh.tasksDone} of ${sh.tasksRequired} tasks done${wait ? ` · next task in ${wait}s` : ''}</p><div class="row">${btn('work', wait ? `Wait ${wait}s…` : 'Do the next task [E]', 'go', wait > 0)}</div>`
      : `<h3>${U.esc(job?.name ?? 'Work station')}</h3><p>${job ? `${job.tasksPerShift} tasks · pays ${U.fmt(job.wagePerShift)}` : 'Earn money with a shift.'}</p><div class="row">${btn('work', 'Start a shift [E]', 'go')}</div>`;
  }
  U.showCtx(body, (el) => el.querySelectorAll('button[data-a]').forEach((b) => b.onclick = () => {
    const a = b.dataset.a; if (a === 'vault') openPhone('bank'); else if (a === 'details') openEstateSheet(`${z.area}:${z.lot}`); else if (a === 'door' || a === 'work') act(z.id); else if (a.startsWith('buy:')) act(z.id, a.slice(4));
  }));
}

// ============================================================================ chat, phone, map
function sendChat(input) { const t = input.value.trim(); if (!t) return; S.conn.send({ t: 'chat', text: t }); input.value = ''; input.blur(); }

let ridN = 0;
/** Ask the game server for an app action and wait for the matching reply (matched by request id). */
const sendWait = (msg) => new Promise((resolve) => {
  const rid = `${Date.now().toString(36)}${++ridN}`;
  const timer = setTimeout(() => { G?.pending.delete(rid); resolve({ ok: false, message: 'The server took too long to answer.' }); }, 8000);
  G.pending.set(rid, (m) => { clearTimeout(timer); resolve(m); });
  S.conn.send({ t: 'app', rid, ...msg });
});

function openPhone(openApp, arg) {
  const c = gameClock(now());
  const ctx = { G: () => G, S, U, send: (m) => S.conn.send(m), ask: sendWait, fmt: U.fmt, openMap: () => openMap(), closePhone: () => U.closePanel(), openEstate: () => openEstateOverview(), openPlace: (poi) => { U.closePanel(); openPlaceSheet({ kind: 'poi', ...poi }); }, rideHelp: () => { U.closePanel(); if (!G.cityView) toggleCityView(); U.toast('info', 'Tap any floating place label, then choose bike, bus or taxi.'); }, furnish: () => { U.closePanel(); toggleFurnish(); }, openChat: null, onSummary: (fn) => { if (G) G.onSummary = fn; } };
  const phone = U.openPhone({ apps: phoneApps(ctx), hour: c.hour, cityName: `${G.city.name}, ${G.currency.countryName}`, onClose: () => { U.closePanel(); if (G) { G.onSummary = null; G.onNotify = null; G.phoneWait = null; } } });
  if (openApp) phoneApps(ctx).find((a) => a.id === openApp)?.open(phone, arg);
}

function openMap(preselect) {
  const geo = S.geo;
  const metroSize = (m) => geo.cities.filter((c) => c.metro === m).length;
  const st = { scope: metroSize(G.city.metro) > 1 ? `metro:${G.city.metro}` : G.city.country, sel: G.city.id, quotes: new Map(), armed: null };
  const placesHtml = (areaId) => {
    const list = geo.places?.[areaId] ?? []; if (!list.length) return '';
    const same = metroOfCity(areaId) === metroOfCity(G.city.id);
    return `<h4 style="margin:10px 0 6px">Places and businesses</h4><div class="list places">${list.map((p) => `<div class="li"><div><b>${p.emoji} ${U.esc(p.name)}</b><small>${p.type[0].toUpperCase() + p.type.slice(1)}${p.business ? ' · business' : ''}</small></div>${same ? `<button class="btn small ghost" data-walkplace="${areaId}|${p.id}">Go</button>` : ''}</div>`).join('')}</div>`;
  };
  const draw = () => {
    const here = G.city.id, sel = geo.cities.find((c) => c.id === st.sel);
    const country = geo.countries.find((k) => k.id === sel.country);
    const metros = [...new Set(geo.cities.map((c) => c.metro))].filter((m) => metroSize(m) > 1);
    const tabs = [...geo.countries.map((k) => ({ id: k.id, label: `${k.flag} ${k.name}` })), ...metros.map((m) => ({ id: `metro:${m}`, label: `🏙 ${geo.cities.find((c) => c.id === m)?.name ?? m} areas` })), { id: 'world', label: 'World' }];
    const here_ = geo.cities.find((c) => c.id === here);
    let side = '';
    if (sel.id === here) {
      const places = S.world.buildings.filter((b) => b.area === G.city.id && b.kind !== 'house').map((b) => { const z = S.world.zones.find((q) => q.building === b.id); return { b, z }; });
      side = `<div class="hd"><h3>${country.flag} ${U.esc(sel.name)} <span class="pill">You are here</span></h3><p>${U.esc(sel.blurb)}</p><p><span class="pill">${country.currency.symbol} ${U.esc(country.currency.name)}</span><span class="pill">Prices ×${sel.priceIndex}</span></p></div>
        <p><button class="btn small gold" data-estate="1">🏠 Homes &amp; land here</button></p>
        ${placesHtml(sel.id)}
        <div class="list">${places.filter(({ b }) => b.enterable !== false || b.sign).map(({ b, z }) => `<div class="li"><div><b>${U.esc(b.name)}</b><small>${z ? 'Walkable from here' : 'Coming soon'}</small></div>${z ? `<button class="btn small mint" data-walk="${z.id}">Walk there</button>` : ''}</div>`).join('')}</div>`;
    } else {
      const opts = st.quotes.get(sel.id);
      const cur = G.currency;
      side = `<div class="hd"><h3>${country.flag} ${U.esc(sel.name)}</h3><p>${U.esc(sel.blurb)}</p><p><span class="pill">${country.currency.symbol} ${U.esc(country.currency.name)}</span><span class="pill">Prices ×${sel.priceIndex}</span>${country.id !== here_.country ? '<span class="pill">International</span>' : ''}</p>${metroSize(sel.metro) > 1 && !st.scope.startsWith('metro:') ? `<p><button class="btn small ghost" data-metro="${sel.metro}">Explore ${metroSize(sel.metro)} areas of ${U.esc(geo.cities.find((c) => c.id === sel.metro).name)}</button></p>` : ''}</div>
        ${metroOfCity(sel.id) === metroOfCity(here) ? `<p><button class="btn mint" data-walkarea="${sel.id}">🚶 Walk there yourself (free)</button></p>` : ''}
        <div class="list">${!opts ? '<p style="color:var(--mut)">Checking routes…</p>' : opts.filter((o) => !(o.mode === 'walk' && metroOfCity(sel.id) === metroOfCity(here))).map((o) => `<button class="opt" data-mode="${o.mode}" ${o.available ? '' : 'disabled'}><span class="em">${o.icon}</span><span><b>${U.esc(o.name)}</b><small>${o.available ? `${o.km} km · about ${o.seconds}s` : U.esc(o.reason ?? 'Not available')}</small></span><span class="pr">${o.available ? (st.armed === o.mode ? 'Tap to pay ' : '') + o.fareText : ''}${o.available ? `<small style="display:block;color:var(--mut);font-weight:600">${U.mvc(o.fare)}</small>` : ''}</span></button>`).join('')}</div>
        ${placesHtml(sel.id)}
        <p style="color:var(--mut);font-size:12px">Fares are charged in your wallet (${cur.code}). Arriving in ${country.name} switches your wallet to ${country.currency.name} at the game's fixed rate.</p>`;
    }
    U.openPanel('Map', `<div class="tabs">${tabs.map((t) => `<button data-scope="${t.id}" class="${st.scope === t.id ? 'on' : ''}">${t.label}</button>`).join('')}</div>
      <div class="mapwrap"><div class="mapsvg" id="mapsvg">${U.renderMapSvg(geo, st.scope, here, st.sel)}</div><div class="sidepanel">${side}</div></div>`, (el) => {
      el.querySelectorAll('[data-scope]').forEach((b) => b.onclick = () => { st.scope = b.dataset.scope; draw(); });
      el.querySelectorAll('.city').forEach((g) => g.onclick = () => { st.sel = g.dataset.city; st.armed = null; draw(); if (st.sel !== here && !st.quotes.has(st.sel)) S.conn.send({ t: 'quote', to: st.sel }); });
      el.querySelectorAll('[data-metro]').forEach((b) => b.onclick = () => { st.scope = `metro:${b.dataset.metro}`; draw(); });
      el.querySelectorAll('[data-estate]').forEach((b) => b.onclick = () => { U.closePanel(); openEstateOverview(); });
      el.querySelectorAll('[data-walkplace]').forEach((b) => b.onclick = () => { const [a, id] = b.dataset.walkplace.split('|'); const pl = S.geo.places[a]?.find((q) => q.id === id); if (pl) openPlaceSheet({ kind: 'poi', id: pl.id, area: a, name: pl.name, emoji: pl.emoji, type: pl.type, business: pl.business, x: pl.x, z: pl.z, face: pl.face, sz: pl.sz }); });
      el.querySelectorAll('[data-walkarea]').forEach((b) => b.onclick = () => walkToArea(b.dataset.walkarea));
      el.querySelectorAll('[data-walk]').forEach((b) => b.onclick = () => walkTo(b.dataset.walk));
      el.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
        if (st.armed !== b.dataset.mode) { st.armed = b.dataset.mode; draw(); return; }  // second tap confirms and pays
        S.conn.send({ t: 'travel', to: st.sel, mode: b.dataset.mode });
      });
    }, { width: '980px' });
  };
  if (preselect && geo.cities.some((c) => c.id === preselect)) { st.sel = preselect; const pc = geo.cities.find((c) => c.id === preselect); st.scope = metroSize(pc.metro) > 1 ? `metro:${pc.metro}` : pc.country; }
  G.onQuote = (m) => { st.quotes.set(m.to, m.options); if (document.getElementById('mapsvg')) draw(); };
  draw();
  if (st.sel !== G.city.id) S.conn.send({ t: 'quote', to: st.sel });
}

// ============================================================================ frame loop
let last = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - last) / 1000); last = t;
  const clock = gameClock(now());

  if (G && S.mode === 'game') {
    const hasGate = (g) => G.access.has(g);
    const dir = G.cur ?? { dx: 0, dz: 0, run: false };
    if (G.ride && performance.now() > G.ride.until) G.ride = null;
    stepPlayer(G.me, dir, dt, S.colliders, hasGate, S.world.bounds, (G.ride?.mult ?? 1) * (G.summary.health?.slow ? G.w.slowMult ?? 0.6 : 1));
    G.me.av.group.position.set(G.me.x, 0, G.me.z);
    let dy = G.me.ry - G.me.av.group.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); G.me.av.group.rotation.y += dy * Math.min(1, dt * 14);
    G.me.av.update(dt, G.me.moving);
    const k = 1 - Math.exp(-dt * 11);
    for (const e of G.ents.values()) {
      e.x += (e.tx - e.x) * k; e.z += (e.tz - e.z) * k;
      let r = e.tr - e.ry; r = Math.atan2(Math.sin(r), Math.cos(r)); e.ry += r * k;
      e.av.group.position.set(e.x, 0, e.z); e.av.group.rotation.y = e.ry; e.av.update(dt, e.moving);
    }
    G.camT.lerp(new THREE.Vector3(G.me.x, 1.0, G.me.z), 1 - Math.exp(-dt * 9));
    const cp = Math.cos(G.pitch) * G.dist;
    camera.position.set(G.camT.x + Math.sin(G.yaw) * cp, G.camT.y + Math.sin(G.pitch) * G.dist, G.camT.z + Math.cos(G.yaw) * cp);
    camera.lookAt(G.camT);
    S.w3d.update(dt, clock.hour, G.me, (g) => G.access.has(g)); S.w3d.setCameraDistance(G.dist);
    applyInteriorView(S.w3d.focus());
    updateOverlay(clock);
  } else {
    S.orbit += dt * 0.05;
    camera.position.set(Math.sin(S.orbit) * 44, 20, Math.cos(S.orbit) * 36); camera.lookAt(0, 1, 0);
    if (S.w3d) S.w3d.update(dt, 15.2, { x: 0, z: 0 }, () => false);
  }
  renderer.render(scene, camera);
  fpsN++; if (performance.now() - fpsT > 1000) { fps = Math.round((fpsN * 1000) / (performance.now() - fpsT)); fpsN = 0; fpsT = performance.now(); }
}

/** Diagnostics for testers: open the browser console and type mvwStats(). */
let fpsN = 0, fpsT = performance.now(), fps = 0;
window.mvwStats = () => ({ fps, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures });
window.mvwLabels = () => S.w3d.labelList().map((l) => { const v = l.pos.clone().project(camera); return { name: l.name, x: Math.round((v.x * 0.5 + 0.5) * innerWidth), y: Math.round((-v.y * 0.5 + 0.5) * innerHeight), front: v.z < 1 }; });
const v3 = new THREE.Vector3(); let hudT = 0;
function project(x, y, z) { v3.set(x, y, z).project(camera); return v3.z > 1 ? null : { x: (v3.x * 0.5 + 0.5) * innerWidth, y: (-v3.y * 0.5 + 0.5) * innerHeight }; }
function placeTag(tag, x, z, show) {
  const p = show ? project(x, 2.25, z) : null;
  if (!p) { tag.style.display = 'none'; return; }
  tag.style.display = ''; tag.style.left = `${p.x}px`; tag.style.top = `${p.y}px`;
}
function updateOverlay(clock) {
  placeTag(G.me.tag, G.me.x, G.me.z, !G.traveling);
  let near = 1;
  for (const e of G.ents.values()) {
    const d = dist2(G.me.x, G.me.z, e.x, e.z);
    const fb = S.w3d.focus(), outside = fb && !(e.x > fb.minX && e.x < fb.maxX && e.z > fb.minZ && e.z < fb.maxZ);
    placeTag(e.tag, e.x, e.z, !outside && d < (e.npc ? 14 : 38));
    if (!e.npc && d <= 25) near++;
  }
  hudT += 1;
  if (hudT % 6 === 0) {
    U.setClock(clock.hour, clock.dayIndex, `${G.city.name} · ${G.online} online`); U.setSayPlaceholder(near);
    const inside = S.world.buildings.find((b) => b.enterable && inBuilding(b, G.me.x, G.me.z));
    const z = zoneNear();
    const dn = S.world.districts.find((d) => d.id === G.city.id); U.setPlace(inside ? inside.name : (dn?.names.apt ?? '').replace(/ (Apartments|Flats|Residences|Court)$/, '') || G.city.name, inside ? `Inside · ${G.city.name}` : z ? z.label : `${G.city.name}, ${G.currency.countryName}`);
    renderCtx();
  }
}

boot();
window.mvw = { S, get G() { return G; }, scene, camera };


// ============================================================================ city view
function toggleCityView() {
  if (G.cityView) { G.dist = G.cityView.dist; G.pitch = G.cityView.pitch; G.cityView = null; return; }
  G.cityView = { dist: G.dist, pitch: G.pitch }; G.dist = 120; G.pitch = 0.95;
}

// ============================================================================ estate (homes, apartments, land)
const PIC = { room: ['🛏️', '#5b7fb5'], apartment: ['🏢', '#6a7fd1'], house: ['🏡', '#d98a4a'], land: ['🌱', '#6aa65a'] };
const periodWord = (h) => (h % 168 === 0 ? (h === 168 ? 'week' : `${h / 168} weeks`) : h % 24 === 0 ? (h === 24 ? 'day' : `${h / 24} days`) : `${h}h`);
/** Listings for every area of this city (the world shows signs on all of them). G.estate = the area you are standing in. */
async function loadEstate() {
  if (!G) return null;
  const r = await sendWait({ app: 'estate', a: 'metro', d: {} });
  if (!r.ok || !G) return G?.estate ?? null;
  G.estateAll = r.data;
  const here = r.data.areas[G.city.id] ?? Object.values(r.data.areas)[0];
  G.estate = { ...here, portfolio: r.data.portfolio, limits: r.data.limits };
  paintLots(); return G.estate;
}
function paintLots() {
  const st = {}; const fmt = U.fmt; const per = periodWord(G.estateAll.rentPeriodHours);
  for (const [area, E] of Object.entries(G.estateAll.areas)) for (const lot of E.lots) {
    const L = lot.listings, id = `${area}:${lot.lotId}`; const mine = L.find((l) => l.state.startsWith('yours'));
    if (lot.lotId === 'apt') {
      const free = L.filter((l) => l.state === 'available'); const cheapest = Math.min(...free.map((l) => l.rent ?? Infinity), lot.rooms?.cheapestRent ?? Infinity);
      st[id] = { lines: ['APARTMENTS', free.length || lot.rooms?.available ? `from ${fmt(cheapest)} / ${per}` : 'all taken'], tone: mine ? 'yours' : (free.length || lot.rooms?.available) ? 'free' : 'taken' };
      continue;
    }
    const l = L[0]; if (!l) continue;
    const isHome = l.type === 'house';
    if (l.state === 'available') st[id] = { lines: [isHome ? 'HOUSE' : 'LAND FOR SALE', `${fmt(l.price)}${l.rent ? ` · rent ${fmt(l.rent)}` : ''}`], tone: 'free' };
    else if (l.state === 'yours_owned') st[id] = { lines: [isHome ? 'YOUR HOME' : 'YOUR LAND', 'tap to manage'], tone: 'yours' };
    else if (l.state === 'yours_renting') st[id] = { lines: ['YOU RENT HERE', 'tap to manage'], tone: 'yours' };
    else st[id] = { lines: [isHome ? 'HOUSE · TAKEN' : 'LAND · SOLD'], tone: 'taken' };
  }
  S.w3d?.setLotStates(st);
}
const pctText = (x) => `${x >= 0 ? '▲' : '▼'} ${Math.abs(x * 100).toFixed(1)}%`;
function spark(points, w = 120, h = 28) {
  if (!points?.length) return '';
  const lo = Math.min(...points), hi = Math.max(...points, lo + 0.001);
  const pts = points.map((v, i) => `${((i / Math.max(1, points.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - lo) / (hi - lo)) * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline fill="none" stroke="#7be0b4" stroke-width="2" points="${pts}"/></svg>`;
}
function valueStrip(a, name) {
  if (!a) return '';
  return `<div class="vstrip"><div><small>${U.esc(name ?? 'Area')} value index</small><b>${a.idx.toFixed(2)}</b></div><div><small>This week</small><b class="${a.change7d >= 0 ? 'pos' : 'neg'}">${pctText(a.change7d)}</b></div><div><small>Residents</small><b>${Math.round(a.residents)}</b><small>${a.players} players</small></div>${spark(a.spark)}</div><p class="hint" style="margin:6px 0 8px">Prices and rents follow this index. 1.00 = launch prices. It rises as more people move in.</p>`;
}
function estateCard(l, armed) {
  const f = U.fmt, [em, col] = PIC[l.type] ?? PIC.room, per = periodWord(G.estateAll.rentPeriodHours);
  const arm = (k, label, price) => `<button class="btn small ${armed === `${k}:${l.propertyId}` ? 'gold' : 'mint'}" data-act="${k}" data-id="${l.propertyId}">${armed === `${k}:${l.propertyId}` ? `Confirm ${label} ${f(price)}` : `${label} ${f(price)}${k === 'rent' ? ` / ${per}` : ''}`}</button>`;
  let btns = '';
  if (l.state === 'available') btns = [l.rent ? arm('rent', 'Rent', l.rent) : '', l.price ? arm('buy', 'Buy', l.price) : ''].join('');
  else if (l.state === 'yours_renting') btns = `<span class="pill">You rent this</span><button class="btn small ghost" data-act="leave" data-id="${l.propertyId}">Move out</button>`;
  else if (l.state === 'yours_owned') btns = `<span class="pill">You own this</span>${l.type === 'land' ? (l.buildCost ? arm('build', 'Build a home', l.buildCost) : '') : l.livingHere ? '<span class="pill">You live here</span>' : '<button class="btn small mint" data-act="movein" data-id="' + l.propertyId + '">Move in</button>'}${l.livingHere ? `<button class="btn small ghost" data-act="leave" data-id="${l.propertyId}">Move out</button>` : ''}${l.sellBack ? arm('sell', 'Sell for', l.sellBack) : ''}`;
  else btns = '<span class="pill">Taken</span>';
  return `<div class="prop"><div class="pic" style="background:linear-gradient(150deg,${col},#16313a)">${em}</div><div class="pbody"><b>${U.esc(l.name)}</b><small>${l.beds ? `${l.beds} bed · ` : ''}${l.sizeSqm} sqm · ${l.type === 'land' ? 'Land' : l.type[0].toUpperCase() + l.type.slice(1)}</small><p>${U.esc(l.blurb)}</p>${l.boughtFor ? `<p class="pl">You paid ${f(l.boughtFor)} · worth ${f(l.sellBack)} after fees · <b class="${l.sellBack >= l.boughtFor ? 'pos' : 'neg'}">${l.sellBack >= l.boughtFor ? '+' : ''}${f(l.sellBack - l.boughtFor)}</b></p>` : ''}<div class="pbtns">${btns}</div></div></div>`;
}
const ESTATE_OK = {
  buy: (r) => (r.movedIn ? `You bought ${r.name} and moved in!` : `You bought ${r.name}.`), rent: () => 'Rented. You have moved in!', build: (r) => (r.movedIn ? 'Your new home is built and you have moved in!' : 'Your new home is built.'),
  sell: (r) => `Sold. You received ${U.fmt(r.received)}.`, leave: (r) => (r.kept ? 'You moved out. You still own it.' : 'You moved out.'), movein: () => 'Moved in!',
};
async function estateAct(act, id, done) {
  const r = await sendWait({ app: 'estate', a: act, d: act === 'leave' ? {} : act === 'movein' ? { id } : { id, key: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` } });
  if (!r.ok) { U.toast('error', r.message ?? 'That did not work.'); return; }
  U.toast('ok', ESTATE_OK[act](r.data));
  await loadEstate(); done(r.data);
}
/** lotId is "area:lot", e.g. "ikeja:house_a" (the id of the lot in the world). */
function openEstateSheet(lotId) {
  if (!G?.estateAll) { loadEstate().then(() => G?.estateAll && openEstateSheet(lotId)); return; }
  const [area, short] = lotId.split(':');
  const st = { armed: null };
  const lot = () => G.estateAll.areas[area]?.lots.find((l) => l.lotId === short);
  const areaName = S.geo.cities.find((c) => c.id === area)?.name ?? area;
  const draw = () => {
    const lo = lot(); if (!lo) return U.closePanel();
    const names = S.world.districts.find((d) => d.id === area)?.names ?? {};
    const title = short === 'apt' ? `${U.esc(names.apt ?? 'Apartments')}` : lo.listings[0].type === 'land' ? `Plot of land · ${U.esc(areaName)}` : U.esc(lo.listings[0].name);
    const rooms = lo.rooms ? `<p class="hint" style="margin:0 0 8px">${lo.rooms.available} of ${lo.rooms.total} rooms free${lo.rooms.cheapestRent ? ` · rooms from ${U.fmt(lo.rooms.cheapestRent)} / ${periodWord(G.estateAll.rentPeriodHours)}` : ''}. Showing the first free ones.</p>` : '';
    U.openPanel(title, `${valueStrip(G.estateAll.areas[area].area, areaName)}${rooms}<div class="props">${lo.listings.map((l) => estateCard(l, st.armed)).join('')}</div><p class="hint">Prices are in ${U.esc(G.currency.name)}. Renting is charged every ${periodWord(G.estateAll.rentPeriodHours)}; owners pay no rent. Property values follow how many people live in the area: buy early, sell later for a profit (or a loss if people leave). Selling costs ${G.estateAll.limits.sellFeePercent}%. You can live in one home at a time.</p>`, (el) => {
      el.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => {
        const { act, id } = b.dataset; const k = `${act}:${id}`;
        if (['rent', 'buy', 'build', 'sell'].includes(act) && st.armed !== k) { st.armed = k; draw(); return; }   // second tap confirms
        st.armed = null; estateAct(act, id, (data) => { if (data.movedIn || act === 'rent') U.closePanel(); else draw(); });
      });
    }, { width: '780px' });
  };
  draw();
}
async function openEstateOverview() {
  await loadEstate(); const ov = await sendWait({ app: 'estate', a: 'overview', d: {} });
  const est = G.estate; if (!est || !ov.ok) return;
  const geo = S.geo; const here = G.city; const cityCur = (id) => geo.countries.find((k) => k.id === geo.cities.find((c) => c.id === id).country).currency;
  const names = S.world.districts.find((d) => d.id === here.id)?.names ?? {};
  const lotName = (lo) => (lo.lotId === 'apt' ? names.apt ?? 'Apartments' : lo.listings[0].type === 'land' ? `Plot ${lo.lotId.slice(-1).toUpperCase()}` : lo.listings[0].name);
  const here_ = est.lots.map((lo) => { const l = lo.listings[0]; const free = lo.listings.some((x) => x.state === 'available') || lo.rooms?.available; return `<button class="li" data-lot="${here.id}:${lo.lotId}" style="width:100%;text-align:left"><div><b>${U.esc(lotName(lo))}</b><small>${lo.lotId === 'apt' ? `${lo.rooms.available} rooms and ${lo.listings.filter((x) => x.type === 'apartment').length} apartments` : `${l.type === 'land' ? l.sizeSqm + ' sqm land' : l.beds + ' bed house'}`}</small></div><span class="pill ${free ? '' : 'dim'}">${lo.listings.some((x) => x.state.startsWith('yours')) ? 'Yours' : free ? 'Available' : 'Taken'}</span></button>`; }).join('');
  const byMetro = new Map();
  for (const a of ov.data.areas) { const c = geo.cities.find((x) => x.id === a.cityId); if (!c) continue; const m = c.metro; if (!byMetro.has(m)) byMetro.set(m, []); byMetro.get(m).push({ c, a }); }
  const sameMetro = (id) => metroOfCity(id) === metroOfCity(here.id);
  const rows = [...byMetro.entries()].map(([m, list]) => { const hub = geo.cities.find((c) => c.id === m); return `<div class="metro"><h4>${U.esc(hub.name)}${list.length > 1 ? ' areas' : ''}</h4>${list.sort((x, y) => x.c.priceIndex - y.c.priceIndex).map(({ c, a }) => { const cur = cityCur(c.id); const v = a.value; return `<div class="li"><div><b>${U.esc(c.name)}${c.id === here.id ? ' <span class="pill">you are here</span>' : ''}${v ? ` <span class="pill ${v.change7d >= 0 ? 'up' : 'down'}">${pctText(v.change7d)} 7d · idx ${v.idx.toFixed(2)}</span>` : ''}</b><small>${a.cheapestRoom != null ? `Rooms from ${U.fmt(a.cheapestRoom, cur)}` : 'No rooms free'} · ${a.cheapestHome != null ? `homes from ${U.fmt(a.cheapestHome, cur)}` : 'no homes free'} · ${a.cheapestLand != null ? `land from ${U.fmt(a.cheapestLand, cur)}` : 'no land free'}</small></div>${c.id === here.id ? '' : sameMetro(c.id) ? `<button class="btn small mint" data-walk="${c.id}">Walk</button>` : `<button class="btn small ghost" data-go="${c.id}">Map</button>`}</div>`; }).join('')}</div>`; }).join('');
  const pf = est.portfolio;
  const pfHtml = pf.items.length ? `<h3 style="margin:0 0 6px">My properties</h3><div class="list">${pf.items.map((i) => `<div class="li"><div><b>${U.esc(i.name)}</b><small>Paid ${U.fmt(i.paid)} · worth ${U.fmt(i.sellNet)} after fees${i.cityId === here.id || sameMetro(i.cityId) ? '' : ` · in ${U.esc(i.cityName)}: travel there to sell`}</small></div><b class="${i.profit >= 0 ? 'pos' : 'neg'}">${i.profit >= 0 ? '+' : ''}${U.fmt(i.profit)} (${(i.profitPct * 100).toFixed(1)}%)</b></div>`).join('')}<div class="li"><b>Total profit if sold today</b><b class="${pf.profit >= 0 ? 'pos' : 'neg'}">${pf.profit >= 0 ? '+' : ''}${U.fmt(pf.profit)}</b></div></div><div style="height:12px"></div>` : '';
  U.openPanel('Homes & land', `${pfHtml}${valueStrip(est.area, here.name)}<h3 style="margin:0 0 6px">In ${U.esc(here.name)} <small style="opacity:.7">(tap one, or tap a building or plot in the world)</small></h3><div class="list">${here_}</div><h3 style="margin:16px 0 6px">Other areas and cities</h3><p class="hint" style="margin:0 0 6px">Walk to another area of this city, or use the Map to travel to another city. Prices are in that country's currency and follow the area's value index: buy where people are moving in, early, and sell when the index has risen.</p>${rows}`, (el) => {
    el.querySelectorAll('[data-lot]').forEach((b) => b.onclick = () => openEstateSheet(b.dataset.lot));
    el.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => { U.closePanel(); openMap(b.dataset.go); });
    el.querySelectorAll('[data-walk]').forEach((b) => b.onclick = () => walkToArea(b.dataset.walk));
  }, { width: '820px' });
}

// ============================================================================ furnishing
const furnDef = (itemId) => G.catalog.get(itemId);
const quarter = (yaw) => Math.abs(Math.round(Math.sin(yaw))) === 1;
const foot = (def, yaw) => (quarter(yaw) ? { w: def.sz, d: def.sx } : { w: def.sx, d: def.sz });
function furnValid(def, x, z, yaw) {
  const { rect: r, doorKeepOut: k } = G.furn.info, f = foot(def, yaw);
  if (x - f.w / 2 < r.minX || x + f.w / 2 > r.maxX || z - f.d / 2 < r.minZ || z + f.d / 2 > r.maxZ) return false;
  if (def.h > 0.1) {
    if (x + f.w / 2 > k.minX && x - f.w / 2 < k.maxX && z + f.d / 2 > k.minZ && z - f.d / 2 < k.maxZ) return false;
    for (const p of G.summary.furniture) { const od = furnDef(p.itemId); if (!od || od.h <= 0.1) continue; const of = foot(od, p.yaw); if (Math.abs(x - p.x) < (f.w + of.w) / 2 - 0.02 && Math.abs(z - p.z) < (f.d + of.d) / 2 - 0.02) return false; }
  }
  return G.summary.furniture.length < G.furn.info.home.slots;
}
// Inside a business or home you only see its interior: everything outside the footprint is clipped away until you walk out.
const clipPlanes = [0, 1, 2, 3].map(() => new THREE.Plane());
let interiorOn = false;
function applyInteriorView(f) {
  if (!f) { if (interiorOn) { renderer.clippingPlanes = []; interiorOn = false; } return; }
  clipPlanes[0].set(new THREE.Vector3(1, 0, 0), -f.minX); clipPlanes[1].set(new THREE.Vector3(-1, 0, 0), f.maxX);
  clipPlanes[2].set(new THREE.Vector3(0, 0, 1), -f.minZ); clipPlanes[3].set(new THREE.Vector3(0, 0, -1), f.maxZ);
  renderer.clippingPlanes = clipPlanes; interiorOn = true;
}
function syncFurniture() {
  if (!G || !S.w3d) return;
  const t = G.summary.tenancy;
  // the home is in this metro world when its area is one of the world's districts (G.city may still be unset right after joining)
  const here = !!t && !!G.w?.world?.districts?.some((d) => d.id === t.district);
  S.w3d.setFurniture(here ? G.summary.furniture : [], G.catalog);
  if (G.furn) { if (!here) endFurnish(); else drawFurnBar(); }
}
async function toggleFurnish() {
  if (G.furn) return endFurnish();
  const t = G.summary.tenancy;
  if (!t) return U.toast('info', 'You do not have a home yet. Tap a house or open the Homes app.');
  if (t.district !== G.city.id) return U.toast('info', 'Your home is in another city. Open the Map to travel there.');
  const r = await sendWait({ app: 'home', a: 'info', d: {} }); if (!r.ok) return U.toast('error', r.message);
  const R = r.data.rect; if (!R) return U.toast('info', 'This home cannot be furnished.');
  if (!(G.me.x > R.minX - 0.6 && G.me.x < R.maxX + 0.6 && G.me.z > R.minZ - 0.6 && G.me.z < R.maxZ + 0.6)) return U.toast('info', 'Walk inside your home first, then tap Furnish.');
  G.furn = { info: r.data, sel: null, yaw: 0, picked: null, last: null, cam: { pitch: G.pitch, dist: G.dist } };
  G.pitch = 1.25; G.dist = 11;            // look almost straight down so walls and other buildings do not hide the room
  S.w3d.showBanners(false);
  drawFurnBar();
}
function endFurnish() { S.w3d?.setGhost(null); S.w3d?.showBanners(true); if (G.furn?.cam) { G.pitch = G.furn.cam.pitch; G.dist = G.furn.cam.dist; } G.furn = null; document.getElementById('furnbar')?.remove(); }
function drawFurnBar() {
  let bar = document.getElementById('furnbar'); if (!bar) { bar = document.createElement('div'); bar.id = 'furnbar'; document.getElementById('ui').append(bar); }
  const owned = G.summary.inventory.filter((i) => G.catalog.has(i.itemId));
  const sel = G.furn.sel && owned.find((i) => i.itemId === G.furn.sel) ? G.furn.sel : null; if (!sel) { G.furn.sel = null; S.w3d.setGhost(null); }
  const pk = G.furn.picked && G.summary.furniture.find((f) => f.furnitureId === G.furn.picked);
  bar.innerHTML = `<div class="fhead"><b>Furnish</b><small>${G.summary.furniture.length}/${G.furn.info.home.slots} pieces</small><span class="grow"></span><button class="btn small ghost" id="fRot">Rotate [R]</button><button class="btn small ghost" id="fStore">Home Store</button><button class="btn small mint" id="fDone">Done</button></div>
    <div class="fhint">${pk ? `<b>${U.esc(furnDef(pk.itemId).name)}</b> selected <button class="btn small danger" id="fPick">Pick up</button> <button class="btn small ghost" id="fCancel">Cancel</button>` : sel ? `Tap the floor to place <b>${U.esc(furnDef(sel).name)}</b>. Green = fits, red = blocked.` : owned.length ? 'Choose a piece, then tap the floor. Tap placed furniture to pick it up.' : 'Your backpack has no furniture. Buy some in the Home Store (phone &gt; Home Store).'}</div>
    <div class="fitems">${owned.map((i) => `<button class="chip ${sel === i.itemId ? 'on' : ''}" data-f="${i.itemId}">${U.esc(furnDef(i.itemId).name)} ×${i.quantity}</button>`).join('')}</div>`;
  bar.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { G.furn.sel = b.dataset.f; G.furn.picked = null; drawFurnBar(); });
  bar.querySelector('#fRot').onclick = rotateFurn; bar.querySelector('#fDone').onclick = endFurnish;
  bar.querySelector('#fStore').onclick = () => openPhone('store');
  bar.querySelector('#fPick')?.addEventListener('click', async () => { const id = G.furn.picked; G.furn.picked = null; const r = await sendWait({ app: 'home', a: 'pickup', d: { id } }); if (!r.ok) U.toast('error', r.message); });
  bar.querySelector('#fCancel')?.addEventListener('click', () => { G.furn.picked = null; drawFurnBar(); });
}
function rotateFurn() { if (!G?.furn) return; G.furn.yaw = (G.furn.yaw + Math.PI / 2) % (Math.PI * 2); if (G.furn.last) furnGhost(G.furn.last.x, G.furn.last.z); }
const snap = (v) => Math.round(v * 4) / 4;
function furnGhost(x, z) {
  const sel = G.furn.sel; if (!sel) return S.w3d.setGhost(null);
  const def = furnDef(sel); G.furn.last = { x, z };
  S.w3d.setGhost(def, x, z, G.furn.yaw, furnValid(def, x, z, G.furn.yaw));
}
canvas.addEventListener('pointermove', (e) => {
  if (!G?.furn?.sel || e.buttons) return;
  const r = canvas.getBoundingClientRect(), p = S.w3d.floorPoint(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1), camera);
  if (p) furnGhost(snap(p.x), snap(p.z));
});
async function onFurnTap(e, r) {
  const nx = ((e.clientX - r.left) / r.width) * 2 - 1, ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
  if (G.furn.sel) {
    const p = S.w3d.floorPoint(nx, ny, camera); if (!p) return;
    const x = snap(p.x), z = snap(p.z), def = furnDef(G.furn.sel);
    if (!furnValid(def, x, z, G.furn.yaw)) { furnGhost(x, z); return U.toast('error', 'That does not fit there.'); }
    const res = await sendWait({ app: 'home', a: 'place', d: { itemId: G.furn.sel, x, z, yaw: G.furn.yaw } });
    if (!res.ok) U.toast('error', res.message ?? 'Could not place that.');
  } else {
    const fid = S.w3d.pickFurniture(nx, ny, camera);
    G.furn.picked = fid; drawFurnBar();
  }
}


// ============================================================================ place sheet: tap a floating label, choose how to get there
const TYPE_BLURB = {
  hospital: 'A public hospital. Treatment is not part of the game yet.', clinic: 'A neighbourhood clinic. Not open for visits yet.', police: 'The local police station.', church: 'A place of worship.', mosque: 'A place of worship.',
  school: 'A local school.', university: 'A university campus.', stadium: 'The city stadium. Matches are not simulated yet.', park: 'Open green space. Walk right in.', beach: 'An open beach. Walk right in.', golf: 'A golf course. Walk right in.',
  hotel: 'A hotel. Rooms to visit are not in the game yet.', cinema: 'A cinema. Films are not in the game yet.', library: 'The city library.', bank: 'A bank branch. Use the Vault app on your phone for banking.', gym: 'A gym. Training is not in the game yet.',
  salon: 'A hair salon. Not open for visits yet.', garage: 'A car garage.', office: 'An office tower.', studio: 'A radio studio.', dock: 'A harbour and boat dock.', museum: 'A museum.', gov: 'A government building.', tech: 'A technology hub.',
};
function localQuoteClient(m) {
  const t = G.local, d = Math.round(m);
  const out = [{ mode: 'walk', name: t.walk.name, icon: t.walk.icon, fare: 0, seconds: Math.round(d / t.walk.metersPerSecond), ok: true }];
  out.push({ mode: 'bike', name: t.bike.name, icon: t.bike.icon, fare: t.bike.fee, seconds: Math.round(d / (t.walk.metersPerSecond * t.bike.speedMult)), ok: d >= t.bike.minMeters, why: 'Too close: just walk' });
  for (const k of ['bus', 'car']) { const x = t[k]; out.push({ mode: k, name: x.name, icon: x.icon, fare: Math.max(1, Math.round(x.base + x.perMeter * d)), seconds: Math.round(Math.min(x.maxSeconds, Math.max(x.minSeconds, d * x.secPerMeter))), ok: d >= x.minMeters, why: 'Too close: just walk' }); }
  return out;
}
const fmtSecs = (s) => (s < 90 ? `about ${s}s` : `about ${Math.round(s / 60)} min`);
/** place = {kind:'poi'|'building', name, emoji, area, x, z, face?, sz?, cx?, cz?, type?, business?} (the object a floating label carries) */
function openPlaceSheet(place) {
  let tx, tz;
  if (place.kind === 'poi') { tx = place.x; tz = place.z + (place.face === '+z' ? 1 : -1) * (place.sz / 2 + 1.6); }
  else { const rz = rowRoad(place.cz); tx = place.cx; tz = place.cz + (rz > place.cz ? 1 : -1) * (place.sz / 2 + 1.6); }
  // Walking and cycling go right inside to the counter of a public building; a bus or taxi drops you at its door.
  const bld = place.kind === 'poi' ? S.world.buildings.find((b) => b.id === place.id && b.enterable) : S.world.buildings.find((b) => b.id === place.id && b.enterable);
  const inner = bld ? S.world.zones.find((z) => z.building === bld.id && (z.kind === 'shop' || z.kind === 'service')) : null;
  const meters = Math.hypot(G.me.x - tx, G.me.z - tz);
  const areaName = S.geo.cities.find((c) => c.id === place.area)?.name ?? '';
  const zone = S.world.zones.find((z) => (z.poi && z.poi === place.id) || (place.kind === 'building' && z.building === place.id && z.kind !== 'door'));
  const sells = zone?.kind === 'shop' && zone.items ? `<p><b>Sells:</b> ${zone.items.map((i) => U.esc(i.label)).join(', ')}. Walk up to the door to buy.</p>` : '';
  const type = place.kind === 'poi' ? place.type : place.id.split(':')[1];
  const blurb = place.kind === 'building' && place.sign ? 'Coming soon.' : sells ? '' : TYPE_BLURB[type] ?? '';
  const inside = bld ? '<p>Open to the public: walk in. Staff and customers are going about their day.</p>' : '';
  const home = place.kind === 'building' && place.id.endsWith(':apt');
  const opts = localQuoteClient(meters);
  const row = (o) => `<button class="opt" data-go="${o.mode}" ${o.ok && G.summary.balance >= o.fare ? '' : 'disabled'}><span class="em">${o.icon}</span><span><b>${U.esc(o.name)}</b><small>${o.ok ? fmtSecs(o.seconds) : o.why}${o.mode === 'bike' ? ' · faster than walking, for a few minutes' : ''}</small></span><span class="pr">${o.fare ? U.fmt(o.fare) : 'Free'}${o.ok && G.summary.balance < o.fare ? '<small style="display:block;color:var(--mut)">Not enough money</small>' : ''}</span></button>`;
  U.openPanel(`${place.emoji} ${U.esc(place.name)}`, `<div class="hd"><p style="margin:0">${U.esc(areaName)} · ${Math.round(meters)} m from you${place.business ? ' · business' : ''}</p>${blurb ? `<p>${U.esc(blurb)}</p>` : ''}${sells}${inside}</div>
    <h4 style="margin:12px 0 6px">How do you want to get there?</h4><div class="list">${opts.map(row).join('')}</div>
    ${home ? '<p style="margin-top:10px"><button class="btn small gold" id="plHomes">🏠 Rooms and apartments here</button></p>' : ''}
    <p class="hint" style="margin-top:8px">Bus and taxi take you to the door. Walking and cycling follow the streets; press any movement key to take over.</p>`, (el) => {
    el.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => {
      const m = b.dataset.go;
      const go = () => (inner ? routeTo(inner.x, inner.z, bld) : routeTo(tx, tz));
      if (m === 'walk') { go(); U.toast('info', `Walking to ${place.name}…`); }
      else if (m === 'bike') { S.conn.send({ t: 'ride', on: true }); go(); }
      else { S.conn.send({ t: 'transit', mode: m, x: tx, z: tz, name: place.name }); U.closePanel(); }
    });
    el.querySelector('#plHomes')?.addEventListener('click', () => openEstateSheet(`${place.area}:apt`));
  }, { width: '520px' });
}

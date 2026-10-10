// All the screens and HUD pieces. Pure DOM; main.js feeds it data and handles the actions.
import * as THREE from 'three';
import { createAvatar, SKIN, HAIR, OUTFIT, BODY, EMOTE_ICON } from './avatar.js';

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const mvc = (n) => Number(n ?? 0).toLocaleString('en-US');
const root = () => $('#ui');
export const clear = () => { root().innerHTML = ''; };

export function toast(kind, text, ms = 3600) {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = text;
  $('#toasts').append(el); setTimeout(() => el.remove(), ms);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

// ------------------------------------------------------------------ sign in / characters / creator
export function showAuth({ onSubmit }) {
  clear();
  root().innerHTML = `
  <div class="screen"><form class="card" id="authForm" autocomplete="on">
    <div class="logo"><b>🌆</b><div><h1 style="margin:0">My Virtual World</h1></div></div>
    <p class="sub">A shared city where you build your own life. Closed alpha.</p>
    <div class="tabs"><button type="button" class="on" data-m="login">Sign in</button><button type="button" data-m="register">Create account</button></div>
    <label>Email</label><input type="email" id="em" autocomplete="username" required>
    <label>Password <span id="pwhint" class="hidden">(at least 10 characters)</span></label><input type="password" id="pw" autocomplete="current-password" required>
    <div class="err" id="err"></div>
    <div class="row end" style="margin-top:6px"><button class="btn green" id="go">Sign in</button></div>
  </form></div>`;
  let mode = 'login';
  root().querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
    mode = b.dataset.m; root().querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('#go').textContent = mode === 'login' ? 'Sign in' : 'Create account'; $('#pwhint').classList.toggle('hidden', mode === 'login');
    $('#pw').autocomplete = mode === 'login' ? 'current-password' : 'new-password'; $('#err').textContent = '';
  });
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault(); $('#go').disabled = true; $('#err').textContent = '';
    try { await onSubmit(mode, $('#em').value.trim(), $('#pw').value); } catch (err) { $('#err').textContent = err.message; $('#go').disabled = false; }
  };
}

export function showCharacters(chars, { onPlay, onNew, onLogout }) {
  clear();
  root().innerHTML = `<div class="screen"><div class="card"><h1>Who's playing?</h1><p class="sub">Pick a character or make a new one.</p>
    <div class="charlist">${chars.map((c, i) => `<button class="char" data-i="${i}"><span class="av" style="background:${SKIN[c.appearance.skinTone] ?? '#c98a5e'}">${esc(c.displayName[0].toUpperCase())}</span><span><b>${esc(c.displayName)}</b><br><small style="color:var(--mut)">Tap to enter New Meridian</small></span></button>`).join('')}</div>
    <div class="row"><button class="btn" id="new">＋ New character</button><span style="flex:1"></span><button class="btn ghost small" id="out">Sign out</button></div></div></div>`;
  root().querySelectorAll('.char').forEach((b) => b.onclick = () => onPlay(chars[+b.dataset.i]));
  $('#new').onclick = onNew; $('#out').onclick = onLogout;
}

const HAIRSTYLES = ['short', 'long', 'curly', 'braids', 'buzz', 'bun'];
export function showCreator({ onSubmit, onBack, canGoBack }) {
  clear();
  const f = { name: '', skinTone: 2, hairstyle: 'short', hairColor: 'brown', outfit: 'casual_1', bodyPreset: 'body_a' };
  root().innerHTML = `<div class="screen"><div class="card" style="width:min(640px,100%)"><h1>Create your character</h1><p class="sub">You can change your look in the shop later.</p>
    <div class="creator"><div class="preview"><canvas id="pv"></canvas></div><div>
      <label>Display name</label><input type="text" id="nm" maxlength="20" placeholder="3-20 letters or numbers" autocomplete="off">
      <label>Skin</label><div class="swatches" id="skin"></div>
      <label>Hair style</label><div class="swatches" id="hs"></div>
      <label>Hair colour</label><div class="swatches" id="hc"></div>
      <label>Outfit</label><div class="swatches" id="of"></div>
      <label>Build</label><div class="swatches" id="bd"></div>
    </div></div><div class="err" id="err"></div>
    <div class="row end">${canGoBack ? '<button class="btn ghost" id="back">Back</button>' : ''}<button class="btn green" id="ok">Enter the city</button></div></div></div>`;
  const preview = makePreview($('#pv'));
  const sync = () => preview.set({ skinTone: f.skinTone, hairstyle: f.hairstyle, hairColor: f.hairColor, outfit: f.outfit, bodyPreset: f.bodyPreset });
  const fill = (id, items, key, render) => {
    const el = $(id); el.innerHTML = '';
    items.forEach((v) => { const b = document.createElement('button'); b.type = 'button'; b.innerHTML = render(v); b.firstChild.classList.toggle('on', f[key] === v);
      b.onclick = () => { f[key] = v; el.querySelectorAll('.sw,.chip').forEach((x) => x.classList.remove('on')); b.firstChild.classList.add('on'); sync(); }; el.append(b); });
  };
  fill('#skin', SKIN.map((_, i) => i), 'skinTone', (i) => `<i class="sw" style="display:block;background:${SKIN[i]}"></i>`);
  fill('#hs', HAIRSTYLES, 'hairstyle', (v) => `<i class="chip" style="display:block">${v}</i>`);
  fill('#hc', Object.keys(HAIR), 'hairColor', (v) => `<i class="sw" style="display:block;background:${HAIR[v]}"></i>`);
  fill('#of', Object.keys(OUTFIT), 'outfit', (v) => `<i class="sw" style="display:block;background:linear-gradient(135deg,${OUTFIT[v].top} 50%,${OUTFIT[v].bottom} 50%)"></i>`);
  fill('#bd', Object.keys(BODY), 'bodyPreset', (v) => `<i class="chip" style="display:block">${v.replace('body_', 'Type ').toUpperCase().replace('TYPE ', 'Type ')}</i>`);
  sync();
  $('#nm').oninput = (e) => { f.name = e.target.value; };
  if (canGoBack) $('#back').onclick = () => { preview.dispose(); onBack(); };
  $('#ok').onclick = async () => {
    $('#ok').disabled = true; $('#err').textContent = '';
    try { await onSubmit(f.name.trim(), { bodyPreset: f.bodyPreset, skinTone: f.skinTone, hairstyle: f.hairstyle, hairColor: f.hairColor, outfit: f.outfit }); preview.dispose(); }
    catch (e) { $('#err').textContent = e.message; $('#ok').disabled = false; }
  };
}

function makePreview(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  const sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight('#ffffff', '#8aa068', 1.5));
  const d = new THREE.DirectionalLight('#fff4dc', 2); d.position.set(2, 4, 3); sc.add(d);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 50); cam.position.set(0, 1.1, 5.2); cam.lookAt(0, 0.95, 0);
  let av = null, raf = 0, dead = false, t = 0;
  const loop = () => {
    if (dead) return; raf = requestAnimationFrame(loop);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.floor(w * r.getPixelRatio())) { r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    t += 0.016; if (av) { av.group.rotation.y = Math.sin(t * 0.8) * 0.6; av.update(0.016, false); }
    r.render(sc, cam);
  };
  loop();
  return {
    set(a) { if (av) { sc.remove(av.group); av.dispose(); } av = createAvatar(a); sc.add(av.group); },
    dispose() { dead = true; cancelAnimationFrame(raf); r.dispose(); r.forceContextLoss?.(); },
  };
}

// ------------------------------------------------------------------ in-game HUD
export function buildHud(h) {
  clear();
  root().innerHTML = `
  <div class="top" id="top">
    <div class="seg"><span id="clockIc">☀️</span><span id="clock">--</span></div>
    <div class="seg hide-s"><span class="dot" id="onDot"></span><span id="online">1 online</span></div>
    <div class="seg hide-s" id="pingSeg" style="color:var(--mut);font-weight:600"><span id="ping">--</span></div>
    <div class="money"><span id="money">MVC 0</span><button class="plus" id="plus" aria-label="Wallet">+</button></div>
  </div>
  <div class="cards" id="cards"></div>
  <div class="chatlog" id="chatlog"></div>
  <div class="bottom" id="bottom"><div class="ctx hidden" id="ctx"></div>
  <div class="dock" id="dock">
    <div class="loc"><div class="pin">📍</div><div><b id="place">Maple Court</b><small id="placeSub">Residential District</small></div><span class="sp"></span>
      <button class="round" id="emoteBtn" title="Emotes">😀</button><button class="round" id="mapBtn" title="Map">🗺️</button><button class="round" id="homeBtn" title="Go home">🏠</button></div>
    <div class="emotes hidden" id="emotes">${Object.entries(EMOTE_ICON).map(([k, v]) => `<button data-e="${k}" aria-label="${k}">${v}</button>`).join('')}</div>
    <div class="say"><input id="say" maxlength="200" placeholder="Say something…" autocomplete="off"><button class="go" id="send" aria-label="Send">➤</button></div>
    <div class="chips" id="chips"></div>
  </div></div>
  <div class="nav" id="nav">
    <button data-tab="home"><span>🏠</span>Home</button><button data-tab="buy"><span>🛍️</span>Buy</button>
    <button data-tab="map"><span>🗺️</span>Map</button><button data-tab="phone"><span>📱</span>Phone</button>
  </div>
  <div id="sheetHost"></div>`;
  const q = (s) => $(s);
  q('#plus').onclick = () => h.openSheet('phone', 'wallet');
  q('#mapBtn').onclick = () => h.openSheet('map');
  q('#homeBtn').onclick = () => h.openSheet('home');
  q('#emoteBtn').onclick = () => q('#emotes').classList.toggle('hidden');
  q('#emotes').querySelectorAll('button').forEach((b) => b.onclick = () => h.emote(b.dataset.e));
  q('#nav').querySelectorAll('button').forEach((b) => b.onclick = () => h.openSheet(b.dataset.tab));
  q('#send').onclick = () => h.say(q('#say'));
  q('#say').onkeydown = (e) => { if (e.key === 'Enter') h.say(q('#say')); e.stopPropagation(); };
  q('#say').onkeyup = (e) => e.stopPropagation();
  q('#chips').innerHTML = h.places.map((p) => `<button data-p="${p.id}">${p.icon} ${esc(p.label)}</button>`).join('');
  q('#chips').querySelectorAll('button').forEach((b) => b.onclick = () => h.walkTo(b.dataset.p));
}

export function setClock(hour, dayIndex) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
  const h12 = ((hh + 11) % 12) + 1;
  $('#clock').textContent = `${days[dayIndex % 7]} ${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  $('#clockIc').textContent = hour >= 6 && hour < 18 ? '☀️' : '🌙';
}
export const setMoney = (n) => { $('#money').textContent = `MVC ${mvc(n)}`; };
export const setOnline = (n) => { $('#online').textContent = `${n} online`; };

export function setGoals(goals, achievements, reputation) {
  const done = new Set((achievements ?? []).map((a) => a.achievementId));
  const firstOpen = goals.findIndex((g) => !done.has(g.id));
  $('#cards').innerHTML = goals.map((g, i) => `<div class="mini ${done.has(g.id) ? 'done' : ''} ${i === firstOpen ? 'first' : ''}"><div class="ic">${g.icon}</div><div><b>${esc(g.title)}</b><small>${esc(g.sub)}</small></div>${done.has(g.id) ? '<span class="tick">✓</span>' : ''}</div>`).join('')
    + `<div class="mini"><div class="ic">⭐</div><div><b>Reputation ${reputation ?? 0}</b><small>Unlocks better jobs</small></div></div>`
    + '<button class="clean" id="clean">⌃ Clean screen</button>';
  $('#clean').onclick = () => document.body.classList.toggle('cleanui');
}

export function addChatLine(name, text) {
  const el = document.createElement('div'); el.innerHTML = `<b>${esc(name)}</b> ${esc(text)}`;
  const log = $('#chatlog'); log.append(el); while (log.children.length > 6) log.firstChild.remove(); setTimeout(() => el.remove(), 14000);
}

export function setPlace(title, sub) { $('#place').textContent = title; $('#placeSub').textContent = sub; }
export function setSayPlaceholder(n) { $('#say').placeholder = n > 1 ? `Say something to the ${n} players here…` : 'Say something… (nobody is close enough to hear)'; }

export function showCtx(html, wire) {
  const el = $('#ctx'); if (!html) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden'); el.innerHTML = html; wire?.(el);
}

// ------------------------------------------------------------------ sheets (phone / map / buy / home)
export function closeSheet() { document.body.classList.remove('sheetopen'); $('#sheetHost').innerHTML = ''; document.querySelectorAll('#nav button').forEach((b) => b.classList.remove('on')); }
export function openSheet(tab, html, wire) {
  document.body.classList.add('sheetopen');
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#sheetHost').innerHTML = `<div class="sheet" id="sheet">${html}</div>`;
  $('#sheetClose').onclick = closeSheet; wire?.($('#sheet'));
}
export const sheetTitle = (t) => `<h2>${t}<button class="round" id="sheetClose" aria-label="Close">✕</button></h2>`;

export function renderWallet(rows) {
  const names = { starting_grant: 'Welcome gift', shop_purchase: 'Shop purchase', rent_initial: 'Rent', rent_renewal: 'Rent', wage: 'Wages', trade: 'Trade', admin_adjustment: 'Adjustment', business_sale_player: 'Sale', dev_grant: 'Test money' };
  return `<div class="list">${rows.map((r) => `<div class="li"><div><b>${esc(names[r.type] ?? r.type.replace(/_/g, ' '))}</b><small>${new Date(r.at).toLocaleString()}</small></div><div><span class="${r.delta >= 0 ? 'pos' : 'neg'}">${r.delta >= 0 ? '+' : ''}${mvc(r.delta)}</span><small style="text-align:right">bal ${mvc(r.balance)}</small></div></div>`).join('') || '<p>No transactions yet.</p>'}</div>`;
}
export function renderJobs(d) {
  return `<div class="list">${d.jobs.map((j) => `<div class="li"><div><b>${esc(j.name)}</b><small>${esc(j.employer)} · ${j.tasksPerShift} tasks per shift</small></div><div class="pos">+${mvc(j.wagePerShift)}</div></div>`).join('')}</div>
  <h3 style="margin:14px 0 6px">Recent shifts</h3><div class="list">${d.history.map((s) => `<div class="li"><div><b>${esc(s.jobId.replace(/^job_/, '').replace(/_/g, ' '))}</b><small>${esc(s.status)} · ${s.tasksDone}/${s.tasksRequired} tasks</small></div><div class="pos">${s.wage ? '+' + mvc(s.wage) : ''}</div></div>`).join('') || '<p style="color:var(--mut)">No shifts yet. Visit a work station!</p>'}</div>`;
}
export function renderGoals(d) {
  return `<p style="margin:0 0 8px">⭐ Reputation <b>${d.reputation}</b></p><div class="list">${d.achievements.map((a) => `<div class="li"><div><b>${a.earned ? '✅' : '⬜'} ${esc(a.name)}</b><small>${a.reputation ? `+${a.reputation} reputation` : 'Milestone'}</small></div></div>`).join('')}</div>
  <h3 style="margin:14px 0 6px">Skills</h3><div class="list">${d.skills.map((s) => `<div class="li"><b>${esc(s.skillId)}</b><span>${s.xp} xp</span></div>`).join('') || '<p style="color:var(--mut)">Work shifts to build skills.</p>'}</div>`;
}

// ------------------------------------------------------------------ map
export function drawMap(canvas, world, me, others) {
  const W = canvas.width, H = canvas.height, B = world.bounds;
  const sx = (x) => ((x - B.minX) / (B.maxX - B.minX)) * W, sz = (z) => ((z - B.minZ) / (B.maxZ - B.minZ)) * H;
  const g = canvas.getContext('2d');
  g.fillStyle = '#9fd07f'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#85bd68'; g.fillRect(sx(-34), sz(-26), sx(-12) - sx(-34), sz(-6) - sz(-26));
  g.fillStyle = '#505564'; g.fillRect(0, sz(world.road.minZ), W, sz(world.road.maxZ) - sz(world.road.minZ));
  g.strokeStyle = '#f2ecd8'; g.setLineDash([10, 10]); g.lineWidth = 2; g.beginPath(); g.moveTo(0, sz(0)); g.lineTo(W, sz(0)); g.stroke(); g.setLineDash([]);
  for (const b of world.buildings) {
    g.fillStyle = b.wall; g.fillRect(sx(b.cx - b.sx / 2), sz(b.cz - b.sz / 2), sx(b.cx + b.sx / 2) - sx(b.cx - b.sx / 2), sz(b.cz + b.sz / 2) - sz(b.cz - b.sz / 2));
    g.fillStyle = '#fff'; g.font = '700 13px system-ui'; g.textAlign = 'center'; g.fillText(b.name, sx(b.cx), sz(b.cz) + 4);
  }
  for (const p of world.props) if (p.type === 'tree') { g.fillStyle = '#4f9d45'; g.beginPath(); g.arc(sx(p.x), sz(p.z), 5, 0, 7); g.fill(); }
  const icons = { door: '🏠', shop: '🛒', work: '💼' }; g.font = '18px sans-serif';
  for (const z of world.zones) g.fillText(icons[z.kind], sx(z.x), sz(z.z) + 6);
  for (const o of others) { g.fillStyle = o.npc ? 'rgba(60,70,90,.55)' : '#3b6fe0'; g.beginPath(); g.arc(sx(o.x), sz(o.z), o.npc ? 3 : 6, 0, 7); g.fill(); }
  g.fillStyle = '#fff'; g.strokeStyle = '#1b2236'; g.lineWidth = 3; g.beginPath(); g.arc(sx(me.x), sz(me.z), 8, 0, 7); g.fill(); g.stroke();
}

export function showMenu(x, y, title, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = document.createElement('div'); m.className = 'menu';
  m.style.left = `${Math.min(x, innerWidth - 170)}px`; m.style.top = `${Math.max(8, y - 10)}px`;
  m.innerHTML = `<b>${esc(title)}</b>` + items.map((it, i) => `<button data-i="${i}">${it.label}</button>`).join('');
  m.querySelectorAll('button').forEach((b) => b.onclick = () => { m.remove(); items[+b.dataset.i].run(); });
  document.body.append(m); setTimeout(() => addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); removeEventListener('pointerdown', off); } }), 0);
}

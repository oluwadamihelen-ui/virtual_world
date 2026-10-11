// All screens and HUD pieces. Pure DOM + inline SVG; main.js feeds it data and handles actions.
import * as THREE from 'three';
import { createAvatar, SKIN, HAIR, OUTFIT, BODY, EMOTE_ICON } from './avatar.js';

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const root = () => $('#ui');
export const clear = () => { root().innerHTML = ''; document.body.classList.remove('panelopen'); };

// ---------------------------------------------------------------- money in the local currency
let CUR = { symbol: '₦', perMVC: 100, decimals: 0, code: 'NGN' };
export const setCurrency = (c) => { CUR = c; };
export const currency = () => CUR;
export function fmt(mvc, cur = CUR) {
  const v = (mvc ?? 0) * cur.perMVC;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: cur.decimals, maximumFractionDigits: cur.decimals });
  return `${v < 0 ? '-' : ''}${cur.symbol}${s}`;
}
export const mvc = (n) => `${Number(n ?? 0).toLocaleString('en-US')} MVC`;

// ---------------------------------------------------------------- icons (hand-drawn paths, 24x24)
const P = {
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M10.5 18.5h3"/>',
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14c1 1.8 2.5 2.6 4 2.6s3-.8 4-2.6M9 9.5v.5M15 9.5v.5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  wallet: '<path d="M4 7a2 2 0 0 1 2-2h12v3"/><path d="M4 7v11a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2z"/><circle cx="16" cy="14" r="1.2"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
  sofa: '<path d="M5 11V8a2 2 0 012-2h10a2 2 0 012 2v3"/><path d="M3 13a2 2 0 014 0v2h10v-2a2 2 0 014 0v5H3z"/><path d="M6 18v2M18 18v2"/>',
  bank: '<path d="M3 9l9-5 9 5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  brief: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V5.5h6V8M3 13h18"/>',
  chat: '<path d="M4 5h16v11H10l-5 4v-4H4z"/>',
  heart: '<path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="9" cy="15" r="1"/><circle cx="15" cy="15" r="1"/>',
  plane: '<path d="M2.5 13.5l8.5-2 4-7.5 2 .8-2 7.7 5.5 1.7v2l-6.5-.8-2 4.3-2-.9.6-4.5-8.1 1z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 17l-5.4 2.8 1.1-6.1L3.2 9.4l6.1-.8z"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M8 4v16M11 8h5"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  clean: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/>',
  coin: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c.8-1 4.2-1.2 4.2.8 0 2-4 1.4-4 3.6 0 1.8 3.4 1.8 4.5.6"/>',
};
export const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${P[n] ?? ''}</svg>`;

export function toast(kind, text, ms = 3800) {
  const el = document.createElement('div'); el.className = `toast ${kind}`; el.textContent = text;
  $('#toasts').append(el); setTimeout(() => el.remove(), ms);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

// ================================================================ sign in / characters / creator
function dobFields() {
  return `<label>Date of birth</label><input type="date" id="dob" max="${new Date().toISOString().slice(0, 10)}"><div class="checkrow"><span style="font-size:12px;color:var(--mut)">We use this only to switch on age-appropriate features. You must be 13 or older. Some apps are for adults (18+) only.</span></div>`;
}
export function showAuth({ onSubmit }) {
  clear();
  root().innerHTML = `
  <div class="screen"><form class="card" id="authForm" autocomplete="on">
    <div class="logo"><b>M</b><h1>My Virtual World</h1></div>
    <p class="sub">A shared world where you build your own life. Closed alpha.</p>
    <div class="tabs"><button type="button" class="on" data-m="login">Sign in</button><button type="button" data-m="register">Create account</button></div>
    <label>Email</label><input type="email" id="em" autocomplete="username" required>
    <label>Password <span id="pwhint" class="hidden" style="text-transform:none;letter-spacing:0">(10+ characters)</span></label><input type="password" id="pw" autocomplete="current-password" required>
    <div id="dobBox" class="hidden">${dobFields()}</div>
    <div class="err" id="err"></div>
    <div class="row end" style="margin-top:6px"><button class="btn" id="go">Sign in</button></div>
  </form></div>`;
  let mode = 'login';
  root().querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
    mode = b.dataset.m; root().querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('#go').textContent = mode === 'login' ? 'Sign in' : 'Create account'; $('#pwhint').classList.toggle('hidden', mode === 'login'); $('#dobBox').classList.toggle('hidden', mode === 'login');
    $('#pw').autocomplete = mode === 'login' ? 'current-password' : 'new-password'; $('#err').textContent = '';
  });
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault(); $('#go').disabled = true; $('#err').textContent = '';
    try { await onSubmit(mode, $('#em').value.trim(), $('#pw').value, $('#dob').value); } catch (err) { $('#err').textContent = err.message; $('#go').disabled = false; }
  };
}

export function showBirthdate({ onSubmit, onLogout }) {
  clear();
  root().innerHTML = `<div class="screen"><form class="card" id="bdForm"><h1>One quick thing</h1><p class="sub">Please tell us your date of birth. It can only be set once and is used only to switch on age-appropriate features.</p>${dobFields()}<div class="err" id="err"></div><div class="row end"><button type="button" class="btn ghost" id="out">Sign out</button><button class="btn" id="go">Continue</button></div></form></div>`;
  $('#out').onclick = onLogout;
  $('#bdForm').onsubmit = async (e) => { e.preventDefault(); $('#go').disabled = true; try { await onSubmit($('#dob').value); } catch (err) { $('#err').textContent = err.message; $('#go').disabled = false; } };
}

export function showCharacters(chars, { onPlay, onNew, onLogout }) {
  clear();
  root().innerHTML = `<div class="screen"><div class="card"><h1>Who's playing?</h1><p class="sub">Pick a character or make a new one.</p>
    <div class="charlist">${chars.map((c, i) => `<button class="char" data-i="${i}"><span class="av" style="background:${SKIN[c.appearance.skinTone] ?? '#c98a5e'}">${esc(c.displayName[0].toUpperCase())}</span><span><b>${esc(c.displayName)}</b><br><small style="color:var(--mut)">Tap to enter the world</small></span></button>`).join('')}</div>
    <div class="row"><button class="btn" id="new">＋ New character</button><span class="grow"></span><button class="btn ghost small" id="out">Sign out</button></div></div></div>`;
  root().querySelectorAll('.char').forEach((b) => b.onclick = () => onPlay(chars[+b.dataset.i]));
  $('#new').onclick = onNew; $('#out').onclick = onLogout;
}

const HAIRSTYLES = ['short', 'long', 'curly', 'braids', 'buzz', 'bun'];
export function showCreator({ onSubmit, onBack, canGoBack }) {
  clear();
  const f = { name: '', skinTone: 2, hairstyle: 'short', hairColor: 'brown', outfit: 'casual_1', bodyPreset: 'body_a' };
  root().innerHTML = `<div class="screen"><div class="card" style="width:min(660px,100%)"><h1>Create your character</h1><p class="sub">Pick a name and a look.</p>
    <div class="creator"><div class="preview"><canvas id="pv"></canvas></div><div>
      <label>Display name</label><input type="text" id="nm" maxlength="20" placeholder="3-20 letters or numbers" autocomplete="off">
      <label>Skin</label><div class="swatches" id="skin"></div>
      <label>Hair style</label><div class="swatches" id="hs"></div>
      <label>Hair colour</label><div class="swatches" id="hc"></div>
      <label>Outfit</label><div class="swatches" id="of"></div>
      <label>Build</label><div class="swatches" id="bd"></div>
    </div></div><div class="err" id="err"></div>
    <div class="row end">${canGoBack ? '<button class="btn ghost" id="back">Back</button>' : ''}<button class="btn" id="ok">Enter the world</button></div></div></div>`;
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
  fill('#bd', Object.keys(BODY), 'bodyPreset', (v) => `<i class="chip" style="display:block">${'Type ' + v.slice(-1).toUpperCase()}</i>`);
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

// ================================================================ in-game HUD
export function buildHud(h) {
  clear();
  root().innerHTML = `
  <div class="wallet" id="walletCard" title="Open your bank"><div class="avatar" id="wInit">?</div><div><b id="wName"></b><div class="amt" id="wAmt">-</div><small id="wSub"></small></div></div>
  <div class="dial" id="dial">
    <svg viewBox="0 0 120 56" aria-hidden="true"><path d="M8 52A52 48 0 0 1 112 52" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="3" stroke-linecap="round" stroke-dasharray="2 6"/><line x1="4" y1="52" x2="116" y2="52" stroke="rgba(255,255,255,.2)" stroke-width="2"/><circle id="orb" cx="8" cy="52" r="7" fill="#f4b942"/><circle id="orbMoon" cx="8" cy="52" r="3" fill="#0d2a2f" opacity="0"/></svg>
    <div class="t" id="clock">--</div><small id="dialSub">-</small>
  </div>
  <button class="journalTab" id="journalTab">${icon('book')}<span>Journal</span><span class="n" id="jN">0</span></button>
  <div class="journal hidden" id="journal"></div>
  <div class="rail" id="rail">
    <button id="rPhone" title="Phone">${icon('phone')}<span class="badge hidden" id="phoneBadge">!</span></button>
    <button id="rMap" title="Map & travel">${icon('map')}</button>
    <button id="rHome" title="Go home">${icon('home')}</button>
    <button id="rView" title="City view [V]">${icon('pin')}</button>
    <button id="rFurn" title="Furnish your home">${icon('sofa')}</button>
    <button id="rMic" title="Voice chat (hold T to talk)">${icon('mic')}</button>
    <button id="rEmote" title="Emotes">${icon('smile')}</button>
    <button id="rClean" title="Hide the interface">${icon('eye')}</button>
  </div>
  <div class="emotes hidden" id="emotes">${Object.entries(EMOTE_ICON).map(([k, v]) => `<button data-e="${k}" aria-label="${k}">${v}</button>`).join('')}</div>
  <div class="chatlog" id="chatlog"></div>
  <div class="stack">
    <div class="ctx hidden" id="ctx"></div>
    <div class="where">${icon('pin')}<b id="place">-</b><span id="placeSub"></span></div>
    <div class="cmd"><input id="say" maxlength="200" placeholder="Press Enter to chat…" autocomplete="off"><button class="go" id="send" aria-label="Send">${icon('send')}</button></div>
  </div>
  <div id="panelHost"></div>`;
  const q = (s) => $(s);
  q('#walletCard').onclick = () => h.openPhone('bank');
  q('#rPhone').onclick = () => h.openPhone();
  q('#rMap').onclick = () => h.openMap();
  q('#rHome').onclick = () => h.goHome();
  q('#rView').onclick = () => h.cityView();
  q('#rFurn').onclick = () => h.furnish();
  q('#rMic').onclick = () => h.voice();
  q('#rEmote').onclick = () => q('#emotes').classList.toggle('hidden');
  q('#rClean').onclick = () => { document.body.classList.add('cleanui'); toast('info', 'Interface hidden. Tap the screen corner to bring it back.'); addEventListener('pointerdown', function back(e) { if (e.clientX > innerWidth - 90 && e.clientY < 90) { document.body.classList.remove('cleanui'); removeEventListener('pointerdown', back); } }); };
  q('#journalTab').onclick = () => q('#journal').classList.toggle('hidden');
  q('#emotes').querySelectorAll('button').forEach((b) => b.onclick = () => { h.emote(b.dataset.e); q('#emotes').classList.add('hidden'); });
  q('#send').onclick = () => h.say(q('#say'));
  q('#say').onkeydown = (e) => { if (e.key === 'Enter') h.say(q('#say')); e.stopPropagation(); };
  q('#say').onkeyup = (e) => e.stopPropagation();
}

export function setWallet({ name, mvcAmount, cityName, country }) {
  $('#wInit').textContent = (name ?? '?')[0].toUpperCase(); $('#wName').textContent = name;
  $('#wAmt').textContent = fmt(mvcAmount); $('#wSub').textContent = `≈ ${mvc(mvcAmount)} · ${country.flag} ${cityName}`;
}
export function setClock(hour, dayIndex, sub) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60), h12 = ((hh + 11) % 12) + 1;
  $('#clock').textContent = `${days[dayIndex % 7]} ${h12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  $('#dialSub').textContent = sub;
  const day = hour >= 6 && hour < 18;
  const t = day ? (hour - 6) / 12 : (((hour + 6) % 24) / 12);   // 0..1 across the arc
  const a = Math.PI * (1 - t), x = 60 + 52 * Math.cos(a), y = 52 - 48 * Math.sin(a);
  const orb = $('#orb'), moon = $('#orbMoon');
  orb.setAttribute('cx', x.toFixed(1)); orb.setAttribute('cy', y.toFixed(1)); orb.setAttribute('fill', day ? '#f4b942' : '#cfd9ff');
  moon.setAttribute('cx', (x + 3).toFixed(1)); moon.setAttribute('cy', (y - 2).toFixed(1)); moon.setAttribute('opacity', day ? 0 : 1);
}
export function setGoals(goals, achievements, reputation) {
  const done = new Set((achievements ?? []).map((a) => a.achievementId));
  const open = goals.filter((g) => !done.has(g.id)).length;
  $('#jN').textContent = open; $('#jN').classList.toggle('hidden', !open);
  $('#journal').innerHTML = goals.map((g) => `<div class="goal ${done.has(g.id) ? 'done' : ''}"><div class="ic">${icon(g.icon)}</div><div><b>${esc(g.title)}</b><small>${esc(g.sub)}</small></div></div>`).join('')
    + `<div class="goal rep"><div class="ic">${icon('star')}</div><div><b>Reputation ${reputation ?? 0}</b><small>Unlocks better jobs</small></div></div>`;
}
export function addChatLine(name, text) {
  const el = document.createElement('div'); el.innerHTML = `<b>${esc(name)}</b> ${esc(text)}`;
  const log = $('#chatlog'); log.append(el); while (log.children.length > 6) log.firstChild.remove(); setTimeout(() => el.remove(), 14000);
}
export function setPhoneBadge(n) {
  const b = $('#rPhone'); if (!b) return; let d = b.querySelector('.dot'); if (!n) { d?.remove(); return; }
  if (!d) { d = document.createElement('span'); d.className = 'dot'; b.append(d); } d.textContent = n > 9 ? '9+' : n;
}
export function setPlace(title, sub) { $('#place').textContent = title; $('#placeSub').textContent = sub ? `· ${sub}` : ''; }
export function setSayPlaceholder(n) { $('#say').placeholder = n > 1 ? `Chat with the ${n - 1} ${n - 1 === 1 ? 'person' : 'people'} nearby…` : 'Nobody close enough to hear you…'; }
export function showCtx(html, wire) {
  const el = $('#ctx'); if (!html) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden'); el.innerHTML = html; wire?.(el);
}

// ================================================================ panels, phone, map
export function closePanel() { $('#panelHost').innerHTML = ''; document.body.classList.remove('panelopen'); }
export function openPanel(title, html, wire, opts = {}) {
  document.body.classList.add('panelopen');
  $('#panelHost').innerHTML = `<div class="overlay" id="ov"><div class="panel" style="${opts.width ? `width:${opts.width}` : ''}"><header><h2>${title}</h2><button class="x" id="panelX" aria-label="Close">${icon('close')}</button></header><div class="body" id="panelBody">${html}</div></div></div>`;
  $('#panelX').onclick = () => opts.onClose ? opts.onClose() : closePanel();
  $('#ov').addEventListener('pointerdown', (e) => { if (e.target.id === 'ov') (opts.onClose ?? closePanel)(); });
  wire?.($('#panelBody'));
}

/** The phone: a home screen of apps; each app renders into the same screen. */
export function openPhone({ apps, hour, cityName, onClose }) {
  document.body.classList.add('panelopen');
  const night = hour < 6 || hour >= 20, dusk = !night && (hour < 8 || hour >= 17);
  const wall = night ? 'linear-gradient(160deg,#16124a,#3a1f7a 55%,#7a2f6a)' : dusk ? 'linear-gradient(160deg,#5a3aa8,#d9667a 55%,#f4b942)' : 'linear-gradient(160deg,#2a7a8a,#4aa8a0 55%,#a8e0b0)';
  const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60), h12 = ((hh + 11) % 12) + 1;
  const time = `${h12}:${String(mm).padStart(2, '0')}`;
  $('#panelHost').innerHTML = `<div class="overlay" id="ov"><div class="phone"><div class="notch"></div><div class="scr" id="pscr" style="background:${wall}"><div class="status"><span>${time}${hh < 12 ? 'AM' : 'PM'}</span><span>5G ▮▮▮</span></div><div id="pbody" style="display:flex;flex-direction:column;flex:1;min-height:0"></div><div class="hbar" id="hbar" title="Home"></div></div></div></div>`;
  const body = $('#pbody');
  const close = () => { onClose ? onClose() : closePanel(); };
  $('#ov').addEventListener('pointerdown', (e) => { if (e.target.id === 'ov') close(); });
  const api = {
    home() {
      body.innerHTML = `<div class="home"><div class="big">${time}</div><div class="date">${esc(cityName)} · tap an app</div><div class="apps">${apps.map((a) => `<button class="app" data-id="${a.id}"><div class="ic" style="background:${a.color}${a.soon ? ';filter:saturate(.35) brightness(.85)' : ''}">${a.emoji ? `<span style="font-size:28px;line-height:1">${a.emoji}</span>` : icon(a.icon)}</div>${esc(a.name)}${a.soon ? '<span class="new" style="background:#64748b">SOON</span>' : a.isNew ? '<span class="new">NEW</span>' : ''}${a.badge ? `<span class="new bd">${a.badge}</span>` : ''}${a.adult ? '<span class="age">18+</span>' : ''}</button>`).join('')}</div></div>`;
      body.querySelectorAll('.app').forEach((b) => b.onclick = () => apps.find((a) => a.id === b.dataset.id).open(api));
    },
    app(title, html, wire) {
      body.innerHTML = `<div class="apphead"><button class="x" id="pback" aria-label="Back" style="background:rgba(255,255,255,.18)">${icon('back')}</button><h3>${esc(title)}</h3></div><div class="appbody" id="pappbody">${html}</div>`;
      $('#pback').onclick = () => api.home(); wire?.($('#pappbody'));
    },
    setBody(html, wire) { const el = $('#pappbody'); if (el) { el.innerHTML = html; wire?.(el); } },
    el: () => $('#pappbody'),
  };
  $('#hbar').onclick = () => (body.querySelector('.home') ? close() : api.home());
  api.home();
  return api;
}

// ---------------------------------------------------------------- map
const bbox = (cities, minLon = 4, minLat = 4) => {
  let [a, b, c, d] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const x of cities) { a = Math.min(a, x.lon); b = Math.max(b, x.lon); c = Math.min(c, x.lat); d = Math.max(d, x.lat); }
  if (b - a < minLon) { const m = (a + b) / 2; a = m - minLon * 0.75; b = m + minLon * 0.75; } if (d - c < minLat) { const m = (c + d) / 2; c = m - minLat * 0.625; d = m + minLat * 0.625; }
  const pl = (b - a) * 0.14, pt = (d - c) * 0.16; return { minLon: a - pl, maxLon: b + pl, minLat: c - pt, maxLat: d + pt };
};
export function renderMapSvg(geo, scope, here, selected) {
  const W = 600, H = 400;
  const metro = scope.startsWith('metro:');
  const cities = metro ? geo.cities.filter((c) => c.metro === scope.slice(6)) : scope === 'world' ? geo.cities.filter((c) => c.hub) : geo.cities.filter((c) => c.country === scope && c.hub);
  const bb = metro ? bbox(cities, 0.18, 0.14) : bbox(cities);
  const px = (c) => [((c.lon - bb.minLon) / (bb.maxLon - bb.minLon)) * W, ((bb.maxLat - c.lat) / (bb.maxLat - bb.minLat)) * H];
  const pts = new Map(cities.map((c) => [c.id, px(c)]));
  let routes = '';
  if (scope !== 'world') {
    const seen = new Set();
    for (const c of cities) {
      const near = cities.filter((o) => o !== c).sort((p, q) => Math.hypot(p.lon - c.lon, p.lat - c.lat) - Math.hypot(q.lon - c.lon, q.lat - c.lat)).slice(0, 2);
      for (const o of near) { const k = [c.id, o.id].sort().join(); if (seen.has(k)) continue; seen.add(k); const [x1, y1] = pts.get(c.id), [x2, y2] = pts.get(o.id); routes += `<line class="route" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; }
    }
  } else if (here && selected && here !== selected && pts.has(here) && pts.has(selected)) {
    const [x1, y1] = pts.get(here), [x2, y2] = pts.get(selected); routes += `<path class="route" d="M${x1} ${y1} Q${(x1 + x2) / 2} ${Math.min(y1, y2) - 70} ${x2} ${y2}"/>`;
  }
  const land = cities.map((c) => { const [x, y] = pts.get(c.id); return `<circle class="land" cx="${x}" cy="${y}" r="${scope === 'world' ? 46 : metro ? 52 : 78}"/>`; }).join('');
  const grid = Array.from({ length: 9 }, (_, i) => `<line x1="${(i + 1) * 60}" y1="0" x2="${(i + 1) * 60}" y2="${H}" stroke="rgba(255,255,255,.05)"/>`).join('') + Array.from({ length: 6 }, (_, i) => `<line x1="0" y1="${(i + 1) * 57}" x2="${W}" y2="${(i + 1) * 57}" stroke="rgba(255,255,255,.05)"/>`).join('');
  const nodes = cities.map((c) => { const [x, y] = pts.get(c.id); const flag = geo.countries.find((k) => k.id === c.country)?.flag ?? '';
    return `<g class="city ${selected === c.id ? 'sel' : ''}" data-city="${c.id}">${here === c.id ? `<circle class="you" cx="${x}" cy="${y}" r="8"/>` : ''}<circle class="dot" cx="${x}" cy="${y}" r="9"/><text x="${x}" y="${y + 26}" text-anchor="middle">${flag} ${esc(c.name)}${!metro && geo.cities.filter((o) => o.metro === c.metro).length > 1 ? ' ▸' : ''}</text><circle cx="${x}" cy="${y}" r="15" fill="transparent"/></g>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${grid}${land}${routes}${nodes}</svg>`;
}

export function showMenu(x, y, title, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = document.createElement('div'); m.className = 'menu';
  m.style.left = `${Math.min(x, innerWidth - 180)}px`; m.style.top = `${Math.max(8, y - 10)}px`;
  m.innerHTML = `<b>${esc(title)}</b>` + items.map((it, i) => `<button data-i="${i}">${it.label}</button>`).join('');
  m.querySelectorAll('button').forEach((b) => b.onclick = () => { m.remove(); items[+b.dataset.i].run(); });
  document.body.append(m); setTimeout(() => addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); removeEventListener('pointerdown', off); } }), 0);
}

export function showTravel({ toName, icon: em, mode, arrivesAt, seconds, now }) {
  let el = $('#travelVeil'); el?.remove();
  el = document.createElement('div'); el.id = 'travelVeil'; el.className = 'travel';
  el.innerHTML = `<div><div class="em">${em}</div><h1>Heading to ${esc(toName)}</h1><p id="tSub">${esc(mode)}</p><div class="bar"><i id="tBar" style="width:0%"></i></div><p id="tLeft" style="margin-top:12px"></p></div>`;
  document.body.append(el);
  const total = Math.max(1, arrivesAt - now());
  const t = setInterval(() => {
    const left = Math.max(0, arrivesAt - now()); $('#tBar') && ($('#tBar').style.width = `${Math.min(100, 100 - (left / total) * 100)}%`); $('#tLeft') && ($('#tLeft').textContent = left > 0 ? `Arriving in ${Math.ceil(left / 1000)}s` : 'Arriving…');
    if (!document.body.contains(el)) clearInterval(t);
  }, 200);
  return () => { clearInterval(t); el.remove(); };
}

/** Small modal asking why a player is being reported. onSend(category, detail). */
export function reportDialog(name, onSend) {
  const host = document.createElement('div'); host.className = 'overlay'; host.style.zIndex = 60;
  host.innerHTML = `<div class="panel" style="max-width:380px"><h3 style="margin:0 0 8px">Report ${esc(name)}</h3><div class="field" style="display:grid;gap:8px">
    <select id="rpCat"><option value="harassment">Harassment or bullying</option><option value="scam">Scam or fraud</option><option value="inappropriate_name">Inappropriate name or profile</option><option value="cheating">Cheating</option><option value="other">Something else</option></select>
    <textarea id="rpDet" rows="3" maxlength="300" placeholder="What happened? (optional)"></textarea>
    <small style="opacity:.7">A moderator sees your report and the recent messages between you two.</small>
    <div style="display:flex;gap:8px"><button class="btn" id="rpGo">Send report</button><button class="btn ghost" id="rpNo">Cancel</button></div></div></div>`;
  document.body.append(host);
  host.querySelector('#rpNo').onclick = () => host.remove();
  host.querySelector('#rpGo').onclick = () => { onSend(host.querySelector('#rpCat').value, host.querySelector('#rpDet').value.trim() || undefined); host.remove(); };
}

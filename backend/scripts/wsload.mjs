// WebSocket load test against a RUNNING game server (see docs/LOAD_TESTING.md).
//   BASE=http://localhost:3200 node scripts/wsload.mjs --players 40 --seconds 30
// Start the server with RATE_LIMIT_DISABLED=1 (non-production) so account creation is not throttled.
// Each bot signs up, joins through the real ticket flow, walks around, chats, opens the Vault, and measures ping and snapshot rate.
import WebSocket from 'ws';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.BASE ?? 'http://localhost:3000', PLAYERS = Number(arg('players', 40)), SECONDS = Number(arg('seconds', 30));
const uid = Math.random().toString(36).slice(2, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const post = async (path, body, token) => (await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) })).json();

const rtts = [], appMs = []; let snaps = 0, closed = 0, errors = 0, joined = 0;
async function bot(i) {
  const email = `ws${uid}${i}@example.com`;
  await post('/v1/auth/register', { email, password: 'load test password', birthDate: '1990-01-01' });
  const { token } = await post('/v1/auth/login', { email, password: 'load test password' });
  const ch = await post('/v1/characters', { displayName: `WS ${uid} ${i}`, appearance: { bodyPreset: 'body_a', skinTone: 1, hairstyle: 'short', hairColor: 'black', outfit: 'casual_1' } }, token);
  const { ticket } = await post(`/v1/characters/${ch.characterId}/join-ticket`, {}, token);
  return { ticket };
}
console.log(`Creating ${PLAYERS} players…`);
const tickets = [];
for (let i = 0; i < PLAYERS; i += 10) tickets.push(...await Promise.all(Array.from({ length: Math.min(10, PLAYERS - i) }, (_, k) => bot(i + k))));

console.log('Connecting…');
const end = Date.now() + SECONDS * 1000;
const run = ({ ticket }, i) => new Promise((resolve) => {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?ticket=${ticket}`, { headers: { origin: BASE } });
  let seq = 0, dx = 0, dz = 0; const pend = new Map();
  const timers = [];
  ws.on('open', () => {
    joined++;
    timers.push(setInterval(() => { if (Math.random() < 0.15) { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); } ws.send(JSON.stringify({ t: 'input', seq: ++seq, dx, dz, run: false })); }, 50));
    timers.push(setInterval(() => ws.send(JSON.stringify({ t: 'ping', c: performance.now() })), 1000));
    timers.push(setInterval(() => { if (Math.random() < 0.3) ws.send(JSON.stringify({ t: 'chat', text: `hello ${i}` })); }, 4000));
    timers.push(setInterval(() => { const rid = `r${seq}`; pend.set(rid, performance.now()); ws.send(JSON.stringify({ t: 'app', rid, app: 'bank', a: 'overview', d: {} })); }, 5000 + (i % 5) * 300));
  });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'snap') snaps++;
    else if (m.t === 'pong') rtts.push(performance.now() - m.c);
    else if (m.t === 'app') { const t = pend.get(m.rid); if (t) { appMs.push(performance.now() - t); pend.delete(m.rid); } if (!m.ok) errors++; }
  });
  ws.on('close', () => { closed++; timers.forEach(clearInterval); resolve(); });
  ws.on('error', () => { errors++; });
  setTimeout(() => ws.close(), Math.max(0, end - Date.now()));
});
await Promise.all(tickets.map(run));
const health = await (await fetch(BASE + '/healthz')).json().catch(() => ({}));
console.log(`\nplayers joined: ${joined}/${PLAYERS}   closed: ${closed}   errors: ${errors}`);
console.log(`snapshots/sec per player: ${(snaps / PLAYERS / SECONDS).toFixed(1)} (target 10)`);
console.log(`ping ms  p50 ${pct(rtts, .5).toFixed(0)}  p95 ${pct(rtts, .95).toFixed(0)}  p99 ${pct(rtts, .99).toFixed(0)}  (n=${rtts.length})`);
console.log(`Vault overview round trip ms  p50 ${pct(appMs, .5).toFixed(0)}  p95 ${pct(appMs, .95).toFixed(0)}  (n=${appMs.length})`);
console.log('healthz:', JSON.stringify(health));

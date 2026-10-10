// Load test against a RUNNING backend (see docs/LOAD_TESTING.md).
//   BASE=http://localhost:3200 SERVER_KEY=... node scripts/loadtest.mjs --players 40 --seconds 20 [--admin-email a@b.c --admin-password ...]
// Players are created through the real player API and join through the real ticket flow (the production path).
import { performance } from 'node:perf_hooks';
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const BASE = process.env.BASE ?? 'http://localhost:3000', KEY = process.env.SERVER_KEY;
const PLAYERS = Number(arg('players', 40)), SECONDS = Number(arg('seconds', 20));
if (!KEY) { console.error('Set SERVER_KEY'); process.exit(1); }

const lat = new Map(); // label -> [ms]
const codes = new Map();
async function call(label, method, path, body, headers = {}) {
  const t = performance.now();
  let status = 0, json = null;
  try {
    const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    status = r.status; json = await r.json().catch(() => null);
  } catch { status = 0; }
  const ms = performance.now() - t;
  (lat.get(label) ?? lat.set(label, []).get(label)).push(ms);
  const k = `${label} ${status}`; codes.set(k, (codes.get(k) ?? 0) + 1);
  return { status, json, ms };
}
const gs = (l, m, p, b) => call(l, m, '/v1/game' + p, b, { 'x-server-key': KEY });
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const uid = Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- setup (not part of the measured workload) ----
console.log(`Creating ${PLAYERS} players…`);
const players = [];
await Promise.all(Array.from({ length: PLAYERS }, async (_, i) => {
  const email = `lt${uid}${i}@example.com`;
  await call('setup:register', 'POST', '/v1/auth/register', { email, password: 'load test password' });
  const login = await call('setup:login', 'POST', '/v1/auth/login', { email, password: 'load test password' });
  const auth = { authorization: `Bearer ${login.json?.token}` };
  const ch = await call('setup:character', 'POST', '/v1/characters', { displayName: `LT ${uid} ${i}`, appearance: { bodyPreset: 'body_a', skinTone: 1, hairstyle: 'short', hairColor: 'black', outfit: 'casual_1' } }, auth);
  const tk = await call('setup:ticket', 'POST', `/v1/characters/${ch.json?.characterId}/join-ticket`, {}, auth);
  const join = await gs('setup:join', 'POST', '/tickets/redeem', { ticket: tk.json?.ticket });
  if (join.status === 200) players.push({ id: ch.json.characterId, auth });
}));
if (players.length < PLAYERS) console.log('setup status codes:', Object.fromEntries([...codes.entries()].filter(([k]) => k.startsWith('setup:'))));
for (const k of [...lat.keys()].filter((k) => k.startsWith('setup:'))) lat.delete(k);
for (const k of [...codes.keys()].filter((k) => k.startsWith('setup:'))) codes.delete(k);
if (players.length < PLAYERS) { console.error(`Only ${players.length}/${PLAYERS} players joined; aborting (check rate limiting: start the server with RATE_LIMIT_DISABLED=1 in dev mode)`); process.exit(1); }

// ---- scenario 1: mixed steady workload ----
console.log(`Mixed workload: ${PLAYERS} concurrent players for ${SECONDS}s…`);
const end = performance.now() + SECONDS * 1000;
let ops = 0; const t0 = performance.now();
await Promise.all(players.map(async (p) => {
  while (performance.now() < end) {
    const r = Math.random();
    if (r < 0.5) await gs('purchase', 'POST', `/characters/${p.id}/shops/shop_corner_grocery/purchase`, { itemId: 'bottled_water', quantity: 1, idempotencyKey: crypto.randomUUID() });
    else if (r < 0.75) await gs('summary', 'GET', `/characters/${p.id}/summary`);
    else if (r < 0.9) await gs('chat-check', 'POST', '/chat/check', { characterId: p.id, text: 'hello there' });
    else await gs('shop-list', 'GET', '/world/shops/shop_corner_grocery');
    ops++; await sleep(20 + Math.random() * 100);
  }
}));
const elapsed = (performance.now() - t0) / 1000;

// ---- scenario 2: contention ----
console.log('Contention: everyone buys the same limited item / claims the same property at once…');
const rid = crypto.randomUUID().slice(0, 8);
const lampBefore = (await gs('c:shop', 'GET', '/world/shops/shop_corner_grocery')).json.stock.find((s) => s.itemId === 'desk_lamp').quantity;
const lampRes = await Promise.all(players.map((p) => gs('contend:lamp', 'POST', `/characters/${p.id}/shops/shop_corner_grocery/purchase`, { itemId: 'desk_lamp', quantity: 1, idempotencyKey: crypto.randomUUID() })));
const props = (await gs('c:props', 'GET', '/world/properties')).json.properties.filter((x) => x.available);
let rentWins = null;
if (props.length) {
  const rr = await Promise.all(players.map((p) => gs('contend:rent', 'POST', `/characters/${p.id}/rent`, { propertyId: props[0].propertyId, idempotencyKey: `${rid}-${p.id}`.slice(0, 60) })));
  rentWins = rr.filter((r) => r.status === 200).length;
}
const lampWins = lampRes.filter((r) => r.status === 200).length;

// ---- report ----
const rows = [...lat.entries()].filter(([k]) => !k.startsWith('c:') && !k.startsWith('contend:')).map(([k, a]) =>
  ({ endpoint: k, requests: a.length, 'p50 ms': +pct(a, .5).toFixed(1), 'p95 ms': +pct(a, .95).toFixed(1), 'p99 ms': +pct(a, .99).toFixed(1), 'max ms': +Math.max(...a).toFixed(1) }));
console.log(`\nMixed workload: ${ops} operations in ${elapsed.toFixed(1)}s = ${(ops / elapsed).toFixed(0)} ops/s with ${PLAYERS} players`);
console.table(rows);
console.log('Status codes:', Object.fromEntries([...codes.entries()].filter(([k]) => !k.startsWith('c:') && !k.startsWith('contend:'))));
const bad = [...codes.entries()].filter(([k]) => /\s(0|5\d\d)$/.test(k) && !k.startsWith('contend:'));
console.log(`Contention: limited lamps in stock=${lampBefore}, purchases succeeded=${lampWins} (must equal min(stock, players)=${Math.min(lampBefore, PLAYERS)}: ${lampWins === Math.min(lampBefore, PLAYERS) ? 'OK' : 'FAIL'})`);
if (rentWins !== null) console.log(`Contention: ${PLAYERS} players raced for one property, winners=${rentWins} (must be 1: ${rentWins === 1 ? 'OK' : 'FAIL'})`);
const adminEmail = arg('admin-email'), adminPw = arg('admin-password');
let integ = 'skipped (pass --admin-email/--admin-password to check)';
if (adminEmail) {
  const l = await call('admin:login', 'POST', '/v1/auth/login', { email: adminEmail, password: adminPw });
  const r = await call('admin:integrity', 'GET', '/v1/admin/ledger-integrity', undefined, { authorization: `Bearer ${l.json?.token}` });
  integ = JSON.stringify(r.json);
}
console.log('Ledger integrity after test:', integ);
console.log(bad.length ? `\nUNEXPECTED errors (status 0 or 5xx): ${JSON.stringify(bad)}` : '\nNo transport errors or 5xx responses.');
const fail = bad.length || lampWins !== Math.min(lampBefore, PLAYERS) || (rentWins !== null && rentWins !== 1) || (adminEmail && !integ.includes('"ok":true'));
process.exit(fail ? 1 : 0);

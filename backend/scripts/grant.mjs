// Development helper: give a character some MVC so you can try buying a house.
//   npm run grant -- "Character Name" 20000          (the game server must be running; max 10,000 per call, call again for more)
// Only works while the server is NOT in production mode (the /dev routes do not exist in production).
import { readFileSync } from 'node:fs';
import pg from 'pg';
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const [name, amountArg] = process.argv.slice(2);
if (!name || !amountArg) { console.error('Usage: npm run grant -- "Character Name" 20000'); process.exit(1); }
let left = Number(amountArg);
if (!Number.isInteger(left) || left < 1) { console.error('Amount must be a whole number of MVC (1 MVC = N100).'); process.exit(1); }
const db = new pg.Client({ connectionString: env.DATABASE_URL }); await db.connect();
const row = (await db.query('SELECT id, display_name FROM characters WHERE lower(display_name)=lower($1)', [name])).rows[0]; await db.end();
if (!row) { console.error(`No character called "${name}".`); process.exit(1); }
const base = `http://localhost:${env.PORT ?? 3000}`;
while (left > 0) {
  const n = Math.min(left, 10_000);
  const r = await fetch(`${base}/v1/dev/grant`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-server-key': env.SERVER_API_KEY }, body: JSON.stringify({ characterId: row.id, amount: n }) });
  if (!r.ok) { console.error(`The server said ${r.status}. Is it running, and not in production mode?`); process.exit(1); }
  left -= n;
}
console.log(`Gave ${row.display_name} ${amountArg} MVC. Tap the phone or reload to see it.`);

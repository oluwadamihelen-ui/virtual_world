// One-time local setup: writes backend/.env (with fresh random secrets) and creates the PostgreSQL role + databases.
// Usage: npm run setup      (asks for the PostgreSQL "postgres" password you chose when installing PostgreSQL)
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import pg from 'pg';

const DB_USER = 'mvw', DB_PASS = 'mvw_dev_password'; // local development only
const host = process.env.PGHOST ?? 'localhost', port = Number(process.env.PGPORT ?? 5432);

if (!existsSync('.env')) {
  const env = readFileSync('.env.example', 'utf8')
    .replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${randomBytes(32).toString('hex')}`)
    .replace(/^SERVER_API_KEY=.*$/m, `SERVER_API_KEY=${randomBytes(24).toString('hex')}`);
  writeFileSync('.env', env);
  console.log('✔ Created .env with new random secret keys');
} else {
  console.log('• .env already exists – leaving it alone');
}

let superPass = process.env.PGSUPERPASS;
if (superPass === undefined) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  superPass = await rl.question('Type the PostgreSQL "postgres" password you chose when you installed PostgreSQL, then press Enter: ');
  rl.close();
}

const admin = new pg.Client({ host, port, user: 'postgres', password: superPass, database: 'postgres' });
try { await admin.connect(); } catch (e) {
  console.error(`\n✘ Could not log in to PostgreSQL (${e.code ?? e.message}).\n  Is PostgreSQL running, and is that the right password?`);
  process.exit(1);
}
const exists = async (q, v) => (await admin.query(q, v)).rowCount > 0;
if (!(await exists('SELECT 1 FROM pg_roles WHERE rolname=$1', [DB_USER]))) {
  await admin.query(`CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}' CREATEDB`);
  console.log(`✔ Created database user "${DB_USER}"`);
}
for (const db of ['mvw_dev', 'mvw_test']) {
  if (!(await exists('SELECT 1 FROM pg_database WHERE datname=$1', [db]))) {
    await admin.query(`CREATE DATABASE ${db} OWNER ${DB_USER}`);
    console.log(`✔ Created database ${db}`);
  } else console.log(`• Database ${db} already exists`);
}
await admin.end();
console.log('\nAll set! Next:  npm run dev   then open http://localhost:3000/dev');

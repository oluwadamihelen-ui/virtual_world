// Promote/demote an account:  npm run set-role -- someone@example.com admin     (roles: player | moderator | admin)
// This is intentionally a local command, not an API: nobody can grant themselves power over the network.
import { existsSync } from 'node:fs';
import pg from 'pg';
if (existsSync('.env')) process.loadEnvFile('.env');
const [email, role] = process.argv.slice(2);
if (!email || !['player', 'moderator', 'admin'].includes(role ?? '')) {
  console.error('Usage: npm run set-role -- <email> <player|moderator|admin>'); process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const r = await pool.query('UPDATE accounts SET role=$2 WHERE lower(email)=lower($1) RETURNING id', [email, role]);
if (r.rowCount === 0) { console.error('No account with that email. Register it first.'); await pool.end(); process.exit(1); }
await pool.query('INSERT INTO audit_log (actor_account_id, action, target_type, target_id, detail) VALUES (NULL,$1,$2,$3,$4)',
  ['role.set_by_operator', 'account', r.rows[0].id, JSON.stringify({ role })]);
console.log(`✔ ${email} is now: ${role}`);
await pool.end();

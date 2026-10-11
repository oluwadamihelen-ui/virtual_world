import { loadEnvFile } from './env.js';
import { loadConfig } from './config.js';
import { loadGameData } from './gamedata.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { syncGameData } from './seed.js';
import { buildApp } from './app.js';
import { Gateway } from './realtime/gateway.js';
import { sweepTenancies } from './modules/housing/housing.js';
import { simulateNpcCustomers } from './modules/commerce/business.js';

loadEnvFile();
const config = loadConfig();
const data = loadGameData(config.gameDataDir);
const pool = createPool(config.DATABASE_URL);
const ctx = { pool, config, data, now: () => new Date() };

try {
  await migrate(pool);
} catch (err: any) {
  if (err?.code === 'ECONNREFUSED' || err?.code === '28P01' || err?.code === '3D000') {
    console.error('\nCould not use the database. Is PostgreSQL running, and do DATABASE_URL in .env and the database name/password match what you created?');
    console.error(`(technical detail: ${err.code} ${err.message})\n`);
    process.exit(1);
  }
  throw err;
}
await syncGameData(pool, data);
const rateLimitOn = config.NODE_ENV === 'production' || config.RATE_LIMIT_DISABLED !== '1';
if (!rateLimitOn) console.warn('WARNING: rate limiting is DISABLED (load-test mode)');
const app = await buildApp(ctx, { rateLimit: rateLimitOn });

const gateway = new Gateway(ctx);
gateway.attach(app.server);
gateway.start();

const timer = setInterval(() => {
  sweepTenancies(ctx).catch((err) => app.log.error({ err }, 'tenancy sweep failed'));
}, 60_000);

const npcTimer = setInterval(() => {
  const tickId = new Date().toISOString().slice(0, 16); // one tick id per minute keeps sales idempotent across instances
  simulateNpcCustomers(ctx, tickId).catch((err) => app.log.error({ err }, 'npc customer tick failed'));
}, data.businesses.npcDemand.tickSeconds * 1000);

const shutdown = async () => { clearInterval(timer); clearInterval(npcTimer); await gateway.close(); await app.close(); await pool.end(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (e: any) {
  if (e?.code === 'EADDRINUSE') {
    console.error(`\n✘ Port ${config.PORT} is already in use: an older copy of the game server is probably still running.\n  Fix 1: close the other black window (or press Ctrl+C in it), then run  npm run dev  again.\n  Fix 2: use another port. In backend\\.env change PORT=${config.PORT} to PORT=3001, then open http://localhost:3001/play\n  (Windows: to find what uses the port, run  netstat -ano | findstr :${config.PORT}  then  taskkill /PID <number> /F)\n`);
    process.exit(1);
  }
  throw e;
}
console.log(`\nMy Virtual World is running.\n  Play the game:  http://localhost:${config.PORT}/play\n  Moderators:     http://localhost:${config.PORT}/mod\n`);

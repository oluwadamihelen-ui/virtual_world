import { loadEnvFile } from './env.js';
import { loadConfig } from './config.js';
import { loadGameData } from './gamedata.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { syncGameData } from './seed.js';
import { buildApp } from './app.js';
import { sweepTenancies } from './modules/housing/housing.js';

loadEnvFile();
const config = loadConfig();
const data = loadGameData(config.gameDataDir);
const pool = createPool(config.DATABASE_URL);
const ctx = { pool, config, data, now: () => new Date() };

await migrate(pool);
await syncGameData(pool, data);
const app = await buildApp(ctx);

const timer = setInterval(() => {
  sweepTenancies(ctx).catch((err) => app.log.error({ err }, 'tenancy sweep failed'));
}, 60_000);

const shutdown = async () => { clearInterval(timer); await app.close(); await pool.end(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });

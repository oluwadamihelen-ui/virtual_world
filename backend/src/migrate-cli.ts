import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { loadEnvFile } from './env.js';

loadEnvFile();
const pool = createPool(loadConfig().DATABASE_URL);
const applied = await migrate(pool);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
await pool.end();

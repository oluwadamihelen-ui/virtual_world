import { existsSync } from 'node:fs';

/** Load .env if present (Node >= 20.12). Real environment variables win. */
export function loadEnvFile(path = '.env') {
  if (existsSync(path)) process.loadEnvFile(path);
}

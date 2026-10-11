import { z } from 'zod';
import { resolve } from 'node:path';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SERVER_API_KEY: z.string().min(24, 'SERVER_API_KEY must be at least 24 characters'),
  // Optional separate key for encrypting direct messages at rest (falls back to a key derived from JWT_SECRET).
  MESSAGE_KEY: z.string().min(32).optional(),
  GAME_DATA_DIR: z.string().default('../game-data'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  // Load-testing aid only. Ignored (forced off) when NODE_ENV=production.
  RATE_LIMIT_DISABLED: z.enum(['0', '1']).default('0'),
});
export type Config = z.infer<typeof Env> & { gameDataDir: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error('Invalid configuration:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && /change-me/.test(cfg.JWT_SECRET + cfg.SERVER_API_KEY)) {
    throw new Error('Refusing to start in production with placeholder secrets');
  }
  return { ...cfg, gameDataDir: resolve(cfg.GAME_DATA_DIR) };
}

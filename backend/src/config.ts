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
  // Wallet top-ups. All optional: a provider is offered to players only when its keys are set. Never commit real keys.
  PUBLIC_BASE_URL: z.string().url().optional(),                 // where players' browsers can reach this server, e.g. https://play.example.com (used for payment return pages)
  PAYSTACK_SECRET_KEY: z.string().min(8).optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().min(8).optional(),
  FLUTTERWAVE_SECRET_HASH: z.string().min(8).optional(),        // the 'secret hash' you set for webhooks in the Flutterwave dashboard
  KORAPAY_SECRET_KEY: z.string().min(8).optional(),
  MANUAL_TOPUP_INSTRUCTIONS: z.string().max(600).optional(),    // e.g. "Zenith Bank, 0123456789, My Virtual World Ltd" shown to players who pay by transfer
  // Set to 1 when the server sits behind ONE reverse proxy (Render, Railway, Fly, nginx, Cloudflare...) so each player's real IP is used for rate limits and connection caps.
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
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

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { AppContext } from '../../context.js';

/**
 * Direct messages are encrypted at rest (AES-256-GCM) so a database dump, backup or a casual look at the tables does not
 * reveal them. This is NOT end-to-end encryption: the game server holds the key and can decrypt. The key comes from
 * MESSAGE_KEY if set (recommended in production), otherwise it is derived from JWT_SECRET.
 */
const keys = new WeakMap<object, Buffer>();
function keyFor(ctx: AppContext): Buffer {
  let k = keys.get(ctx.config);
  if (!k) {
    const src = (ctx.config as any).MESSAGE_KEY || ctx.config.JWT_SECRET;
    k = Buffer.from(hkdfSync('sha256', src, 'mvw-message-salt', 'mvw-direct-messages-v1', 32));
    keys.set(ctx.config, k);
  }
  return k;
}
export function seal(ctx: AppContext, plain: string): string {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyFor(ctx), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
export function open(ctx: AppContext, stored: string): string {
  if (!stored.startsWith('v1:')) return stored; // legacy plaintext
  try {
    const b = Buffer.from(stored.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', keyFor(ctx), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return '[message could not be decrypted]'; }
}

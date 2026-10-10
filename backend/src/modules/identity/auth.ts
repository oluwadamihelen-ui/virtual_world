import { SignJWT, jwtVerify } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import { forbidden, unauthorized } from '../../errors.js';

export type Role = 'player' | 'moderator' | 'admin';
export interface AuthUser { accountId: string; role: Role }

const key = (c: Config) => new TextEncoder().encode(c.JWT_SECRET);

export async function signToken(c: Config, u: AuthUser): Promise<string> {
  return new SignJWT({ role: u.role }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.accountId)
    .setIssuedAt().setExpirationTime('12h').sign(key(c));
}

export async function authenticate(c: Config, req: FastifyRequest): Promise<AuthUser> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  try {
    const { payload } = await jwtVerify(h.slice(7), key(c), { algorithms: ['HS256'] });
    return { accountId: payload.sub!, role: payload.role as Role };
  } catch { throw unauthorized('invalid_token'); }
}

export function requireRole(u: AuthUser, ...roles: Role[]) {
  if (!roles.includes(u.role)) throw forbidden();
}

/** The dedicated game server authenticates with a shared secret; game clients never hold it. */
export function requireGameServer(c: Config, req: FastifyRequest) {
  const given = Buffer.from(String(req.headers['x-server-key'] ?? ''));
  const want = Buffer.from(c.SERVER_API_KEY);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw unauthorized('invalid_server_key');
}

import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { withTx } from '../../db.js';
import { unauthorized, conflict } from '../../errors.js';
import { assertCanAct } from './service.js';

/**
 * Join tickets bind a game-server connection to a character the player provably owns.
 * Flow: client (player JWT) asks for a ticket -> client presents it to the dedicated server on connect ->
 * server redeems it here (single use, 60s lifetime) and only then trusts the characterId.
 * The ticket is signed with a key derived from JWT_SECRET and carries a distinct audience, so a normal
 * login token can never be used as a ticket (and vice versa).
 */
const AUD = 'mvw-join-ticket';
const TTL_SECONDS = 60;
const key = (ctx: AppContext) => new TextEncoder().encode('join-ticket:' + ctx.config.JWT_SECRET);

export async function issueTicket(ctx: AppContext, accountId: string, characterId: string) {
  const now = Math.floor(ctx.now().getTime() / 1000);
  const jti = randomUUID();
  const ticket = await new SignJWT({ acct: accountId }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(characterId).setAudience(AUD).setJti(jti).setIssuedAt(now).setExpirationTime(now + TTL_SECONDS).sign(key(ctx));
  return { ticket, expiresInSeconds: TTL_SECONDS };
}

export async function redeemTicket(ctx: AppContext, ticket: string): Promise<{ characterId: string; accountId: string }> {
  let payload;
  try {
    ({ payload } = await jwtVerify(ticket, key(ctx), { audience: AUD, algorithms: ['HS256'], currentDate: ctx.now() }));
  } catch { throw unauthorized('invalid_ticket'); }
  const characterId = payload.sub!, jti = payload.jti!;
  await withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const r = await tx.query('INSERT INTO join_tickets_used (jti, character_id, used_at) VALUES ($1,$2,$3) ON CONFLICT (jti) DO NOTHING', [jti, characterId, ctx.now()]);
    if (r.rowCount === 0) throw conflict('ticket_already_used', 'This join ticket was already used');
  });
  return { characterId, accountId: payload.acct as string };
}

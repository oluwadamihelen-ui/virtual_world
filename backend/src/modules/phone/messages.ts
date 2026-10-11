import type { AppContext } from '../../context.js';
import { AppError, badRequest } from '../../errors.js';
import { checkChat, isBlockedEitherWay } from '../social/social.js';
import { assertCanAct } from '../identity/service.js';
import { withTx } from '../../db.js';
import { seal, open } from './secret.js';
import { assertSameAgeGroup, findByName, nameOf } from './common.js';

export async function send(ctx: AppContext, fromId: string, toName: string | undefined, toId: string | undefined, text: string) {
  const to = toId ? { id: toId, name: await nameOf(ctx, toId) } : await findByName(ctx, toName ?? '');
  if (to.id === fromId) throw badRequest('cannot_message_self', 'You cannot message yourself.');
  if (await isBlockedEitherWay(ctx, fromId, to.id)) throw new AppError(403, 'blocked', 'You cannot message this player.');
  await assertSameAgeGroup(ctx, fromId, to.id);
  const chk = await checkChat(ctx, fromId, String(text ?? '').slice(0, ctx.data.phone.messages.maxLength + 1));
  if (!chk.allowed) throw new AppError(429, chk.reason === 'rate_limited' ? 'slow_down' : `message_${chk.reason}`, chk.reason === 'rate_limited' ? 'Slow down a little.' : undefined);
  if (chk.text.length > ctx.data.phone.messages.maxLength) throw badRequest('message_too_long');
  const row = await withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, fromId);
    return (await tx.query('INSERT INTO direct_messages (from_id,to_id,body,created_at) VALUES ($1,$2,$3,$4) RETURNING id, created_at', [fromId, to.id, seal(ctx, chk.text), ctx.now()])).rows[0];
  });
  return { id: Number(row.id), toId: to.id, to: to.name, body: chk.text, at: (row.created_at as Date).toISOString(), filtered: chk.filtered };
}

export async function inbox(ctx: AppContext, me: string) {
  const r = await ctx.pool.query(
    `WITH last AS (
       SELECT DISTINCT ON (other) other, body, created_at, from_id FROM (
         SELECT CASE WHEN from_id=$1 THEN to_id ELSE from_id END AS other, body, created_at, from_id, id FROM direct_messages WHERE from_id=$1 OR to_id=$1
       ) m ORDER BY other, id DESC)
     SELECT l.other, c.display_name, l.body, l.created_at, l.from_id,
            (SELECT COUNT(*) FROM direct_messages d WHERE d.to_id=$1 AND d.from_id=l.other AND d.read_at IS NULL)::int AS unread
       FROM last l JOIN characters c ON c.id=l.other
       WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=l.other) OR (b.blocker_id=l.other AND b.blocked_id=$1))
       ORDER BY l.created_at DESC LIMIT 50`, [me]);
  return r.rows.map((x) => ({ id: x.other as string, name: x.display_name as string, last: open(ctx, x.body as string), mine: x.from_id === me, at: (x.created_at as Date).toISOString(), unread: x.unread as number }));
}

export async function thread(ctx: AppContext, me: string, other: string) {
  if (await isBlockedEitherWay(ctx, me, other)) throw new AppError(403, 'blocked');
  await ctx.pool.query('UPDATE direct_messages SET read_at=$3 WHERE to_id=$1 AND from_id=$2 AND read_at IS NULL', [me, other, ctx.now()]);
  const r = await ctx.pool.query(
    `SELECT id, from_id, body, created_at FROM direct_messages WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1) ORDER BY id DESC LIMIT 60`, [me, other]);
  return { with: { id: other, name: await nameOf(ctx, other) }, messages: r.rows.reverse().map((x) => ({ mine: x.from_id === me, body: open(ctx, x.body as string), at: (x.created_at as Date).toISOString() })) };
}

export async function unreadCount(ctx: AppContext, me: string): Promise<number> {
  return (await ctx.pool.query(
    `SELECT COUNT(*)::int AS n FROM direct_messages d WHERE d.to_id=$1 AND d.read_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=d.from_id) OR (b.blocker_id=d.from_id AND b.blocked_id=$1))`, [me])).rows[0].n;
}

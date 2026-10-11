import type { AppContext } from '../../context.js';
import type { Tx } from '../../db.js';
import { badRequest, notFound, forbidden } from '../../errors.js';

// ---------- Achievements & reputation (unlock choices, not just numbers) ----------
export async function awardAchievement(ctx: AppContext, tx: Tx, characterId: string, achievementId: string): Promise<boolean> {
  const def = ctx.data.achievements.find((a) => a.id === achievementId);
  if (!def) throw new Error(`unknown achievement ${achievementId}`);
  const r = await tx.query(
    'INSERT INTO achievements (character_id, achievement_id, earned_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [characterId, achievementId, ctx.now()],
  );
  if (r.rowCount === 1 && def.reputation) {
    await tx.query('UPDATE characters SET reputation = reputation + $2 WHERE id=$1', [characterId, def.reputation]);
  }
  return r.rowCount === 1;
}

export async function listAchievements(tx: Pick<Tx, 'query'>, characterId: string) {
  const r = await tx.query('SELECT achievement_id, earned_at FROM achievements WHERE character_id=$1 ORDER BY earned_at', [characterId]);
  return r.rows.map((x) => ({ achievementId: x.achievement_id as string, earnedAt: x.earned_at as Date }));
}

// ---------- Blocking ----------
export async function block(ctx: AppContext, blockerId: string, blockedId: string) {
  if (blockerId === blockedId) throw badRequest('cannot_block_self');
  const t = await ctx.pool.query('SELECT 1 FROM characters WHERE id=$1', [blockedId]);
  if (t.rowCount === 0) throw notFound('character_not_found');
  await ctx.pool.query('INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [blockerId, blockedId, ctx.now()]);
  return { blocked: blockedId };
}
export async function unblock(ctx: AppContext, blockerId: string, blockedId: string) {
  await ctx.pool.query('DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [blockerId, blockedId]);
  return { unblocked: blockedId };
}
export async function listBlocks(ctx: AppContext, blockerId: string) {
  const r = await ctx.pool.query('SELECT c.id, c.display_name FROM blocks b JOIN characters c ON c.id=b.blocked_id WHERE b.blocker_id=$1 ORDER BY b.created_at', [blockerId]);
  return r.rows.map((x) => ({ characterId: x.id as string, displayName: x.display_name as string }));
}
/** True if either side has blocked the other. The game server must check this before delivering chat or interactions. */
export async function isBlockedEitherWay(ctx: AppContext, a: string, b: string): Promise<boolean> {
  const r = await ctx.pool.query('SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1', [a, b]);
  return (r.rowCount ?? 0) > 0;
}

/** Can this character speak right now? Used by voice chat: suspended, banned and moderator-muted accounts cannot. */
export async function canSpeak(ctx: AppContext, characterId: string): Promise<{ ok: true } | { ok: false; reason: 'muted' | 'suspended' }> {
  const a = (await ctx.pool.query(`SELECT a.status, a.suspended_until, a.muted_until FROM characters c JOIN accounts a ON a.id=c.account_id WHERE c.id=$1`, [characterId])).rows[0];
  if (!a) throw notFound('character_not_found');
  const now = ctx.now();
  if (a.status === 'banned' || (a.status === 'suspended' && (!a.suspended_until || a.suspended_until > now))) return { ok: false, reason: 'suspended' };
  if (a.muted_until && a.muted_until > now) return { ok: false, reason: 'muted' };
  return { ok: true };
}

// ---------- Chat checks (the game server calls this before broadcasting) ----------
const recent = new Map<string, number[]>(); // per-process sliding window; move to Redis when running >1 backend instance

export function maskBlockedWords(text: string, words: string[]): { text: string; filtered: boolean } {
  let out = text, filtered = false;
  for (const w of words) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
    out = out.replace(re, (m) => { filtered = true; return '*'.repeat(m.length); });
  }
  return { text: out, filtered };
}

export async function checkChat(ctx: AppContext, characterId: string, rawText: string) {
  const cfg = ctx.data.chat;
  const acct = (await ctx.pool.query(
    `SELECT a.status, a.suspended_until, a.muted_until FROM characters c JOIN accounts a ON a.id=c.account_id WHERE c.id=$1`, [characterId])).rows[0];
  if (!acct) throw notFound('character_not_found');
  const now = ctx.now();
  if (acct.status === 'banned' || (acct.status === 'suspended' && (!acct.suspended_until || acct.suspended_until > now))) throw forbidden('account_suspended');
  if (acct.muted_until && acct.muted_until > now) return { allowed: false as const, reason: 'muted', mutedUntil: (acct.muted_until as Date).toISOString() };

  const text = rawText.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!text) return { allowed: false as const, reason: 'empty' };
  if (text.length > cfg.maxLength) return { allowed: false as const, reason: 'too_long' };

  const windowMs = cfg.windowSeconds * 1000;
  const hits = (recent.get(characterId) ?? []).filter((t) => now.getTime() - t < windowMs);
  if (hits.length >= cfg.messagesPerWindow) { recent.set(characterId, hits); return { allowed: false as const, reason: 'rate_limited' }; }
  hits.push(now.getTime());
  recent.set(characterId, hits);

  const m = maskBlockedWords(text, cfg.blockedWords);
  return { allowed: true as const, text: m.text, filtered: m.filtered };
}

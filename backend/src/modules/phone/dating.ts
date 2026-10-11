import type { AppContext } from '../../context.js';
import { AppError, badRequest } from '../../errors.js';
import { assertAdult } from '../identity/service.js';
import { maskBlockedWords } from '../social/social.js';
import { withTx } from '../../db.js';
import { nameOf } from './common.js';

/** Dating ("Spark"): adults only, both sides. No exact age, no location beyond city, no photos, text is filtered. */
export async function myProfile(ctx: AppContext, me: string) {
  const r = (await ctx.pool.query('SELECT bio, looking_for, interests, active FROM dating_profiles WHERE character_id=$1', [me])).rows[0];
  return r ? { bio: r.bio as string, lookingFor: r.looking_for as string, interests: r.interests as string[], active: r.active as boolean } : null;
}

export async function saveProfile(ctx: AppContext, me: string, input: { bio: string; lookingFor: string; interests: string[] }) {
  const cfg = ctx.data.phone.dating;
  const bio = String(input.bio ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (bio.length < 3) throw badRequest('bio_required', 'Write a short bio (at least 3 characters).');
  if (bio.length > cfg.bioMaxLength) throw badRequest('bio_too_long');
  if (maskBlockedWords(bio, ctx.data.chat.blockedWords).filtered) throw badRequest('bio_not_allowed', 'Please keep your bio friendly and clean.');
  if (!cfg.lookingFor.includes(input.lookingFor)) throw badRequest('invalid_choice');
  const interests = [...new Set(input.interests ?? [])].filter((i) => cfg.interests.includes(i)).slice(0, 5);
  await ctx.pool.query(
    `INSERT INTO dating_profiles (character_id,bio,looking_for,interests,active,created_at) VALUES ($1,$2,$3,$4,true,$5)
     ON CONFLICT (character_id) DO UPDATE SET bio=EXCLUDED.bio, looking_for=EXCLUDED.looking_for, interests=EXCLUDED.interests, active=true`,
    [me, bio, input.lookingFor, interests, ctx.now()]);
  return myProfile(ctx, me);
}

export async function setActive(ctx: AppContext, me: string, active: boolean) {
  await ctx.pool.query('UPDATE dating_profiles SET active=$2 WHERE character_id=$1', [me, active]);
}

/** Deletes the profile and every swipe/match involving this player (privacy: right to delete). */
export async function deleteProfile(ctx: AppContext, me: string) {
  await withTx(ctx.pool, async (tx) => {
    await tx.query('DELETE FROM dating_swipes WHERE from_id=$1 OR to_id=$1', [me]);
    await tx.query('DELETE FROM dating_profiles WHERE character_id=$1', [me]);
  });
}

export async function discover(ctx: AppContext, me: string) {
  const cfg = ctx.data.phone.dating;
  const r = await ctx.pool.query(
    `SELECT p.character_id, c.display_name, c.appearance, c.reputation, c.city, p.bio, p.looking_for, p.interests
       FROM dating_profiles p JOIN characters c ON c.id=p.character_id JOIN accounts a ON a.id=c.account_id
      WHERE p.active AND p.character_id <> $1
        AND a.birth_date IS NOT NULL AND a.birth_date <= ($2::date - interval '18 years')
        AND a.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM dating_swipes s WHERE s.from_id=$1 AND s.to_id=p.character_id)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=p.character_id) OR (b.blocker_id=p.character_id AND b.blocked_id=$1))
      ORDER BY random() LIMIT $3`, [me, ctx.now(), cfg.discoverBatch]);
  return r.rows.map((x) => ({
    id: x.character_id as string, name: x.display_name as string, appearance: x.appearance, reputation: x.reputation as number,
    city: ctx.data.cityById.get(x.city)?.name ?? '', bio: x.bio as string, lookingFor: x.looking_for as string, interests: x.interests as string[],
  }));
}

export async function swipe(ctx: AppContext, me: string, targetId: string, like: boolean) {
  if (me === targetId) throw badRequest('invalid_target');
  const t = (await ctx.pool.query(
    `SELECT p.active, a.birth_date IS NOT NULL AND a.birth_date <= ($2::date - interval '18 years') AS adult
       FROM dating_profiles p JOIN characters c ON c.id=p.character_id JOIN accounts a ON a.id=c.account_id WHERE p.character_id=$1`, [targetId, ctx.now()])).rows[0];
  if (!t || !t.active || !t.adult) throw badRequest('profile_unavailable', 'This profile is not available.');
  const today = (await ctx.pool.query(`SELECT COUNT(*)::int AS n FROM dating_swipes WHERE from_id=$1 AND created_at > $2`, [me, new Date(ctx.now().getTime() - 86400_000)])).rows[0].n;
  if (today >= ctx.data.phone.dating.likesPerDay) throw new AppError(429, 'swipe_limit', 'That is enough for today. Come back tomorrow!');
  await ctx.pool.query('INSERT INTO dating_swipes (from_id,to_id,liked,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (from_id,to_id) DO NOTHING', [me, targetId, like, ctx.now()]);
  let matched = false;
  if (like) matched = (await ctx.pool.query('SELECT 1 FROM dating_swipes WHERE from_id=$1 AND to_id=$2 AND liked', [targetId, me])).rowCount === 1;
  return { matched, name: matched ? await nameOf(ctx, targetId) : undefined, id: targetId };
}

export async function matches(ctx: AppContext, me: string) {
  const r = await ctx.pool.query(
    `SELECT c.id, c.display_name, c.appearance, p.bio, p.looking_for FROM dating_swipes a
       JOIN dating_swipes b ON b.from_id=a.to_id AND b.to_id=a.from_id AND b.liked
       JOIN characters c ON c.id=a.to_id
       LEFT JOIN dating_profiles p ON p.character_id=c.id
      WHERE a.from_id=$1 AND a.liked
        AND NOT EXISTS (SELECT 1 FROM blocks k WHERE (k.blocker_id=$1 AND k.blocked_id=c.id) OR (k.blocker_id=c.id AND k.blocked_id=$1))
      ORDER BY a.created_at DESC`, [me]);
  return r.rows.map((x) => ({ id: x.id as string, name: x.display_name as string, appearance: x.appearance, bio: x.bio as string | null, lookingFor: x.looking_for as string | null }));
}

export async function unmatch(ctx: AppContext, me: string, other: string) {
  await ctx.pool.query('UPDATE dating_swipes SET liked=false WHERE from_id=$1 AND to_id=$2', [me, other]);
}

export const assertDatingAllowed = (ctx: AppContext, me: string) => assertAdult(ctx, me);

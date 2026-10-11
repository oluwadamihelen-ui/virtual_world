import type { AppContext } from '../../context.js';
import { AppError, badRequest, notFound } from '../../errors.js';
import { characterAgeBand } from '../identity/service.js';

export interface Who { id: string; name: string }

/** Find a character by exact display name (case-insensitive). */
export async function findByName(ctx: AppContext, name: string): Promise<Who> {
  const n = String(name ?? '').trim();
  if (!n) throw badRequest('player_required', 'Type a player name.');
  const r = await ctx.pool.query('SELECT id, display_name FROM characters WHERE lower(display_name)=lower($1)', [n]);
  if (!r.rows[0]) throw notFound('player_not_found');
  return { id: r.rows[0].id, name: r.rows[0].display_name };
}

export async function nameOf(ctx: AppContext, id: string): Promise<string> {
  const r = await ctx.pool.query('SELECT display_name FROM characters WHERE id=$1', [id]);
  return r.rows[0]?.display_name ?? 'Unknown';
}

/**
 * Safety rule: adults and under-18s (or players with no date of birth) are never connected by DMs or money transfers.
 * Both sides must be in the same group.
 */
export async function assertSameAgeGroup(ctx: AppContext, a: string, b: string) {
  const [x, y] = await Promise.all([characterAgeBand(ctx, a), characterAgeBand(ctx, b)]);
  if ((x === 'adult') !== (y === 'adult')) {
    throw new AppError(403, 'age_group_mismatch', 'For safety, you can only connect with players in your own age group.');
  }
}

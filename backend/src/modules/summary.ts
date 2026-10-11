import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { balanceOf } from './economy/ledger.js';
import { listInventory } from './inventory/inventory.js';
import { listAchievements } from './social/social.js';
import { currencyOfCity } from './economy/currency.js';
import { currentTenancy, listFurniture } from './housing/housing.js';

/** Read model the game server loads on join/reconnect and tests use to verify persistence. */
export async function characterSummary(ctx: AppContext, characterId: string) {
  const q = ctx.pool;
  const c = (await q.query('SELECT id, display_name, appearance, district, city, travel_to, travel_until, pos_x, pos_y, pos_z, pos_rev, reputation, created_at FROM characters WHERE id=$1', [characterId])).rows[0];
  if (!c) throw notFound('character_not_found');
  const shift = (await q.query(`SELECT id, job_id, tasks_done, tasks_required FROM shifts WHERE character_id=$1 AND status='in_progress'`, [characterId])).rows[0];
  const skills = (await q.query('SELECT skill_id, xp FROM skills WHERE character_id=$1 ORDER BY skill_id', [characterId])).rows;
  return {
    characterId: c.id as string, displayName: c.display_name as string, appearance: c.appearance, reputation: c.reputation as number,
    city: c.city as string, currency: currencyOfCity(ctx.data, c.city),
    travel: c.travel_to ? { to: c.travel_to as string, arrivesAt: (c.travel_until as Date).toISOString() } : null,
    location: { district: c.district as string, city: c.city as string, x: c.pos_x as number, y: c.pos_y as number, z: c.pos_z as number, posRev: c.pos_rev as number },
    balance: await balanceOf(q, characterId),
    inventory: await listInventory(q, characterId),
    tenancy: await currentTenancy(q, characterId),
    furniture: await listFurniture(q, characterId),
    activeShift: shift ? { shiftId: shift.id as string, jobId: shift.job_id as string, tasksDone: shift.tasks_done as number, tasksRequired: shift.tasks_required as number } : null,
    achievements: await listAchievements(q, characterId),
    businesses: (await q.query(`SELECT id, name, type FROM businesses WHERE owner_character_id=$1 AND status='open' ORDER BY created_at`, [characterId])).rows.map((b) => ({ businessId: b.id as string, name: b.name as string, type: b.type as string })),
    skills: skills.map((s) => ({ skillId: s.skill_id as string, xp: s.xp as number })),
  };
}

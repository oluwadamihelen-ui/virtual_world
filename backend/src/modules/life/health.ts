import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { badRequest, conflict } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { payBill, coverShare, settlePremiums } from './bills.js';

const HOUR = 3600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Current health, with time-based decay applied and saved. Offline time counts, but only up to maxDecayHours. */
export async function current(ctx: AppContext, tx: Pick<Tx, 'query'>, characterId: string): Promise<number> {
  const h = ctx.data.life.health, now = ctx.now();
  const row = (await tx.query('SELECT value, updated_at FROM character_health WHERE character_id=$1 FOR UPDATE', [characterId])).rows[0];
  if (!row) { await tx.query('INSERT INTO character_health (character_id, value, updated_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [characterId, h.start, now]); return h.start; }
  const hours = Math.min(Math.max((now.getTime() - new Date(row.updated_at).getTime()) / HOUR, 0), h.maxDecayHours);
  const v = Math.max(0, Number(row.value) - hours * h.decayPerHour);
  await tx.query('UPDATE character_health SET value=$2, updated_at=$3 WHERE character_id=$1', [characterId, v, now]);
  return v;
}
const setValue = (ctx: AppContext, tx: Pick<Tx, 'query'>, id: string, v: number) =>
  tx.query('UPDATE character_health SET value=$2, updated_at=$3 WHERE character_id=$1', [id, Math.max(0, Math.min(ctx.data.life.health.max, v)), ctx.now()]);

export const stateOf = (ctx: AppContext, v: number) => {
  const h = ctx.data.life.health;
  return { value: round1(v), max: h.max, label: v >= 70 ? 'Healthy' : v >= h.minToWork ? 'Tired' : 'Unwell', canWork: v >= h.minToWork, slow: v < h.slowBelow };
};

/** Used by jobs: you cannot start a shift when unwell, and a finished shift tires you out. */
export async function assertFitForWork(ctx: AppContext, tx: Tx, characterId: string) {
  const v = await current(ctx, tx, characterId);
  if (v < ctx.data.life.health.minToWork) throw conflict('too_unwell', 'You are too unwell to work. Rest or get treated in the Health app.');
}
export async function tireFromShift(ctx: AppContext, tx: Tx, characterId: string) {
  const v = await current(ctx, tx, characterId); await setValue(ctx, tx, characterId, v - ctx.data.life.health.shiftCost);
}

/** Price of a treatment right now for someone standing at `at` (a building type such as 'hospital', or null outdoors). */
const feeFor = (ctx: AppContext, t: { fee: number; discountAt: string[]; discountPercent: number }, at: string | null) =>
  Math.round(t.fee * (at && t.discountAt.includes(at) ? 1 - t.discountPercent / 100 : 1));

export async function overview(ctx: AppContext, characterId: string, at: string | null) {
  return withTx(ctx.pool, async (tx) => {
    await settlePremiums(ctx, tx, characterId);
    const v = await current(ctx, tx, characterId), cover = await coverShare(ctx, tx, characterId, 'health');
    const h = ctx.data.life.health;
    return {
      state: stateOf(ctx, v), at, coverPercent: Math.round(cover.share * 100), decayPerHour: h.decayPerHour, shiftCost: h.shiftCost, minToWork: h.minToWork,
      treatments: h.treatments.map((t) => {
        const fee = feeFor(ctx, t, at), ok = t.requiresAt.length === 0 || (!!at && t.requiresAt.includes(at));
        return { id: t.id, name: t.name, emoji: t.emoji, note: t.note, restore: t.restore, fee, youPay: Math.round(fee * (1 - cover.share)), available: ok };
      }),
    };
  });
}

export async function treat(ctx: AppContext, characterId: string, treatmentId: string, key: string, at: string | null) {
  const t = ctx.data.life.health.treatments.find((x) => x.id === treatmentId);
  if (!t) throw badRequest('unknown_treatment');
  if (t.requiresAt.length && !(at && t.requiresAt.includes(at))) throw conflict('wrong_place', 'You need to be inside a hospital or clinic for that treatment.');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const before = await current(ctx, tx, characterId);
    if (before >= ctx.data.life.health.max - 0.5) throw conflict('already_healthy', 'You are already in perfect health.');
    const bill = await payBill(ctx, tx, characterId, { amount: feeFor(ctx, t, at), sink: 'sink:medical', type: 'medical', key: `treat:${key}`, kind: 'health', refId: t.id });
    if (!bill.replay) await setValue(ctx, tx, characterId, before + t.restore);
    return { treatment: t.id, ...bill, state: stateOf(ctx, await current(ctx, tx, characterId)) };
  });
}

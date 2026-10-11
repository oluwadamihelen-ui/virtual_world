import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { claim, post, finish, playerAccount, systemAccount } from '../economy/ledger.js';
import { settlePremiums } from './bills.js';

const HOUR = 3600_000;

export function premiumFor(ctx: AppContext, plan: { premium?: number; premiumPercentOfPrice?: number }, carPrice?: number) {
  if (plan.premium) return plan.premium;
  return Math.max(1, Math.round((carPrice ?? 0) * (plan.premiumPercentOfPrice ?? 0) / 100));
}

export async function overview(ctx: AppContext, characterId: string) {
  return withTx(ctx.pool, async (tx) => {
    await settlePremiums(ctx, tx, characterId);
    const a = ctx.data.life.assurance, now = ctx.now();
    const pol = (await tx.query(`SELECT p.*, c.model_id, c.plate FROM policies p LEFT JOIN cars c ON c.id=p.car_id WHERE p.character_id=$1 AND p.status IN ('active','lapsed') ORDER BY p.started_at DESC`, [characterId])).rows;
    const cars = (await tx.query('SELECT id, model_id, plate FROM cars WHERE character_id=$1 AND sold_at IS NULL ORDER BY created_at', [characterId])).rows;
    const carModel = (id: string) => ctx.data.life.cars.models.find((m) => m.id === id)!;
    return {
      waitingHours: a.waitingHours, periodHours: a.periodHours, comingSoon: a.comingSoon,
      policies: pol.map((p) => {
        const plan = a.plans.find((x) => x.id === p.plan_id)!, ends = new Date(new Date(p.started_at).getTime() + a.waitingHours * HOUR);
        return { id: p.id as string, kind: p.kind as string, planId: p.plan_id as string, name: plan.name, coverPercent: plan.coverPercent, premium: Number(p.premium), status: p.status as string,
          paidUntil: (p.paid_until as Date).toISOString(), coverStartsAt: ends > now ? ends.toISOString() : null, car: p.car_id ? `${carModel(p.model_id).name} ${p.plate}` : null };
      }),
      plans: a.plans.map((pl) => ({ id: pl.id, kind: pl.kind, name: pl.name, blurb: pl.blurb, coverPercent: pl.coverPercent,
        premium: pl.kind === 'health' ? premiumFor(ctx, pl) : null,
        forCars: pl.kind === 'car' ? cars.map((c) => ({ carId: c.id as string, label: `${carModel(c.model_id).name} ${c.plate}`, premium: premiumFor(ctx, pl, carModel(c.model_id).price) })) : undefined })),
    };
  });
}

export async function buy(ctx: AppContext, characterId: string, planId: string, carId: string | undefined, key: string) {
  const plan = ctx.data.life.assurance.plans.find((p) => p.id === planId);
  if (!plan) throw badRequest('unknown_plan');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    let price: number | undefined;
    if (plan.kind === 'car') {
      if (!carId) throw badRequest('car_required', 'Choose which car to insure.');
      const c = (await tx.query('SELECT model_id FROM cars WHERE id=$1 AND character_id=$2 AND sold_at IS NULL', [carId, characterId])).rows[0];
      if (!c) throw notFound('car_not_found');
      price = ctx.data.life.cars.models.find((m) => m.id === c.model_id)!.price;
    }
    const premium = premiumFor(ctx, plan, price);
    // one live policy of each kind (per car): replacing means cancelling the old one first
    const clash = (await tx.query(`SELECT 1 FROM policies WHERE character_id=$1 AND kind=$2 AND status IN ('active') AND ($3::uuid IS NULL OR car_id=$3)`, [characterId, plan.kind, carId ?? null])).rowCount;
    const k = await claim(tx, { key: `policy:${key}`, type: 'insurance_premium', actorCharacterId: characterId, referenceType: 'plan', referenceId: plan.id, amount: premium, payload: { plan: plan.id, carId: carId ?? null } });
    if (k.replay) return { replayed: true };
    if (clash) throw conflict('already_covered', 'You already have cover for this. Cancel it first to switch plans.');
    await tx.query(`UPDATE policies SET status='cancelled' WHERE character_id=$1 AND kind=$2 AND status='lapsed' AND ($3::uuid IS NULL OR car_id=$3)`, [characterId, plan.kind, carId ?? null]);
    await post(tx, k.txId, [{ account: playerAccount(characterId), delta: -premium }, { account: systemAccount('sink:insurance'), delta: premium }]);
    const now = ctx.now();
    const p = (await tx.query(`INSERT INTO policies (character_id, kind, plan_id, car_id, premium, started_at, paid_until) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [characterId, plan.kind, plan.id, carId ?? null, premium, now, new Date(now.getTime() + ctx.data.life.assurance.periodHours * HOUR)])).rows[0];
    await finish(tx, k.txId, { policyId: p.id });
    return { replayed: false, policyId: p.id as string, premium };
  });
}

export async function cancel(ctx: AppContext, characterId: string, policyId: string) {
  const r = await ctx.pool.query(`UPDATE policies SET status='cancelled' WHERE id=$1 AND character_id=$2 AND status IN ('active','lapsed') RETURNING id`, [policyId, characterId]);
  if (r.rowCount === 0) throw notFound('policy_not_found');
  return { ok: true };
}
export type { Tx };

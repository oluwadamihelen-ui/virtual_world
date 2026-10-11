import type { AppContext } from '../../context.js';
import { withTx } from '../../db.js';
import { badRequest } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { claim, post, finish, playerAccount, systemAccount } from '../economy/ledger.js';

/**
 * Getting around inside a city: walk (free), bike (a small rental fee, then a speed boost for a few minutes),
 * city bus and taxi (a fare by distance, then a short journey that drops you at the door). Numbers live in geo.json.
 */
export type LocalMode = 'bus' | 'car';

export function localQuote(ctx: AppContext, meters: number) {
  const t = ctx.data.geo.localTransport;
  const m = Math.round(meters);
  const out = [{ mode: 'walk', name: t.walk.name, icon: t.walk.icon, fare: 0, seconds: Math.round(m / t.walk.metersPerSecond), available: true as boolean, reason: '' }];
  out.push({ mode: 'bike', name: t.bike.name, icon: t.bike.icon, fare: t.bike.fee, seconds: Math.round(m / (t.walk.metersPerSecond * t.bike.speedMult)), available: m >= t.bike.minMeters, reason: m >= t.bike.minMeters ? '' : 'Too close: just walk' });
  for (const k of ['bus', 'car'] as const) {
    const x = t[k];
    out.push({ mode: k, name: x.name, icon: x.icon, fare: Math.max(1, Math.round(x.base + x.perMeter * m)), seconds: Math.round(Math.min(x.maxSeconds, Math.max(x.minSeconds, m * x.secPerMeter))), available: m >= x.minMeters, reason: m >= x.minMeters ? '' : 'Too close: just walk' });
  }
  return out;
}

async function pay(ctx: AppContext, characterId: string, amount: number, type: string, key: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const c = await claim<{ paid: number }>(tx, { key: `${characterId}:${type}:${key}`, type, actorCharacterId: characterId, referenceType: 'local_transport', referenceId: type, amount, payload: { amount } });
    if (c.replay) return { paid: c.response.paid, replayed: true };
    await post(tx, c.txId, [{ account: playerAccount(characterId), delta: -amount }, { account: systemAccount('sink:transport'), delta: amount }]);
    await finish(tx, c.txId, { paid: amount });
    return { paid: amount, replayed: false };
  });
}

/** Charge a bus or taxi fare for a journey of this many metres. Returns the fare and how long the journey takes. */
export async function chargeTransit(ctx: AppContext, characterId: string, mode: LocalMode, meters: number, key: string) {
  const q = localQuote(ctx, meters).find((o) => o.mode === mode);
  if (!q) throw badRequest('unknown_mode', 'Unknown way to travel.');
  if (!q.available) throw badRequest('too_close', q.reason);
  const r = await pay(ctx, characterId, q.fare, 'local_fare', key);
  return { fare: r.paid, seconds: q.seconds };
}
/** Rent a bike: a flat fee. */
export async function chargeBike(ctx: AppContext, characterId: string, key: string) {
  const r = await pay(ctx, characterId, ctx.data.geo.localTransport.bike.fee, 'bike_rental', key);
  return { fee: r.paid, speedMult: ctx.data.geo.localTransport.bike.speedMult, seconds: ctx.data.geo.localTransport.bike.seconds };
}

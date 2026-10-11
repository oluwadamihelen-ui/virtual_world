import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { claim, post, finish, playerAccount, systemAccount } from '../economy/ledger.js';
import { currencyOfCity, formatLocal } from '../economy/currency.js';

export interface TravelOption {
  mode: string; name: string; icon: string; available: boolean; reason?: string;
  km: number; fare: number; fareText: string; seconds: number;
}

export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** All ways to get from one city to another, with the fare in MVC and in the currency of the city you're leaving. */
export function quote(ctx: AppContext, fromId: string, toId: string): TravelOption[] {
  const from = ctx.data.cityById.get(fromId), to = ctx.data.cityById.get(toId);
  if (!from || !to) throw notFound('city_not_found');
  const km = distanceKm(from, to);
  const international = from.country !== to.country;
  const cur = currencyOfCity(ctx.data, fromId);
  return ctx.data.geo.transport.filter((m) => m.intercity).map((m) => {
    let reason: string | undefined;
    if (m.domesticOnly && international) reason = 'No road or bus link across the border yet';
    else if (m.maxKm && km > m.maxKm) reason = 'Too far for this';
    else if (m.minKm && km < m.minKm) reason = 'Too close to fly';
    const fare = Math.max(1, Math.round((m.base ?? 0) + (m.perKm ?? 0) * km + (international ? (m.internationalFee ?? 0) : 0)));
    const seconds = Math.min(90, Math.max(ctx.data.geo.minTravelSeconds, Math.round(km * (m.secPerKm ?? 0.1))));
    return { mode: m.id, name: m.name, icon: m.icon, available: !reason, reason, km, fare, fareText: formatLocal(fare, cur), seconds };
  });
}

export interface TripResult { tripId: string; to: string; mode: string; fare: number; seconds: number; arrivesAt: string; replayed: boolean }

export async function startTrip(ctx: AppContext, characterId: string, toId: string, mode: string, idempotencyKey: string): Promise<TripResult> {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const ch = (await tx.query('SELECT city, travel_to, travel_until FROM characters WHERE id=$1 FOR UPDATE', [characterId])).rows[0];
    if (!ch) throw notFound('character_not_found');
    const now = ctx.now();

    const c = await claim<TripResult>(tx, {
      key: `${characterId}:trip:${idempotencyKey}`, type: 'travel_fare', actorCharacterId: characterId, referenceType: 'city', referenceId: toId,
      amount: 0 /* real amount set below */, payload: { toId, mode },
    }).catch((e) => { throw e; });
    if (c.replay) return { ...c.response, replayed: true };

    if (ch.travel_to && ch.travel_until > now) throw conflict('already_travelling', 'You are already on a journey.');
    if (ch.travel_to) await arriveTx(ctx, tx, characterId, now); // finished earlier while offline
    const here = (await tx.query('SELECT city FROM characters WHERE id=$1', [characterId])).rows[0].city as string;
    if (!ctx.data.cityById.has(toId)) throw notFound('city_not_found');
    if (toId === here) throw badRequest('already_here', 'You are already in that city.');
    const opt = quote(ctx, here, toId).find((o) => o.mode === mode);
    if (!opt) throw badRequest('unknown_mode', 'Unknown way to travel.');
    if (!opt.available) throw conflict('mode_unavailable', opt.reason);

    await tx.query('UPDATE ledger_transactions SET amount=$2 WHERE id=$1', [c.txId, opt.fare]);
    await post(tx, c.txId, [{ account: playerAccount(characterId), delta: -opt.fare }, { account: systemAccount('sink:transport'), delta: opt.fare }]);
    const arrives = new Date(now.getTime() + opt.seconds * 1000);
    await tx.query('UPDATE characters SET travel_to=$2, travel_until=$3 WHERE id=$1', [characterId, toId, arrives]);
    const trip = (await tx.query(
      `INSERT INTO trips (character_id,from_city,to_city,mode,distance_km,fare,tx_id,started_at,arrives_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [characterId, here, toId, mode, opt.km, opt.fare, c.txId, now, arrives])).rows[0];
    const response: TripResult = { tripId: trip.id, to: toId, mode, fare: opt.fare, seconds: opt.seconds, arrivesAt: arrives.toISOString(), replayed: false };
    await finish(tx, c.txId, response);
    return response;
  });
}

async function arriveTx(ctx: AppContext, tx: Tx, characterId: string, now: Date): Promise<string | null> {
  const r = await tx.query(
    `UPDATE characters SET city=travel_to, travel_to=NULL, travel_until=NULL, pos_x=0, pos_z=0, district=travel_to
      WHERE id=$1 AND travel_to IS NOT NULL AND travel_until <= $2 RETURNING city`, [characterId, now]);
  if (r.rowCount === 0) return null;
  const city = r.rows[0].city as string;
  const spawn = (ctx.data.worlds.get(city) ?? ctx.data.world).spawn;
  await tx.query('UPDATE characters SET pos_x=$2, pos_z=$3 WHERE id=$1', [characterId, spawn.x, spawn.z]);
  return city;
}

/** Complete a journey whose time has elapsed. Returns the new city, or null if nothing was due. */
export async function completeArrival(ctx: AppContext, characterId: string): Promise<string | null> {
  return withTx(ctx.pool, (tx) => arriveTx(ctx, tx, characterId, ctx.now()));
}

export async function tripHistory(ctx: AppContext, characterId: string) {
  const r = await ctx.pool.query('SELECT from_city,to_city,mode,distance_km,fare,started_at FROM trips WHERE character_id=$1 ORDER BY started_at DESC LIMIT 20', [characterId]);
  return r.rows.map((t) => ({ from: t.from_city as string, to: t.to_city as string, mode: t.mode as string, km: t.distance_km as number, fare: t.fare as number, at: t.started_at as Date }));
}

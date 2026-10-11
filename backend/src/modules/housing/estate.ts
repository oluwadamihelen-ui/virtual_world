import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { conflict, notFound } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { claim, post, finish, playerAccount, systemAccount } from '../economy/ledger.js';
import { awardAchievement } from '../social/social.js';
import { currentTenancy, endTenancy } from './housing.js';

/**
 * Real estate: every home, apartment and plot of land can be inspected, rented or bought and (for homes) moved into at once.
 * Money moves through the ledger against the `faucet:real_estate` market account in both directions (purchase and sell-back),
 * so market inflow and outflow stay measurable. Everything is exclusive: the property row is locked while it changes hands.
 */
const FOREVER = new Date('9999-01-01T00:00:00Z');
const LIVE = ['active', 'grace'];
const isHome = (type: string) => type !== 'land';

export interface Listing {
  propertyId: string; lotId: string | null; type: string; name: string; beds: number; sizeSqm: number; blurb: string;
  rent: number | null; price: number | null; buildCost: number | null; sellBack: number | null;
  state: 'available' | 'yours_renting' | 'yours_owned' | 'taken'; livingHere: boolean;
}

function toListing(ctx: AppContext, p: any, me: string, livingIn: string | null): Listing {
  const mineOwned = p.owner_id === me;
  const mineRent = p.status === 'occupied' && p.tenant_id === me;
  const state: Listing['state'] = mineOwned ? 'yours_owned' : mineRent ? 'yours_renting' : p.status === 'available' ? 'available' : 'taken';
  return {
    propertyId: p.id, lotId: p.lot_id, type: p.type, name: p.name, beds: p.beds, sizeSqm: p.size_sqm, blurb: p.blurb,
    rent: p.type !== 'land' && Number(p.rent_per_period) > 0 ? Number(p.rent_per_period) : null,
    price: p.sale_price ? Number(p.sale_price) : null,
    buildCost: p.type === 'land' && p.build_cost ? Number(p.build_cost) : null,
    sellBack: mineOwned && p.sale_price ? Math.floor((Number(p.sale_price) * ctx.data.estate.sellBackPercent) / 100) : null,
    state, livingHere: livingIn === p.id,
  };
}

/** Everything for sale or rent in one city, grouped by lot (building or plot), plus what this player already has there. */
export async function listCity(ctx: AppContext, characterId: string, cityId: string) {
  if (!ctx.data.cityById.has(cityId)) throw notFound('city_not_found');
  const rows = (await ctx.pool.query(
    `SELECT p.*, (SELECT t.character_id FROM tenancies t WHERE t.property_id=p.id AND t.status = ANY($2) AND t.kind='rent' LIMIT 1) AS tenant_id
       FROM properties p WHERE p.district=$1 ORDER BY p.lot_id, p.sale_price NULLS FIRST, p.id`, [cityId, LIVE])).rows;
  const home = await currentTenancy(ctx.pool, characterId);
  const lots = new Map<string, Listing[]>();
  for (const r of rows) {
    const l = toListing(ctx, r, characterId, home?.propertyId ?? null);
    const key = l.lotId ?? 'other';
    if (!lots.has(key)) lots.set(key, []);
    lots.get(key)!.push(l);
  }
  const out = [...lots.entries()].map(([lotId, items]) => {
    if (lotId !== 'apt') return { lotId, listings: items, rooms: null };
    // The apartment block: show every apartment, and a summary plus the first few free rooms (there can be dozens).
    const apartments = items.filter((i) => i.type === 'apartment');
    const rooms = items.filter((i) => i.type === 'room');
    const free = rooms.filter((r) => r.state === 'available');
    const mine = rooms.filter((r) => r.state.startsWith('yours'));
    return { lotId, listings: [...apartments, ...mine, ...free.slice(0, 6)], rooms: { total: rooms.length, available: free.length, cheapestRent: free.length ? Math.min(...free.map((r) => r.rent ?? 0)) : null } };
  });
  const owned = (await ctx.pool.query(`SELECT id, name, type FROM properties WHERE owner_id=$1 ORDER BY name`, [characterId])).rows;
  return { cityId, lots: out, owned: owned.map((o) => ({ propertyId: o.id as string, name: o.name as string, type: o.type as string })), home, limits: { maxLandPlots: ctx.data.estate.maxLandPlots, sellBackPercent: ctx.data.estate.sellBackPercent } };
}

/** One row per city/area for the "where should I live?" overview. */
export async function overview(ctx: AppContext) {
  const r = await ctx.pool.query(
    `SELECT district,
       count(*) FILTER (WHERE status='available' AND type IN ('room','apartment','house')) AS homes_free,
       min(rent_per_period) FILTER (WHERE status='available' AND type='room') AS cheapest_room,
       min(sale_price) FILTER (WHERE status='available' AND type IN ('apartment','house')) AS cheapest_home,
       min(sale_price) FILTER (WHERE status='available' AND type='land') AS cheapest_land,
       count(*) FILTER (WHERE status='available' AND type='land') AS plots_free
     FROM properties GROUP BY district`);
  return r.rows.map((x) => ({
    cityId: x.district as string, homesFree: Number(x.homes_free), cheapestRoom: x.cheapest_room == null ? null : Number(x.cheapest_room),
    cheapestHome: x.cheapest_home == null ? null : Number(x.cheapest_home), cheapestLand: x.cheapest_land == null ? null : Number(x.cheapest_land), plotsFree: Number(x.plots_free),
  }));
}

async function lockProperty(tx: Tx, propertyId: string, cityId: string) {
  const prop = (await tx.query('SELECT * FROM properties WHERE id=$1 FOR UPDATE', [propertyId])).rows[0];
  if (!prop) throw notFound('property_not_found');
  if (prop.district !== cityId) throw conflict('wrong_city', 'That property is in another city.');
  return prop;
}
const liveCount = async (tx: Tx, characterId: string) => (await tx.query(`SELECT count(*)::int n FROM tenancies WHERE character_id=$1 AND status = ANY($2)`, [characterId, LIVE])).rows[0].n as number;
async function moveInOwned(tx: Tx, ctx: AppContext, characterId: string, propertyId: string) {
  const now = ctx.now();
  await tx.query(`INSERT INTO tenancies (property_id,character_id,status,rent_amount,started_at,paid_until,kind) VALUES ($1,$2,'active',0,$3,$4,'own')`, [propertyId, characterId, now, FOREVER]);
}

export async function buy(ctx: AppContext, characterId: string, cityId: string, propertyId: string, key: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const prop = await lockProperty(tx, propertyId, cityId);
    if (!prop.sale_price) throw conflict('not_for_sale', 'This property is not for sale.');
    const price = Number(prop.sale_price);
    const c = await claim<any>(tx, { key: `${characterId}:buy:${key}`, type: 'property_purchase', actorCharacterId: characterId, referenceType: 'property', referenceId: propertyId, amount: price, payload: { propertyId } });
    if (c.replay) return { ...c.response, replayed: true };
    if (prop.status !== 'available') throw conflict('property_unavailable', 'Someone already has this property.');
    if (isHome(prop.type)) {
      if ((await liveCount(tx, characterId)) >= ctx.data.economy.maxActiveTenanciesPerCharacter) throw conflict('tenancy_limit', 'You already have a home. Move out or sell it first.');
    } else {
      const n = (await tx.query(`SELECT count(*)::int n FROM properties WHERE owner_id=$1 AND (type='land' OR built)`, [characterId])).rows[0].n as number;
      if (n >= ctx.data.estate.maxLandPlots) throw conflict('land_limit', `You can own at most ${ctx.data.estate.maxLandPlots} plots of land.`);
    }
    await post(tx, c.txId, [{ account: playerAccount(characterId), delta: -price }, { account: systemAccount('faucet:real_estate'), delta: price }]);
    await tx.query(`UPDATE properties SET status='owned', owner_id=$2 WHERE id=$1`, [propertyId, characterId]);
    const movedIn = isHome(prop.type);
    if (movedIn) { await moveInOwned(tx, ctx, characterId, propertyId); await awardAchievement(ctx, tx, characterId, 'first_home'); }
    const response = { propertyId, name: prop.name, type: prop.type, paid: price, movedIn, replayed: false };
    await finish(tx, c.txId, response);
    return response;
  });
}

/** Build a starter home on land you own; you move in at once if you have no other home. */
export async function build(ctx: AppContext, characterId: string, cityId: string, propertyId: string, key: string) {
  const b = ctx.data.estate.build;
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const prop = await lockProperty(tx, propertyId, cityId);
    if (prop.type !== 'land' || prop.owner_id !== characterId) throw conflict('not_your_land', 'You can only build on land you own.');
    const cost = Number(prop.build_cost ?? 0);
    if (!(cost > 0)) throw conflict('cannot_build', 'You cannot build here.');
    const c = await claim<any>(tx, { key: `${characterId}:build:${key}`, type: 'property_build', actorCharacterId: characterId, referenceType: 'property', referenceId: propertyId, amount: cost, payload: { propertyId } });
    if (c.replay) return { ...c.response, replayed: true };
    await post(tx, c.txId, [{ account: playerAccount(characterId), delta: -cost }, { account: systemAccount('faucet:real_estate'), delta: cost }]);
    const value = Number(prop.sale_price) + cost;
    const city = ctx.data.cityById.get(cityId)!;
    await tx.query(
      `UPDATE properties SET type='house', built=true, name=$2, beds=$3, furniture_slots=$4, capacity=$5, sale_price=$6, rent_per_period=$7, blurb=$8, build_cost=NULL WHERE id=$1`,
      [propertyId, `${b.name}, ${city.name}`, b.beds, b.furnitureSlots, b.capacity, value, Math.max(50, Math.round((value * b.rentRatio) / 50) * 50), 'A home you built yourself.']);
    let movedIn = false;
    if ((await liveCount(tx, characterId)) < ctx.data.economy.maxActiveTenanciesPerCharacter) { await moveInOwned(tx, ctx, characterId, propertyId); movedIn = true; await awardAchievement(ctx, tx, characterId, 'first_home'); }
    const response = { propertyId, paid: cost, movedIn, replayed: false };
    await finish(tx, c.txId, response);
    return response;
  });
}

/** Move into a home you own (for example after leaving another one). */
export async function moveIn(ctx: AppContext, characterId: string, cityId: string, propertyId: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const prop = await lockProperty(tx, propertyId, cityId);
    if (prop.owner_id !== characterId || !isHome(prop.type)) throw conflict('not_your_home', 'You can only move into a home you own.');
    if ((await liveCount(tx, characterId)) >= ctx.data.economy.maxActiveTenanciesPerCharacter) throw conflict('tenancy_limit', 'You already live somewhere. Move out first.');
    await moveInOwned(tx, ctx, characterId, propertyId);
    return { propertyId, movedIn: true };
  });
}

/** Stop living in your current home. Rented homes go back on the market; owned homes stay yours. */
export async function leave(ctx: AppContext, characterId: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const t = (await tx.query(`SELECT * FROM tenancies WHERE character_id=$1 AND status = ANY($2) FOR UPDATE`, [characterId, LIVE])).rows[0];
    if (!t) throw conflict('no_home', 'You are not living anywhere.');
    await tx.query('SELECT 1 FROM properties WHERE id=$1 FOR UPDATE', [t.property_id]);
    await endTenancy(tx, t, 'moved_out', ctx.now());
    return { left: t.property_id as string, kept: t.kind === 'own' };
  });
}

/** Sell a property you own back to the market at the sell-back percentage. */
export async function sell(ctx: AppContext, characterId: string, cityId: string, propertyId: string, key: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const prop = await lockProperty(tx, propertyId, cityId);
    if (prop.owner_id !== characterId) throw conflict('not_yours', 'You do not own this property.');
    const payout = Math.floor((Number(prop.sale_price) * ctx.data.estate.sellBackPercent) / 100);
    const c = await claim<any>(tx, { key: `${characterId}:sell:${key}`, type: 'property_sale', actorCharacterId: characterId, referenceType: 'property', referenceId: propertyId, amount: payout, payload: { propertyId } });
    if (c.replay) return { ...c.response, replayed: true };
    const t = (await tx.query(`SELECT * FROM tenancies WHERE property_id=$1 AND status = ANY($2) FOR UPDATE`, [propertyId, LIVE])).rows[0];
    if (t) await endTenancy(tx, t, 'sold', ctx.now());
    await tx.query(`UPDATE properties SET status='available', owner_id=NULL WHERE id=$1`, [propertyId]);
    await post(tx, c.txId, [{ account: systemAccount('faucet:real_estate'), delta: -payout }, { account: playerAccount(characterId), delta: payout }]);
    const response = { propertyId, received: payout, replayed: false };
    await finish(tx, c.txId, response);
    return response;
  });
}

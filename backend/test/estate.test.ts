import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, key, type TestWorld } from './helpers.js';
import { withTx } from '../src/db.js';
import { transfer, playerAccount, systemAccount, balanceOf, verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';
import { handleApp } from '../src/modules/phone/index.js';
import * as estate from '../src/modules/housing/estate.js';
import * as housing from '../src/modules/housing/housing.js';
import * as travel from '../src/modules/travel/travel.js';
import { characterSummary } from '../src/modules/summary.js';

let w: TestWorld;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });

type P = { characterId: string };
const fund = (p: P, n: number) => withTx(w.ctx.pool, (tx) => transfer(tx, { key: key(), type: 'adjustment', amount: n, payload: {}, from: systemAccount('faucet:world'), to: playerAccount(p.characterId) }, () => ({})));
const bal = (p: P) => balanceOf(w.ctx.pool, p.characterId);
const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e: any) { return e.code ?? e.message; } };
const integrity = async () => expect((await verifyLedgerIntegrity(w.ctx.pool)).ok).toBe(true);
const estateApp = (p: P, a: string, d?: object, city = 'lagos') => handleApp(w.ctx, { id: p.characterId, name: 'x', city }, 'estate', a, d);
const prop = async (id: string) => (await w.ctx.pool.query('SELECT * FROM properties WHERE id=$1', [id])).rows[0];

describe('catalogue', () => {
  it('every city has apartments, houses and land with prices scaled by the area', async () => {
    const a = await w.newPlayer('Looker');
    const lagos: any = await estate.listCity(w.ctx, a.characterId, 'lagos');
    const kinds = new Set(lagos.lots.flatMap((l: any) => l.listings.map((x: any) => x.type)));
    expect(kinds).toEqual(new Set(['room', 'apartment', 'house', 'land']));
    expect(lagos.lots.map((l: any) => l.lotId)).toEqual(expect.arrayContaining(['apt', 'house_a', 'house_b', 'house_c', 'land_a', 'land_b', 'land_c', 'land_d']));
    const house = (id: string) => (lagos.lots.find((l: any) => l.lotId === 'house_a').listings[0]);
    expect(house('house_a').price).toBe(42000);
    const ikoyi: any = await estate.listCity(w.ctx, a.characterId, 'ikoyi');
    expect(ikoyi.lots.find((l: any) => l.lotId === 'house_a').listings[0].price).toBeGreaterThan(90000);
    const surulere: any = await estate.listCity(w.ctx, a.characterId, 'surulere');
    expect(surulere.lots.find((l: any) => l.lotId === 'house_a').listings[0].price).toBeLessThan(42000);
    const ov = await estate.overview(w.ctx);
    expect(ov.length).toBe(w.ctx.data.geo.cities.length);
    expect(w.ctx.data.geo.cities.length).toBeGreaterThanOrEqual(20);
  });
});

describe('buying and moving in', () => {
  it('buys a house, moves in at once, and nobody else can take it', async () => {
    const a = await w.newPlayer('Buyer'), b = await w.newPlayer('Rival'); await fund(a, 50000); await fund(b, 50000);
    const before = await bal(a);
    const r: any = (await estateApp(a, 'buy', { id: 'prop_lagos_house_a', key: key() })).data;
    expect(r.movedIn).toBe(true); expect(await bal(a)).toBe(before - 42000);
    const s: any = await characterSummary(w.ctx, a.characterId);
    expect(s.tenancy.propertyId).toBe('prop_lagos_house_a'); expect(s.tenancy.kind).toBe('own'); expect(s.tenancy.propertyType).toBe('house');
    expect((await prop('prop_lagos_house_a')).status).toBe('owned');
    expect(await code(() => estateApp(b, 'buy', { id: 'prop_lagos_house_a', key: key() }))).toBe('property_unavailable');
    expect(await code(() => estateApp(b, 'rent', { id: 'prop_lagos_house_a', key: key() }))).toBe('property_unavailable');
    await integrity();
  });
  it('is idempotent, checks funds, and checks the city', async () => {
    const a = await w.newPlayer('Careful');
    expect(await code(() => estateApp(a, 'buy', { id: 'prop_lagos_house_a', key: key() }))).toBe('insufficient_funds');
    expect((await prop('prop_lagos_house_a')).status).toBe('available');
    await fund(a, 50000); const k = key(); const first: any = (await estateApp(a, 'buy', { id: 'prop_lagos_house_a', key: k })).data;
    const again: any = (await estateApp(a, 'buy', { id: 'prop_lagos_house_a', key: k })).data;
    expect(first.replayed).toBe(false); expect(again.replayed).toBe(true);
    expect(await code(() => estateApp(a, 'buy', { id: 'prop_london_house_b', key: key() }))).toBe('wrong_city');
    await integrity();
  });
  it('buys an apartment, rents another home elsewhere only after leaving, and keeps a single home', async () => {
    const a = await w.newPlayer('Flat'); await fund(a, 40000);
    await estateApp(a, 'buy', { id: 'prop_lagos_apt_1', key: key() });
    expect(await code(() => estateApp(a, 'rent', { id: 'prop_resi_room_101', key: key() }))).toBe('tenancy_limit');
    expect(await code(() => estateApp(a, 'buy', { id: 'prop_lagos_house_a', key: key() }))).toBe('tenancy_limit');
    const left: any = (await estateApp(a, 'leave')).data; expect(left.kept).toBe(true);
    expect((await prop('prop_lagos_apt_1')).status).toBe('owned');   // still yours
    expect(await code(() => estateApp(a, 'rent', { id: 'prop_resi_room_101', key: key() }))).toBe('ok');
    await integrity();
  });
  it('rents instantly, pays rent only for rentals, and owners are never charged rent', async () => {
    const a = await w.newPlayer('Renter'), o = await w.newPlayer('Owner'); await fund(a, 8000); await fund(o, 70000);
    const rr: any = (await estateApp(a, 'rent', { id: 'prop_lagos_house_a', key: key() })).data;
    expect(rr.goHome).toBeUndefined();
    expect(((await characterSummary(w.ctx, a.characterId)) as any).tenancy.kind).toBe('rent');
    await estateApp(o, 'buy', { id: 'prop_lagos_house_b', key: key() });
    const ob = await bal(o);
    w.clock.t = new Date(w.clock.t.getTime() + 40 * 24 * 3600_000);
    await housing.sweepTenancies(w.ctx);
    expect(await bal(o)).toBe(ob);                       // owner untouched
    expect((await prop('prop_lagos_house_b')).status).toBe('owned');
    expect(await code(() => estateApp(a, 'rent', { id: 'prop_lagos_land_a', key: key() }))).toBe('not_for_rent');
    await integrity();
  });
});

describe('land', () => {
  it('can be bought while you have a home, capped at three plots, then built on', async () => {
    const a = await w.newPlayer('Landlord'); await fund(a, 100000);
    await estateApp(a, 'rent', { id: 'prop_resi_room_101', key: key() });
    const r: any = (await estateApp(a, 'buy', { id: 'prop_lagos_land_a', key: key() })).data;
    expect(r.movedIn).toBe(false);
    await estateApp(a, 'buy', { id: 'prop_lagos_land_b', key: key() });
    await estateApp(a, 'buy', { id: 'prop_lagos_land_c', key: key() });
    expect(await code(() => estateApp(a, 'buy', { id: 'prop_lagos_land_d', key: key() }))).toBe('land_limit');
    const before = await bal(a);
    const b: any = (await estateApp(a, 'build', { id: 'prop_lagos_land_a', key: key() })).data;
    expect(b.movedIn).toBe(false);                      // already has a home
    expect(await bal(a)).toBe(before - 15000);
    const p = await prop('prop_lagos_land_a'); expect(p.type).toBe('house'); expect(p.built).toBe(true); expect(Number(p.sale_price)).toBe(9000 + 15000);
    expect(await code(() => estateApp(a, 'build', { id: 'prop_lagos_land_a', key: key() }))).toBe('not_your_land');   // already built
    await estateApp(a, 'leave');
    const mv: any = (await estateApp(a, 'movein', { id: 'prop_lagos_land_a' })).data; expect(mv.movedIn).toBe(true);
    await integrity();
  });
  it('building on your first land moves you in; strangers cannot build on it; built houses survive a data sync', async () => {
    const a = await w.newPlayer('Builder'), x = await w.newPlayer('Stranger'); await fund(a, 40000); await fund(x, 40000);
    await estateApp(a, 'buy', { id: 'prop_lagos_land_c', key: key() });
    expect(await code(() => estateApp(x, 'build', { id: 'prop_lagos_land_c', key: key() }))).toBe('not_your_land');
    const b: any = (await estateApp(a, 'build', { id: 'prop_lagos_land_c', key: key() })).data;
    expect(b.movedIn).toBe(true); expect(b.goHome).toBeUndefined();
    const { syncGameData } = await import('../src/seed.js');
    await syncGameData(w.ctx.pool, w.ctx.data);
    expect((await prop('prop_lagos_land_c')).type).toBe('house');   // the player's build is not reverted by a restart
    expect((await prop('prop_lagos_land_c')).owner_id).toBe(a.characterId);
  });
});

describe('selling back', () => {
  it('pays the sell-back percentage, ends the tenancy and re-lists the property', async () => {
    const a = await w.newPlayer('Seller'), b = await w.newPlayer('Next'); await fund(a, 50000); await fund(b, 50000);
    await estateApp(a, 'buy', { id: 'prop_lagos_house_a', key: key() });
    const before = await bal(a);
    const r: any = (await estateApp(a, 'sell', { id: 'prop_lagos_house_a', key: key() })).data;
    expect(r.received).toBe(29400); expect(await bal(a)).toBe(before + r.received);
    expect(((await characterSummary(w.ctx, a.characterId)) as any).tenancy).toBeNull();
    expect((await prop('prop_lagos_house_a')).status).toBe('available');
    expect(await code(() => estateApp(b, 'buy', { id: 'prop_lagos_house_a', key: key() }))).toBe('ok');
    expect(await code(() => estateApp(a, 'sell', { id: 'prop_lagos_house_a', key: key() }))).toBe('not_yours');
    await integrity();
  });
});

describe('areas of a city', () => {
  it('lets you walk between nearby areas but not between far cities', () => {
    const q = (a: string, b: string) => travel.quote(w.ctx, a, b);
    expect(q('lagos', 'surulere').find((o) => o.mode === 'walk')?.available).toBe(true);
    expect(q('lagos', 'lekki').find((o) => o.mode === 'walk')?.available).toBe(false);   // 20+ km
    expect(q('lagos', 'lekki').find((o) => o.mode === 'bus')?.available).toBe(true);
    expect(q('lagos', 'kano').find((o) => o.mode === 'walk')).toBeUndefined();
  });
});

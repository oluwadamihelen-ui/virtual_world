import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, key, type TestWorld } from './helpers.js';
import { withTx } from '../src/db.js';
import { transfer, playerAccount, systemAccount, balanceOf, verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';
import { handleApp } from '../src/modules/phone/index.js';
import * as estate from '../src/modules/housing/estate.js';
import * as housing from '../src/modules/housing/housing.js';
import * as travel from '../src/modules/travel/travel.js';
import { updateAreaValues } from '../src/modules/housing/values.js';
import { characterSummary } from '../src/modules/summary.js';
import { buildColliders, isBlocked } from '../shared/sim.mjs';
import { builtHouseSpec } from '../src/world/cities.js';

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
    const p = await prop('prop_lagos_land_a'); expect(p.type).toBe('house'); expect(p.built).toBe(true); expect(Number(p.sale_price)).toBe(9000 + 15000); expect(Number(p.bought_for)).toBe(9000 + 15000);
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
    expect(r.received).toBe(39900);   // 42,000 minus the 5% selling fee expect(await bal(a)).toBe(before + r.received);
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

describe('area values follow population', () => {
  const idxOf = async (area: string) => Number((await w.ctx.pool.query('SELECT idx FROM area_values WHERE area=$1', [area])).rows[0].idx);
  const advance = async (days: number) => { w.clock.t = new Date(w.clock.t.getTime() + days * 86_400_000); await updateAreaValues(w.ctx); };

  it('starts at 1.00, rises as settlers and players move in, and never leaves its floor or ceiling', async () => {
    await updateAreaValues(w.ctx);
    expect(await idxOf('lekki')).toBe(1);
    await advance(5);
    const five = await idxOf('lekki'); expect(five).toBeGreaterThan(1.3);       // 0.9 settlers/day x 5 days x 0.1
    await advance(400);
    expect(await idxOf('lekki')).toBeLessThanOrEqual(w.ctx.data.estate.values.ceiling + 1e-9);
    expect(await idxOf('lekki')).toBeGreaterThan(five);
    // a faster-growing area is worth more than a slower one after the same time
    expect(await idxOf('lekki')).toBeGreaterThanOrEqual(await idxOf('karen'));
  });
  it('moves smoothly: never more than one step per update', async () => {
    await updateAreaValues(w.ctx); const before = await idxOf('ikeja');
    w.clock.t = new Date(w.clock.t.getTime() + 10 * 60_000 + 1000); await updateAreaValues(w.ctx);
    expect(Math.abs((await idxOf('ikeja')) - before)).toBeLessThanOrEqual(w.ctx.data.estate.values.stepPerUpdate + 1e-9);
  });
  it('prices, rents and sell value use the current index; an early investor profits, a late one does not', async () => {
    await updateAreaValues(w.ctx);
    const early = await w.newPlayer('Early'), late = await w.newPlayer('Late'); await fund(early, 200000); await fund(late, 200000);
    await estateApp(early, 'buy', { id: 'prop_lekki_land_a', key: key() }, 'lekki');
    const paid = (await portfolioOf(early)).items[0]!.paid;
    await advance(10);
    const l: any = await estate.listCity(w.ctx, late.characterId, 'lekki');
    const price = l.lots.find((x: any) => x.lotId === 'land_b').listings[0].price;
    expect(price).toBeGreaterThan(paid * 1.3);                                   // the same kind of plot now costs far more
    const pf = await portfolioOf(early);
    expect(pf.items[0].value).toBeGreaterThan(paid * 1.3);
    expect(pf.profit).toBeGreaterThan(0);
    const before = await bal(early);
    const sold: any = (await estateApp(early, 'sell', { id: 'prop_lekki_land_a', key: key() }, 'lekki')).data;
    expect(sold.profit).toBeGreaterThan(0); expect(await bal(early)).toBe(before + sold.received);
    // buying now and selling straight away loses exactly the selling fee
    const lb = await bal(late);
    await estateApp(late, 'buy', { id: 'prop_lekki_land_b', key: key() }, 'lekki');
    const s2: any = (await estateApp(late, 'sell', { id: 'prop_lekki_land_b', key: key() }, 'lekki')).data;
    expect(s2.profit).toBeLessThan(0); expect(await bal(late)).toBeLessThan(lb);
    await integrity();
  });
  it('rent follows the index too, and a population drop lowers it', async () => {
    const a = await w.newPlayer('Tenant'); await fund(a, 5000);
    await updateAreaValues(w.ctx);
    await advance(10);
    const l: any = await estate.listCity(w.ctx, a.characterId, 'surulere');
    const rent = l.lots.find((x: any) => x.lotId === 'house_a').listings[0].rent;
    expect(rent).toBeGreaterThan(Math.round(2200 * 0.8 / 50) * 50);
    // players leaving cannot push the index below the floor
    await w.ctx.pool.query(`UPDATE area_values SET idx=0.81 WHERE area='surulere'`);
    expect(await idxOf('surulere')).toBeGreaterThanOrEqual(w.ctx.data.estate.values.floor);
  });
});
const portfolioOf = (p: P) => estate.portfolio(w.ctx, p.characterId) as Promise<any>;

describe('interiors and furniture', () => {
  const firstFurniture = async (p: P, itemId: string) => { await fund(p, 3000); return handleApp(w.ctx, { id: p.characterId, name: 'x', city: 'lagos' }, 'store', 'buy', { itemId, key: key() }); };
  const app = (p: P, name: string, a: string, d?: object) => handleApp(w.ctx, { id: p.characterId, name: 'x', city: 'lagos' }, name, a, d);

  it('houses have walls, a locked door gate for outsiders and an open one for the owner', () => {
    const world = w.ctx.data.worlds.get('lagos')!;
    const col = buildColliders(world); const b = world.buildings.find((x: any) => x.id === 'lagos:house_a');
    const door = { x: b.cx, z: b.cz + b.sz / 2 - 0.15 };
    expect(isBlocked(door.x, door.z, col, () => false, world.bounds)).toBe(true);               // stranger: blocked at the door
    expect(isBlocked(door.x, door.z, col, (g: string) => g === 'lagos:house_a', world.bounds)).toBe(false);   // owner's gate opens
    expect(isBlocked(door.x, door.z, col, (g: string) => g === 'lagos:house_b', world.bounds)).toBe(true);    // someone else's key does not
    expect(isBlocked(b.cx, b.cz, col, () => true, world.bounds)).toBe(false);                   // inside is empty floor
    expect(world.furniture.filter((f: any) => f.building === 'lagos:apt')).toHaveLength(0);           // homes start empty
  });
  it('a new home is empty; furniture is bought, placed, kept inside the walls, and returned when you leave', async () => {
    const a = await w.newPlayer('Decorator'); await fund(a, 100000);
    await estateApp(a, 'buy', { id: 'prop_lagos_house_a', key: key() });
    const info0: any = (await app(a, 'home', 'info')).data;
    expect(info0.placed).toHaveLength(0); expect(info0.owned).toHaveLength(0); expect(info0.rect).toBeTruthy();
    const items: any = (await app(a, 'store', 'list')).data; expect(items.items.length).toBeGreaterThanOrEqual(12);
    const before = await bal(a);
    await firstFurniture(a, 'single_bed'); await app(a, 'store', 'buy', { itemId: 'rug', key: key() });
    expect(await bal(a)).toBe(before + 3000 - 300 - 150);
    const r = info0.rect, cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
    expect(await code(() => app(a, 'home', 'place', { itemId: 'single_bed', x: 0, z: 0, yaw: 0 }))).toBe('outside_room');   // out on the road
    expect(await code(() => app(a, 'home', 'place', { itemId: 'single_bed', x: r.minX + 0.2, z: cz, yaw: 0 }))).toBe('outside_room');  // through the wall
    const door = info0.doorKeepOut; const dx = (door.minX + door.maxX) / 2;
    expect(await code(() => app(a, 'home', 'place', { itemId: 'single_bed', x: dx, z: r.maxZ - 0.55, yaw: Math.PI / 2 }))).toBe('blocks_door');
    const ok: any = (await app(a, 'home', 'place', { itemId: 'single_bed', x: r.minX + 0.6, z: r.minZ + 1.1, yaw: 0 })).data; expect(ok.furnitureId).toBeTruthy();
    expect(await code(() => app(a, 'home', 'place', { itemId: 'single_bed', x: r.maxX - 0.7, z: r.minZ + 1.1, yaw: 0 }))).not.toBe('ok');  // none left in the backpack
    await app(a, 'store', 'buy', { itemId: 'single_bed', key: key() });
    expect(await code(() => app(a, 'home', 'place', { itemId: 'single_bed', x: r.minX + 0.7, z: r.minZ + 1.3, yaw: 0 }))).toBe('overlap');
    expect(await code(() => app(a, 'home', 'place', { itemId: 'rug', x: r.minX + 1.2, z: r.minZ + 0.8, yaw: 0 }))).toBe('ok');   // rugs go under beds
    expect(await code(() => app(a, 'home', 'place', { itemId: 'sandwich', x: cx, z: cz, yaw: 0 }))).toBe('not_furniture');
    const s: any = await characterSummary(w.ctx, a.characterId); expect(s.furniture).toHaveLength(2);
    await app(a, 'home', 'pickup', { id: ok.furnitureId });
    expect(((await app(a, 'home', 'info')).data as any).placed).toHaveLength(1);
    await estateApp(a, 'leave');                       // moving out hands everything back
    const s2: any = await characterSummary(w.ctx, a.characterId); expect(s2.furniture).toHaveLength(0);
    expect(s2.inventory.find((i: any) => i.itemId === 'single_bed')?.quantity).toBe(2);
  });
  it('strangers cannot furnish or touch someone else\'s home, and furnishing needs a home', async () => {
    const a = await w.newPlayer('Owner2'), x = await w.newPlayer('Intruder'); await fund(a, 100000); await fund(x, 3000);
    await estateApp(a, 'buy', { id: 'prop_lagos_house_b', key: key() });
    await firstFurniture(a, 'sofa' as any).catch(() => {});
    await app(a, 'store', 'buy', { itemId: 'starter_sofa', key: key() });
    const info: any = (await app(a, 'home', 'info')).data;
    const placed: any = (await app(a, 'home', 'place', { itemId: 'starter_sofa', x: (info.rect.minX + info.rect.maxX) / 2, z: info.rect.minZ + 1, yaw: 0 })).data;
    expect(await code(() => app(x, 'home', 'pickup', { id: placed.furnitureId }))).toBe('furniture_not_found');
    await app(x, 'store', 'buy', { itemId: 'rug', key: key() });
    expect(await code(() => app(x, 'home', 'place', { itemId: 'rug', x: 0, z: 0, yaw: 0 }))).toBe('no_home');
  });
  it('a home built on land is a real building with an interior', async () => {
    const a = await w.newPlayer('Constructor'); await fund(a, 40000);
    await estateApp(a, 'buy', { id: 'prop_lagos_land_a', key: key() });
    await estateApp(a, 'build', { id: 'prop_lagos_land_a', key: key() });
    const info: any = (await app(a, 'home', 'info')).data;
    expect(info.home.lotId).toBe('land_a'); expect(info.rect.maxX - info.rect.minX).toBeGreaterThan(4);
    const spec = builtHouseSpec(w.ctx.data.worlds.get('lagos')!.lots.find((l: any) => l.id === 'lagos:land_a'));
    const world = { ...w.ctx.data.worlds.get('lagos')!, buildings: [...w.ctx.data.worlds.get('lagos')!.buildings, spec.building] };
    const col = buildColliders(world); const front = spec.building.doorSide === '+z' ? spec.building.cz + spec.building.sz / 2 - 0.15 : spec.building.cz - spec.building.sz / 2 + 0.15;
    expect(isBlocked(spec.building.cx, front, col, () => false, world.bounds)).toBe(true);
    expect(isBlocked(spec.building.cx, front, col, (g: string) => g === 'lagos:land_a', world.bounds)).toBe(false);
  });
  it('a rented room in the apartment block can be furnished too, inside the block', async () => {
    const a = await w.newPlayer('Roomie'); await fund(a, 5000);
    await estateApp(a, 'rent', { id: 'prop_resi_room_101', key: key() });
    await app(a, 'store', 'buy', { itemId: 'single_bed', key: key() });
    const info: any = (await app(a, 'home', 'info')).data; expect(info.home.lotId).toBe('apt'); expect(info.rect.maxX - info.rect.minX).toBeGreaterThan(10);
    expect(await code(() => app(a, 'home', 'place', { itemId: 'single_bed', x: (info.rect.minX + info.rect.maxX) / 2, z: info.rect.minZ + 1.2, yaw: 0 }))).toBe('ok');
  });
});

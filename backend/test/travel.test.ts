import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createWorld, key, type TestWorld } from './helpers.js';
import { Gateway } from '../src/realtime/gateway.js';
import { Client } from './wsclient.js';
import * as travel from '../src/modules/travel/travel.js';
import { formatMoney, currencyOfCity } from '../src/modules/economy/currency.js';
import { verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';
import { buildColliders, isBlocked } from '../shared/sim.mjs';
import { districtAt } from '../src/world/metro.js';

let w: TestWorld; let gw: Gateway; let port: number;
beforeEach(async () => {
  w = await createWorld(); gw = new Gateway(w.ctx); gw.attach(w.app.server);
  await w.app.listen({ port: 0, host: '127.0.0.1' }); port = (w.app.server.address() as AddressInfo).port;
});
afterEach(async () => { await gw.close(); await w.close(); });

async function join(p: { token: string; characterId: string }): Promise<Client> {
  const t = (await w.playerReq(p.token, 'POST', `/v1/characters/${p.characterId}/join-ticket`)).body.ticket;
  const c = await Client.open(`ws://127.0.0.1:${port}/ws?ticket=${t}`);
  if (!(c instanceof Client)) throw new Error('rejected');
  await c.until(() => c.of('welcome').length > 0);
  return c;
}
const me = (p: { characterId: string }) => gw.players.get(p.characterId)!;
const summary = async (p: { characterId: string }) => (await w.gameReq('GET', `/v1/game/characters/${p.characterId}/summary`)).body;
const give = async (p: { characterId: string }, delta: number) => {
  const a = await w.newPlayer('Banker ' + key().slice(0, 6)); const tok = await w.setRole(a.accountId, 'admin');
  await w.playerReq(tok, 'POST', '/v1/admin/adjustments', { characterId: p.characterId, delta, reason: 'test funding for travel scenarios', idempotencyKey: key() });
};
/** Make a pending journey finish now (both the database clock and the game server clock). */
async function finishTrip(p: { characterId: string }) {
  w.clock.t = new Date(w.clock.t.getTime() + 5 * 60_000);
  me(p).travel!.until = w.clock.t.getTime() - 1; gw.step(0.05);
  await new Promise((r) => setTimeout(r, 250));
}

describe('currency follows the country', () => {
  it('formats the same MVC amount in each country\'s currency using the fixed game rates', () => {
    const d = w.ctx.data;
    expect(formatMoney(d, 25, 'lagos')).toBe('₦2,500');
    expect(formatMoney(d, 25, 'abuja')).toBe('₦2,500');
    expect(formatMoney(d, 25, 'accra')).toBe('GH₵20.00');
    expect(formatMoney(d, 25, 'nairobi')).toBe('KSh215');
    expect(formatMoney(d, 25, 'london')).toBe('£1.25');
    expect(formatMoney(d, 2000, 'lagos')).toBe('₦200,000');
    expect(currencyOfCity(d, 'kumasi').code).toBe('GHS');
  });

  it('the character summary carries the currency of the city they are in', async () => {
    const p = await w.newPlayer();
    const s = await summary(p);
    expect(s.city).toBe('lagos');
    expect(s.currency).toMatchObject({ code: 'NGN', symbol: '₦', perMVC: 100, countryName: 'Nigeria' });
  });
});

describe('travel quotes', () => {
  it('domestic trips offer bus, taxi and flight; fares come from distance; far cities rule out the taxi', () => {
    const lagosAbuja = travel.quote(w.ctx, 'lagos', 'abuja');
    expect(lagosAbuja.map((o) => [o.mode, o.available])).toEqual([['bus', true], ['car', true], ['flight', true]]);
    const [bus, car, flight] = lagosAbuja;
    expect(bus!.km).toBeGreaterThan(450); expect(bus!.km).toBeLessThan(650);
    expect(bus!.fare).toBeLessThan(car!.fare); expect(car!.fare).toBeLessThan(flight!.fare);
    expect(car!.seconds).toBeGreaterThan(flight!.seconds); // flying is the fast option
    expect(bus!.fareText).toMatch(/^₦/);
    const lagosKano = travel.quote(w.ctx, 'lagos', 'kano');
    expect(lagosKano.find((o) => o.mode === 'car')).toMatchObject({ available: false, reason: 'Too far for this' });
  });

  it('crossing a border means flying (with the international fee); short flights are refused', () => {
    const toAccra = travel.quote(w.ctx, 'lagos', 'accra');
    expect(toAccra.find((o) => o.mode === 'bus')?.available).toBe(false);
    expect(toAccra.find((o) => o.mode === 'car')?.available).toBe(false);
    const f = toAccra.find((o) => o.mode === 'flight')!;
    expect(f.available).toBe(true);
    expect(f.fare).toBeGreaterThanOrEqual(55 + 60 + 0.11 * 300);
    const domesticFlight = travel.quote(w.ctx, 'accra', 'kumasi').find((o) => o.mode === 'flight')!;
    expect(domesticFlight.available).toBe(false); // Accra-Kumasi is under 200 km
    expect(travel.quote(w.ctx, 'accra', 'kumasi').find((o) => o.mode === 'bus')!.available).toBe(true);
    expect(travel.quote(w.ctx, 'lagos', 'london').find((o) => o.mode === 'flight')!.fare).toBeGreaterThan(travel.quote(w.ctx, 'lagos', 'nairobi').find((o) => o.mode === 'flight')!.fare);
  });

  it('quotes show the fare in the currency of the city you are leaving', () => {
    expect(travel.quote(w.ctx, 'london', 'lagos').find((o) => o.mode === 'flight')!.fareText).toMatch(/^£/);
    expect(travel.quote(w.ctx, 'accra', 'kumasi')[0]!.fareText).toMatch(/^GH₵/);
  });
});

describe('taking a trip', () => {
  it('charges the fare through the ledger, takes time, then arrives in the new city with that country\'s currency', async () => {
    const p = await w.newPlayer('Ngozi Traveller'); const c = await join(p);
    c.send({ t: 'quote', to: 'abuja' });
    await c.until(() => c.of('quote').length > 0);
    const bus = c.last('quote').options.find((o: any) => o.mode === 'bus');
    c.send({ t: 'travel', to: 'abuja', mode: 'bus' });
    await c.until(() => c.of('travel').length > 0);
    expect(c.last('travel')).toMatchObject({ to: 'abuja', toName: 'Abuja', mode: 'bus' });
    expect((await summary(p)).balance).toBe(2000 - bus.fare);
    expect((await summary(p)).city).toBe('lagos');             // still Lagos until the journey ends
    expect((await summary(p)).travel).toMatchObject({ to: 'abuja' });
    await finishTrip(p);
    await c.until(() => c.of('welcome').length > 1);
    const wel = c.last('welcome');
    expect(wel).toMatchObject({ arrived: true, city: { id: 'abuja', name: 'Abuja' }, currency: { code: 'NGN' } });
    expect(wel.world.cityId).toBe('abuja');
    expect(wel.world.zones.find((z: any) => z.kind === 'door' && z.area === 'abuja').label).toBe('Wuse Court Apartments');
    expect((await summary(p)).city).toBe('abuja');
    expect((await summary(p)).travel).toBeNull();
    expect((await w.ctx.pool.query('SELECT count(*)::int n FROM trips')).rows[0].n).toBe(1);
    expect(await verifyLedgerIntegrity(w.ctx.pool)).toMatchObject({ ok: true });
    c.close();
  });

  it('flying abroad switches the wallet to the local currency; the underlying balance is unchanged', async () => {
    const p = await w.newPlayer('Kojo Flyer'); await give(p, 1000);
    const c = await join(p);
    const before = (await summary(p)).balance;
    const fare = travel.quote(w.ctx, 'lagos', 'accra').find((o) => o.mode === 'flight')!.fare;
    c.send({ t: 'travel', to: 'accra', mode: 'flight' });
    await c.until(() => c.of('travel').length > 0);
    await finishTrip(p);
    await c.until(() => c.of('welcome').length > 1);
    expect(c.last('welcome').currency).toMatchObject({ code: 'GHS', symbol: 'GH₵', perMVC: 0.8 });
    const s = await summary(p);
    expect(s.balance).toBe(before - fare);
    expect(s.currency.code).toBe('GHS');
    expect(formatMoney(w.ctx.data, s.balance, s.city)).toMatch(/^GH₵/);
    c.close();
  });

  it('you cannot act, chat or start another trip mid-journey, and nobody sees you in either city', async () => {
    const a = await w.newPlayer('Traveller One'); const b = await w.newPlayer('Watcher Two');
    const ca = await join(a); const cb = await join(b);
    me(a).x = me(b).x - 2; me(a).z = me(b).z;
    ca.send({ t: 'travel', to: 'abuja', mode: 'bus' });
    await ca.until(() => ca.of('travel').length > 0);
    ca.send({ t: 'interact', zone: 'grocery_counter', item: 'sandwich' });
    await ca.until(() => ca.of('toast').some((m) => m.kind === 'error' && /journey/i.test(m.text)));
    ca.send({ t: 'travel', to: 'kano', mode: 'bus' });
    await ca.until(() => ca.of('toast').filter((m) => m.kind === 'error').length > 1);
    expect((await summary(a)).balance).toBeGreaterThan(1900);   // charged exactly once
    ca.send({ t: 'chat', text: 'hello from the bus' });
    gw.step(0.05); gw.step(0.05);
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.of('chat'), JSON.stringify(cb.of('chat'))).toHaveLength(0);
    expect(cb.last('snap').online).toBe(1);                     // the traveller is nowhere
    cb.close(); ca.close();
  });

  it('cities are separate rooms: players in different cities never see or hear each other', async () => {
    const a = await w.newPlayer('Lagos Lola'); const b = await w.newPlayer('Abuja Abu');
    await w.ctx.pool.query(`UPDATE characters SET city='abuja' WHERE id=$1`, [b.characterId]);
    const ca = await join(a); const cb = await join(b);
    expect(cb.last('welcome').city.id).toBe('abuja');
    me(a).x = 0; me(a).z = 0; me(b).x = 0; me(b).z = 0;
    ca.send({ t: 'chat', text: 'anyone there?' });
    await ca.until(() => ca.of('chat').length > 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.of('chat')).toHaveLength(0);
    gw.step(0.05); gw.step(0.05);
    expect(ca.last('snap').online).toBe(1); expect(cb.last('snap').online).toBe(1);
    ca.close(); cb.close();
  });

  it('insufficient funds, same-city and unknown trips are refused without charging', async () => {
    const p = await w.newPlayer('Broke Bola');
    await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'sandwich', quantity: 76, idempotencyKey: key() }); // leaves 100 MVC
    const c = await join(p);
    c.send({ t: 'travel', to: 'london', mode: 'flight' });
    await c.until(() => c.of('toast').some((m) => m.kind === 'error'));
    expect(c.last('toast').text).toMatch(/not enough/i);
    c.send({ t: 'travel', to: 'lagos', mode: 'bus' });
    await c.until(() => c.of('toast').filter((m) => m.kind === 'error').length > 1);
    c.send({ t: 'travel', to: 'atlantis', mode: 'bus' });
    await c.until(() => c.of('toast').filter((m) => m.kind === 'error').length > 2);
    c.send({ t: 'travel', to: 'accra', mode: 'bus' });             // buses do not cross borders
    await c.until(() => c.of('toast').filter((m) => m.kind === 'error').length > 3);
    expect((await summary(p)).balance).toBe(100);
    expect((await summary(p)).travel).toBeNull();
    c.close();
  });

  it('a duplicate trip request (same idempotency key) charges once', async () => {
    const p = await w.newPlayer('Dupe Dayo'); const k = key();
    const [a, b] = await Promise.all([travel.startTrip(w.ctx, p.characterId, 'abuja', 'bus', k), travel.startTrip(w.ctx, p.characterId, 'abuja', 'bus', k)]);
    expect(a.tripId).toBe(b.tripId);
    expect((await summary(p)).balance).toBe(2000 - a.fare);
    expect((await w.ctx.pool.query('SELECT count(*)::int n FROM trips')).rows[0].n).toBe(1);
  });

  it('a journey survives disconnecting: reconnect shows it in progress, and a finished one completes on login', async () => {
    const p = await w.newPlayer('Offline Ope'); let c = await join(p);
    c.send({ t: 'travel', to: 'portharcourt', mode: 'bus' });
    await c.until(() => c.of('travel').length > 0);
    c.close(); await new Promise((r) => setTimeout(r, 300));
    c = await join(p);
    await c.until(() => c.of('travel').length > 0);
    expect(c.last('travel').to).toBe('portharcourt');
    expect(c.last('welcome').city.id).toBe('lagos');
    c.close(); await new Promise((r) => setTimeout(r, 300));
    w.clock.t = new Date(w.clock.t.getTime() + 10 * 60_000);
    await w.ctx.pool.query(`UPDATE characters SET travel_until = $2 WHERE id=$1`, [p.characterId, new Date(w.clock.t.getTime() - 1000)]);
    c = await join(p);
    expect(c.last('welcome').city.id).toBe('portharcourt');
    expect((await summary(p)).travel).toBeNull();
    c.close();
  });
});

describe('each city is its own place', () => {
  it('every city world is walkable and wired: spawn and interaction zones are clear, shops exist with local prices', async () => {
    for (const [id, world] of w.ctx.data.worlds) {
      const col = buildColliders(world);
      expect(isBlocked(world.spawn.x, world.spawn.z, col, () => false, world.bounds), `${id} spawn`).toBe(false);
      for (const z of world.zones) expect(isBlocked(z.x, z.z, col, () => true, world.bounds), `${id} zone ${z.id}`).toBe(false);
      const shopZone = world.zones.find((z: any) => z.kind === 'shop');
      expect(w.ctx.data.shops.some((s) => s.id === shopZone.shopId), `${id} shop`).toBe(true);
      expect((await w.ctx.pool.query(`SELECT count(*)::int n FROM properties WHERE district=$1 AND type='room'`, [id])).rows[0].n, `${id} rooms`).toBeGreaterThanOrEqual(8);
    }
  });

  it('prices follow the local cost of living: London costs more than Lagos for the same sandwich and room', async () => {
    const price = async (shop: string) => (await w.ctx.pool.query(`SELECT price FROM shop_stock WHERE shop_id=$1 AND item_id='sandwich'`, [shop])).rows[0].price;
    expect(await price('shop_corner_grocery')).toBe(25);
    expect(await price('shop_london_grocery')).toBe(45);
    expect(await price('shop_kumasi_grocery')).toBe(21);
    const rent = async (district: string) => (await w.ctx.pool.query(`SELECT rent_per_period FROM properties WHERE district=$1 AND type='room' ORDER BY id LIMIT 1`, [district])).rows[0].rent_per_period;
    expect(await rent('lagos')).toBe(500); expect(await rent('london')).toBe(900);
  });

  it('you can rent, shop and work in a new city, and only the home city door is yours', async () => {
    const p = await w.newPlayer('Settler Sade'); await give(p, 1500);
    await w.ctx.pool.query(`UPDATE characters SET city='accra' WHERE id=$1`, [p.characterId]);
    const c = await join(p);
    expect(c.last('welcome').door.state).toBe('free');
    const apt = c.last('welcome').world.zones.find((z: any) => z.kind === 'door' && z.area === 'accra');
    me(p).x = apt.x; me(p).z = apt.z;
    c.send({ t: 'interact', zone: apt.id });
    await c.until(() => c.of('toast').some((m) => /rented/.test(m.text)));
    expect(c.of('toast').find((m) => /rented/.test(m.text)).text).toMatch(/GH₵/);   // priced in cedis
    const shopZone = c.last('welcome').world.zones.find((z: any) => z.kind === 'shop' && z.area === 'accra');
    me(p).x = shopZone.x; me(p).z = shopZone.z;
    await new Promise((r) => setTimeout(r, 300));
    c.send({ t: 'interact', zone: shopZone.id, item: 'sandwich' });
    await c.until(() => c.of('toast').some((m) => /Bought/.test(m.text)));
    expect(c.of('toast').find((m) => /Bought/.test(m.text)).text).toMatch(/GH₵\d+\.\d\d/);
    expect((await w.ctx.pool.query(`SELECT count(*)::int n FROM ledger_transactions WHERE type='shop_purchase'`)).rows[0].n).toBe(1);
    // go back to Lagos: the Accra tenancy is not a Lagos door
    c.close(); await new Promise((r) => setTimeout(r, 200));
    await w.ctx.pool.query(`UPDATE characters SET city='lagos', pos_rev=1 WHERE id=$1`, [p.characterId]); await new Promise((r) => setTimeout(r, 200));
    const c2 = await join(p);
    expect(c2.last('welcome').door.state).toBe('away');
    c2.send({ t: 'home' });
    await c2.until(() => c2.of('toast').some((m) => /home is in Accra/.test(m.text)));
    c2.close();
  });
});

describe('a metro is one continuous world', () => {
  it('Lagos has six districts you can walk between: roads and bridges connect them, water blocks, and the area follows your feet', async () => {
    const world = w.ctx.data.worlds.get('lagos')!;
    expect(world.districts.map((d: any) => d.id).sort()).toEqual(['ikeja', 'ikoyi', 'lagos', 'lekki', 'surulere', 'victoriaisland']);
    expect(world.pois.length).toBeGreaterThanOrEqual(30);
    const col = buildColliders(world);
    // water blocks everywhere except on the bridges
    const lagoon = world.water[0]; const zMid = (lagoon.minZ + lagoon.maxZ) / 2;
    expect(isBlocked(world.avenueX[0] + 20, zMid, col, () => true, world.bounds)).toBe(true);
    expect(isBlocked(world.avenueX[0], zMid, col, () => true, world.bounds)).toBe(false);
    // every district spawn is on solid ground and every area is reachable along its street
    for (const d of world.districts) expect(isBlocked(d.spawn.x, d.spawn.z, col, () => true, world.bounds), `${d.id} spawn`).toBe(false);
    // points of interest are solid buildings except open ground (parks, beaches)
    const b = world.pois.find((q: any) => q.enterable)!; expect(isBlocked(b.x + b.sx / 2 - 0.1, b.z, col, () => true, world.bounds)).toBe(true);   // walls are solid (the inside is walkable)
    // no two areas overlap, no landmark sits inside a district
    for (const p of world.pois) for (const d of world.districts) expect(p.x + p.sx / 2 < d.bounds.minX || p.x - p.sx / 2 > d.bounds.maxX || p.z + p.sz / 2 < d.bounds.minZ || p.z - p.sz / 2 > d.bounds.maxZ, `${p.name} in ${d.id}`).toBe(true);
  });
  it('walking from one area into another changes your area, prices and place name; vehicles teleport within the metro', async () => {
    const p = await w.newPlayer('Wanderer'); const c = await join(p);
    const world = w.ctx.data.worlds.get('lagos')!;
    const lekki = world.districts.find((d: any) => d.id === 'lekki');
    me(p).x = lekki.spawn.x; me(p).z = lekki.spawn.z; gw.step(0.05);
    await c.until(() => c.of('area').length > 0);
    expect(c.last('area').city.id).toBe('lekki'); expect(c.last('area').currency.code).toBe('NGN');
    expect(me(p).city).toBe('lekki');
    await new Promise((r) => setTimeout(r, 300));
    expect((await w.ctx.pool.query('SELECT city FROM characters WHERE id=$1', [p.characterId])).rows[0].city).toBe('lagos');   // saved on the next autosave, not every step
    await give(p, 500);
    c.send({ t: 'travel', to: 'ikeja', mode: 'car' });
    await c.until(() => c.of('travel').length > 0);
    await finishTrip(p);
    await c.until(() => c.of('arrived').length > 0);
    expect(me(p).city).toBe('ikeja'); expect(c.of('welcome').length).toBe(1);   // no world reload inside the same metro
    const ik = world.districts.find((d: any) => d.id === 'ikeja');
    expect(Math.hypot(me(p).x - ik.spawn.x, me(p).z - ik.spawn.z)).toBeLessThan(3);
  });
  it('landmark businesses are real shops: every shop zone has a shop with stock in the area\'s price level', async () => {
    const world = w.ctx.data.worlds.get('lagos')!;
    const poiShops = world.zones.filter((z: any) => z.kind === 'shop' && z.poi);
    expect(poiShops.length).toBeGreaterThanOrEqual(8);
    for (const z of poiShops) {
      expect(w.ctx.data.shops.some((s) => s.id === z.shopId), z.id).toBe(true);
      expect(z.items.length).toBeGreaterThan(0); expect(z.items[0].label.length).toBeGreaterThan(2);
      expect((await w.ctx.pool.query('SELECT count(*)::int n FROM shop_stock WHERE shop_id=$1', [z.shopId])).rows[0].n).toBeGreaterThan(0);
    }
    const ikoyiCafe = w.ctx.data.shops.find((s) => s.id === 'shop_ikoyi_cafe')!, surulereCafe = w.ctx.data.shops.find((s) => s.id === 'shop_surulere_cafe') ?? w.ctx.data.shops.find((s) => s.id === 'shop_lagos_cafe');
    expect(ikoyiCafe.stock.find((x: any) => x.itemId === 'coffee')!.price).toBeGreaterThan(surulereCafe ? surulereCafe.stock.find((x: any) => x.itemId === 'coffee')!.price : 0);
  });
  it('you can walk up to a cafe in another area of the city and buy a coffee there, priced in the area', async () => {
    const p = await w.newPlayer('Coffee Fan'); const c = await join(p);
    const world = w.ctx.data.worlds.get('lagos')!;
    const z = world.zones.find((q: any) => q.poi && q.shopId === 'shop_ikoyi_cafe') ?? world.zones.find((q: any) => q.poi && q.area === 'ikoyi' && q.shopType === 'cafe');
    expect(z, 'an Ikoyi cafe exists').toBeTruthy();
    me(p).x = z.x; me(p).z = z.z; gw.step(0.05);
    await new Promise((r) => setTimeout(r, 300));
    const before = (await summary(p)).balance;
    c.send({ t: 'interact', zone: z.id, item: 'coffee' });
    await c.until(() => c.of('toast').some((m) => /Bought/.test(m.text)));
    const paid = before - (await summary(p)).balance;
    expect(paid).toBe(w.ctx.data.shops.find((s) => s.id === z.shopId)!.stock.find((x: any) => x.itemId === 'coffee')!.price);
    expect(paid).toBeGreaterThan(15);   // Ikoyi is pricier than the base 15 MVC
    await new Promise((r) => setTimeout(r, 350));
    c.send({ t: 'interact', zone: z.id, item: 'diamond' });   // not on the menu
    await c.until(() => c.of('toast').some((m) => m.kind === 'error'));
  });
  it('city bus and taxi: fare by distance, a short journey, dropped at the door; bad targets and short hops are refused', async () => {
    const p = await w.newPlayer('Commuter'); const c = await join(p);
    const world = w.ctx.data.worlds.get('lagos')!;
    const ik = world.pois.find((q: any) => q.district === 'ikoyi' && q.business)!;
    const front = { x: ik.x, z: ik.z + (ik.face === '+z' ? 1 : -1) * (ik.sz / 2 + 1.6) };
    const before = (await summary(p)).balance;
    c.send({ t: 'transit', mode: 'bus', x: me(p).x + 5, z: me(p).z }); await c.until(() => c.of('toast').some((m) => m.kind === 'error'));   // too close: walk
    expect((await summary(p)).balance).toBe(before);
    c.send({ t: 'transit', mode: 'bus', x: 99999, z: 0 }); await new Promise((r) => setTimeout(r, 200));
    c.send({ t: 'transit', mode: 'bus', x: ik.x + ik.sx / 2 - 0.1, z: ik.z });                  // inside a solid wall
    await c.until(() => c.of('toast').filter((m) => m.kind === 'error').length > 1);
    expect((await summary(p)).balance).toBe(before);
    const meters = Math.hypot(front.x - me(p).x, front.z - me(p).z);
    c.send({ t: 'transit', mode: 'bus', x: front.x, z: front.z, name: ik.name });
    await c.until(() => c.of('travel').length > 0);
    const q = (await import('../src/modules/travel/local.js')).localQuote(w.ctx, meters).find((o) => o.mode === 'bus')!;
    expect(before - (await summary(p)).balance).toBe(q.fare);
    expect(c.last('travel').local).toBe(true);
    c.send({ t: 'transit', mode: 'car', x: front.x, z: front.z }); await c.until(() => c.of('toast').some((m) => /journey/i.test(m.text)));   // one journey at a time
    await finishTrip(p);
    await c.until(() => c.of('arrived').length > 0);
    expect(Math.hypot(me(p).x - front.x, me(p).z - front.z)).toBeLessThan(0.5);
    expect(me(p).city).toBe(districtAt(world, front.x, front.z) ?? 'lagos');   // landmarks in the gaps keep your current area

    expect((await verifyLedgerIntegrity(w.ctx.pool)).ok).toBe(true);
  });
  it('bike: a one-off rental fee then a server-side speed boost that ends on its own; you cannot be charged twice while riding', async () => {
    const p = await w.newPlayer('Cyclist'); const c = await join(p);
    const before = (await summary(p)).balance;
    c.send({ t: 'ride', on: true }); await c.until(() => c.of('ride').length > 0);
    expect((await summary(p)).balance).toBe(before - w.ctx.data.geo.localTransport.bike.fee);
    c.send({ t: 'ride', on: true }); await new Promise((r) => setTimeout(r, 300));
    expect((await summary(p)).balance).toBe(before - w.ctx.data.geo.localTransport.bike.fee);   // not charged again
    const x0 = me(p).x; me(p).input = { dx: 1, dz: 0, run: false }; me(p).lastInputAt = Date.now();
    for (let i = 0; i < 20; i++) gw.step(0.05);
    const fast = me(p).x - x0;
    c.send({ t: 'ride', on: false }); await c.until(() => c.of('ride').some((m) => m.on === false));
    me(p).x = x0; me(p).input = { dx: 1, dz: 0, run: false }; me(p).lastInputAt = Date.now();
    for (let i = 0; i < 20; i++) gw.step(0.05);
    const slow = me(p).x - x0;
    expect(fast / slow).toBeGreaterThan(2);
  });
  it('public buildings are real places: open doorway, furnished inside, staff at the counter, customers wandering the walkway', async () => {
    const world = w.ctx.data.worlds.get('lagos')!; const col = buildColliders(world);
    const pubs = world.buildings.filter((b: any) => b.kind === 'public');
    expect(pubs.length).toBeGreaterThanOrEqual(20);
    for (const b of pubs) {
      const f = b.doorSide === '+z' ? 1 : -1;
      for (const dv of [b.sz / 2 + 1, b.sz / 2 - 0.15, b.sz / 2 - 1.2, 0]) expect(isBlocked(b.cx, b.cz + f * dv, col, () => false, world.bounds), `${b.name} doorway ${dv}`).toBe(false);   // no key needed
      expect(isBlocked(b.cx + b.sx / 2 - 0.1, b.cz, col, () => true, world.bounds), `${b.name} wall`).toBe(true);
    }
    const specs = world.npcSpecs;
    expect(specs.filter((s: any) => s.role === 'Staff').length).toBeGreaterThanOrEqual(25);
    expect(specs.filter((s: any) => s.kind === 'wander').reduce((n: number, s: any) => n + s.count, 0)).toBeGreaterThanOrEqual(80);
    for (const s of specs) if (s.kind === 'stand') expect(isBlocked(s.x, s.z, col, () => false, world.bounds), `staff of ${s.poi}`).toBe(false);
    // the bank has a teller zone that opens the Vault
    const bank = world.zones.find((z: any) => z.kind === 'service' && z.bank); expect(bank).toBeTruthy();
    expect(isBlocked(bank.x, bank.z, col, () => false, world.bounds)).toBe(false);
  });
  it('people really are inside: customers wander within their building and never walk through walls', async () => {
    const p = await w.newPlayer('Visitor'); const c = await join(p);
    const world = w.ctx.data.worlds.get('lagos')!; const col = buildColliders(world);
    const bankB = world.buildings.find((b: any) => b.kind === 'public' && b.short === 'bank')!; me(p).x = bankB.cx; me(p).z = bankB.cz; gw.step(0.05);
    for (let i = 0; i < 400; i++) gw.step(0.05);   // 20 simulated seconds
    await c.until(() => c.of('snap').some((s) => s.spawns.some((x: any) => x.npc && x.role === 'Customer')) && c.of('snap').some((s) => s.spawns.some((x: any) => x.npc && x.role === 'Staff')));
    const rt = (gw as any).rt('lagos');
    const people = rt.npcs.filter((n: any) => n.mode === 'wander' && n.id.includes(bankB.id));
    expect(people.length).toBeGreaterThan(1);
    for (const n of people) expect(isBlocked(n.x, n.z, col, () => false, world.bounds), `${n.id} inside a wall`).toBe(false);
    expect(people.some((n: any) => n.moving || n.wait > 0)).toBe(true);
  });
  it('people in the same building hear each other; people outside do not hear inside, and vice versa', async () => {
    const a = await w.newPlayer('Teller Fan'); const b = await w.newPlayer('Queue Pal'); const o = await w.newPlayer('Outside Oz');
    const [ca, cb, co] = [await join(a), await join(b), await join(o)];
    const world = w.ctx.data.worlds.get('lagos')!;
    const bk = world.buildings.find((x: any) => x.kind === 'public' && x.short === 'bank')!;
    me(a).x = bk.cx - 1; me(a).z = bk.cz; me(b).x = bk.cx + 1; me(b).z = bk.cz;
    me(o).x = bk.cx; me(o).z = bk.cz + bk.sz / 2 + 4;           // just outside the doorway, well within 25 m
    ca.send({ t: 'chat', text: 'queue is long today' });
    await cb.until(() => cb.of('chat').length > 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(co.of('chat')).toHaveLength(0);
    co.send({ t: 'chat', text: 'hello from the pavement' });
    await co.until(() => co.of('chat').length > 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.of('chat')).toHaveLength(1); expect(ca.of('chat').filter((m) => m.text.includes('pavement'))).toHaveLength(0);
    ca.close(); cb.close(); co.close();
  });
});

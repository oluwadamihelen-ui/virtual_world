import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, key, type TestWorld } from './helpers.js';
import { sweepTenancies } from '../src/modules/housing/housing.js';
import { verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';

let w: TestWorld;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });
const HOUR = 3600_000;

const rent = (cid: string, propertyId: string, k = key()) => w.gameReq('POST', `/v1/game/characters/${cid}/rent`, { propertyId, idempotencyKey: k });
const summary = async (cid: string) => (await w.gameReq('GET', `/v1/game/characters/${cid}/summary`)).body;
const prop = async (id: string) => (await w.gameReq('GET', '/v1/game/world/properties')).body.properties.find((p: any) => p.propertyId === id);

describe('renting', () => {
  it('rents a property: pays rent, grants access, shows in listing as unavailable', async () => {
    const p = await w.newPlayer();
    expect((await prop('prop_resi_room_101')).available).toBe(true);
    const r = await rent(p.characterId, 'prop_resi_room_101');
    expect(r.status).toBe(200);
    expect(r.body.rentPaid).toBe(500);
    const s = await summary(p.characterId);
    expect(s.balance).toBe(1500);
    expect(s.tenancy).toMatchObject({ propertyId: 'prop_resi_room_101', status: 'active' });
    expect((await prop('prop_resi_room_101')).available).toBe(false);
    expect((await w.gameReq('GET', `/v1/game/properties/prop_resi_room_101/access/${p.characterId}`)).body.allowed).toBe(true);
    const other = await w.newPlayer();
    expect((await w.gameReq('GET', `/v1/game/properties/prop_resi_room_101/access/${other.characterId}`)).body.allowed).toBe(false);
    expect((await w.gameReq('GET', `/v1/game/characters/${p.characterId}/rent-history`)).body.payments).toHaveLength(1);
  });

  it('duplicate rent request does not charge twice', async () => {
    const p = await w.newPlayer();
    const k = key();
    const [a, b] = await Promise.all([rent(p.characterId, 'prop_resi_room_102', k), rent(p.characterId, 'prop_resi_room_102', k)]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.body.tenancyId).toBe(b.body.tenancyId);
    expect((await summary(p.characterId)).balance).toBe(1500);
  });

  it('simultaneous attempts to claim one exclusive property: exactly one wins, losers pay nothing', async () => {
    const players = await Promise.all(Array.from({ length: 8 }, () => w.newPlayer()));
    const results = await Promise.all(players.map((p) => rent(p.characterId, 'prop_resi_apt_201')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    for (let i = 0; i < players.length; i++) {
      expect((await summary(players[i]!.characterId)).balance).toBe(results[i]!.status === 200 ? 2000 - 900 : 2000);
    }
  });

  it('one player cannot hold two tenancies; one player racing two properties gets one', async () => {
    const p = await w.newPlayer();
    // already taken properties above; use a fresh world state for clarity
    const all = (await w.gameReq('GET', '/v1/game/world/properties')).body.properties.filter((x: any) => x.available);
    expect(all.length).toBeGreaterThan(1);
    const first = await rent(p.characterId, all[0].propertyId);
    expect(first.status).toBe(200);
    const second = await rent(p.characterId, 'prop_resi_apt_201');
    expect(second.status).toBe(409);
  });

  it('insufficient funds blocks renting and leaves the property available', async () => {
    const p = await w.newPlayer();
    await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'sandwich', quantity: 76, idempotencyKey: key() }); // 100 MVC left
    const free = (await w.gameReq('GET', '/v1/game/world/properties')).body.properties.find((x: any) => x.available);
    expect(free).toBeDefined();
    const r = await rent(p.characterId, free.propertyId);
    expect(r.status).toBe(402);
    expect((await prop(free.propertyId)).available).toBe(true);
    expect((await summary(p.characterId)).tenancy).toBeNull();
    expect((await summary(p.characterId)).balance).toBe(100);
  });
});

describe('furnishing', () => {
  it('enforces slot limits and returns items on removal', async () => {
    const p = await w.newPlayer();
    const free = (await w.gameReq('GET', '/v1/game/world/properties')).body.properties.find((x: any) => x.available);
    expect(free).toBeDefined();
    await rent(p.characterId, free.propertyId);
    const k = key();
    await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'desk_lamp', quantity: 1, idempotencyKey: k });
    // can't place what you don't own
    const bad = await w.gameReq('POST', `/v1/game/characters/${p.characterId}/furniture`, { itemId: 'starter_sofa', x: 1, y: 1, z: 0 });
    expect(bad.status).toBe(409);
    const ok = await w.gameReq('POST', `/v1/game/characters/${p.characterId}/furniture`, { itemId: 'desk_lamp', x: 1, y: 1, z: 0 });
    expect(ok.status).toBe(200);
    expect((await summary(p.characterId)).inventory.find((i: any) => i.itemId === 'desk_lamp')).toBeUndefined();
    expect((await summary(p.characterId)).furniture).toHaveLength(1);
    const rem = await w.gameReq('DELETE', `/v1/game/characters/${p.characterId}/furniture/${ok.body.furnitureId}`);
    expect(rem.status).toBe(200);
    expect((await summary(p.characterId)).inventory.find((i: any) => i.itemId === 'desk_lamp')?.quantity).toBe(1);
  });

  it('non-tenants cannot place furniture; non-furniture is refused', async () => {
    const p = await w.newPlayer();
    expect((await w.gameReq('POST', `/v1/game/characters/${p.characterId}/furniture`, { itemId: 'sandwich', x: 0, y: 0, z: 0 })).status).toBe(400);
    expect((await w.gameReq('POST', `/v1/game/characters/${p.characterId}/furniture`, { itemId: 'desk_lamp', x: 0, y: 0, z: 0 })).status).toBe(409);
  });
});

describe('rent lifecycle (autopay, grace, expiry)', () => {
  it('autopays when due and has funds; keeps tenancy', async () => {
    const w2 = w;
    try {
      const p = await w2.newPlayer();
      await w2.gameReq('POST', `/v1/game/characters/${p.characterId}/rent`, { propertyId: 'prop_resi_room_101', idempotencyKey: key() });
      w2.clock.t = new Date(w2.clock.t.getTime() + 169 * HOUR);
      await sweepTenancies(w2.ctx);
      await sweepTenancies(w2.ctx); // idempotent: second sweep must not double-charge
      const s = (await w2.gameReq('GET', `/v1/game/characters/${p.characterId}/summary`)).body;
      expect(s.balance).toBe(1000);
      expect(s.tenancy.status).toBe('active');
      expect((await w2.gameReq('GET', `/v1/game/characters/${p.characterId}/rent-history`)).body.payments).toHaveLength(2);
    } finally { /* world is closed in afterEach */ }
  });

  it('failed payment -> grace -> recovers if the player pays up; otherwise ends and releases the property without destroying belongings', async () => {
    const w2 = w;
    try {
      const p = await w2.newPlayer();
      const g = (m: string, u: string, b?: unknown) => w2.gameReq(m, u, b);
      await g('POST', `/v1/game/characters/${p.characterId}/rent`, { propertyId: 'prop_resi_room_101', idempotencyKey: key() });
      await g('POST', `/v1/game/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'desk_lamp', quantity: 1, idempotencyKey: key() });
      await g('POST', `/v1/game/characters/${p.characterId}/furniture`, { itemId: 'desk_lamp', x: 0, y: 0, z: 0 });
      // spend down so rent (500) cannot be paid
      await g('POST', `/v1/game/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'sandwich', quantity: 50, idempotencyKey: key() }); // leaves 130 MVC, below the 500 rent
      let s = (await g('GET', `/v1/game/characters/${p.characterId}/summary`)).body;
      expect(s.balance).toBeLessThan(500);

      w2.clock.t = new Date(w2.clock.t.getTime() + 169 * HOUR);
      await sweepTenancies(w2.ctx);
      s = (await g('GET', `/v1/game/characters/${p.characterId}/summary`)).body;
      expect(s.tenancy.status).toBe('grace');
      // still has access during grace
      expect((await g('GET', `/v1/game/properties/prop_resi_room_101/access/${p.characterId}`)).body.allowed).toBe(true);

      // after grace lapses with no funds -> ended
      w2.clock.t = new Date(w2.clock.t.getTime() + 49 * HOUR);
      await sweepTenancies(w2.ctx);
      s = (await g('GET', `/v1/game/characters/${p.characterId}/summary`)).body;
      expect(s.tenancy).toBeNull();
      expect(s.furniture).toHaveLength(0);
      expect(s.inventory.find((i: any) => i.itemId === 'desk_lamp')?.quantity).toBe(1); // furniture returned
      expect((await g('GET', '/v1/game/world/properties')).body.properties.find((x: any) => x.propertyId === 'prop_resi_room_101').available).toBe(true);
      expect((await g('GET', `/v1/game/properties/prop_resi_room_101/access/${p.characterId}`)).body.allowed).toBe(false);
      expect(await verifyLedgerIntegrity(w2.ctx.pool)).toMatchObject({ ok: true });
    } finally { /* world is closed in afterEach */ }
  });

  it('grace period: topping up during grace restores the tenancy on next sweep', async () => {
    const w2 = w;
    try {
      const p = await w2.newPlayer();
      const g = (m: string, u: string, b?: unknown) => w2.gameReq(m, u, b);
      await g('POST', `/v1/game/characters/${p.characterId}/rent`, { propertyId: 'prop_resi_room_101', idempotencyKey: key() });
      await g('POST', `/v1/game/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'sandwich', quantity: 60, idempotencyKey: key() });
      w2.clock.t = new Date(w2.clock.t.getTime() + 169 * HOUR);
      await sweepTenancies(w2.ctx);
      expect((await g('GET', `/v1/game/characters/${p.characterId}/summary`)).body.tenancy.status).toBe('grace');
      // earn money via an admin-audited grant (stand-in for wages)
      const admin = await w2.newPlayer();
      const tok = await w2.setRole(admin.accountId, 'admin');
      const adj = await w2.playerReq(tok, 'POST', '/v1/admin/adjustments', { characterId: p.characterId, delta: 600, reason: 'test top-up for grace recovery', idempotencyKey: key() });
      expect(adj.status).toBe(200);
      w2.clock.t = new Date(w2.clock.t.getTime() + 1 * HOUR);
      await sweepTenancies(w2.ctx);
      const s = (await g('GET', `/v1/game/characters/${p.characterId}/summary`)).body;
      expect(s.tenancy.status).toBe('active');
      expect(s.tenancy.graceUntil).toBeNull();
    } finally { /* world is closed in afterEach */ }
  });

  it('suspended players do not lose their home while suspended', async () => {
    const w2 = w;
    try {
      const p = await w2.newPlayer();
      await w2.gameReq('POST', `/v1/game/characters/${p.characterId}/rent`, { propertyId: 'prop_resi_room_101', idempotencyKey: key() });
      await w2.ctx.pool.query(`UPDATE accounts SET status='suspended', suspended_until=$2 WHERE id=$1`, [p.accountId, new Date(w2.clock.t.getTime() + 1000 * HOUR)]);
      await w2.ctx.pool.query(`UPDATE ledger_accounts SET balance=0 WHERE owner_ref=$1`, [p.characterId]);
      w2.clock.t = new Date(w2.clock.t.getTime() + 500 * HOUR);
      await sweepTenancies(w2.ctx);
      const t = (await w2.ctx.pool.query('SELECT status FROM tenancies')).rows[0];
      expect(t.status).toBe('active');
    } finally { /* world is closed in afterEach */ }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, key, SERVER_KEY, type TestWorld } from './helpers.js';
import { buildApp } from '../src/app.js';
import { verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';

/**
 * Backend half of the milestone-1 acceptance criteria (docs/MILESTONES.md).
 * Steps that need the 3D client (launch, movement, player interaction in-world) are verified in-engine.
 */
let w: TestWorld;
beforeAll(async () => { w = await createWorld(); });
afterAll(async () => { await w.close(); });

describe('vertical slice, end to end through HTTP, including a backend restart', () => {
  it('create character -> join -> rent -> work -> buy -> disconnect -> restart -> reconnect with everything preserved', async () => {
    // 2. create a character
    const p = await w.newPlayer('Slice Tester');
    const cid = p.characterId;
    const g = w.gameReq;

    // 3. connect to a session (game server asks backend to admit the character)
    const joined = await g('POST', `/v1/game/characters/${cid}/join`);
    expect(joined.body).toMatchObject({ displayName: 'Slice Tester', balance: 2000, tenancy: null });

    // 6/7. access + rent the apartment with MVC
    expect((await g('GET', `/v1/game/properties/prop_resi_room_101/access/${cid}`)).body.allowed).toBe(false);
    expect((await g('POST', `/v1/game/characters/${cid}/rent`, { propertyId: 'prop_resi_room_101', idempotencyKey: key() })).status).toBe(200);
    expect((await g('GET', `/v1/game/properties/prop_resi_room_101/access/${cid}`)).body.allowed).toBe(true);

    // 8. complete a job, earn MVC
    const shift = (await g('POST', `/v1/game/characters/${cid}/shifts`, { jobId: 'job_grocery_assistant' })).body;
    for (let i = 0; i < shift.tasksRequired; i++) {
      w.clock.t = new Date(w.clock.t.getTime() + 21_000);
      await g('POST', `/v1/game/characters/${cid}/shifts/${shift.shiftId}/task`);
    }
    expect((await g('POST', `/v1/game/characters/${cid}/shifts/${shift.shiftId}/complete`)).body.wage).toBe(250);

    // 9. buy an item from a shop
    expect((await g('POST', `/v1/game/characters/${cid}/shops/shop_corner_grocery/purchase`, { itemId: 'starter_sofa', quantity: 1, idempotencyKey: key() })).status).toBe(200);
    await g('PUT', `/v1/game/characters/${cid}/position`, { district: 'residential', x: 120.5, y: -33, z: 90 });
    const before = (await g('GET', `/v1/game/characters/${cid}/summary`)).body;

    // 10. disconnect + the whole backend process restarts (new app, new pool, same database)
    await w.app.close();
    const app2 = await buildApp(w.ctx, { rateLimit: false });
    const after = JSON.parse((await app2.inject({ method: 'POST', url: `/v1/game/characters/${cid}/join`, headers: { 'x-server-key': SERVER_KEY } })).body);

    // 11. confirmed balance, rental access, inventory, progression, position preserved
    expect(after.balance).toBe(2000 - 500 + 250 - 350);
    expect(after).toEqual(before);
    expect(after.tenancy.propertyId).toBe('prop_resi_room_101');
    expect(after.inventory).toEqual([{ itemId: 'starter_sofa', quantity: 1 }]);
    expect(after.skills).toEqual([{ skillId: 'retail', xp: 10 }]);
    expect(after.location).toMatchObject({ x: 120.5, y: -33, z: 90 });
    expect(await verifyLedgerIntegrity(w.ctx.pool)).toMatchObject({ ok: true, total: 0 });
    await app2.close();
  });
});

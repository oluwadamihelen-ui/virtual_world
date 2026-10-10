import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, key, type TestWorld } from './helpers.js';
import { verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';

let w: TestWorld;
beforeAll(async () => { w = await createWorld(); });
afterAll(async () => { await w.close(); });

const buy = (cid: string, itemId: string, quantity: number, k = key(), extra: object = {}) =>
  w.gameReq('POST', `/v1/game/characters/${cid}/shops/shop_corner_grocery/purchase`, { itemId, quantity, idempotencyKey: k, ...extra });
const summary = async (cid: string) => (await w.gameReq('GET', `/v1/game/characters/${cid}/summary`)).body;

describe('wallet & purchases', () => {
  it('new character receives the configured starting balance via the ledger', async () => {
    const p = await w.newPlayer();
    expect((await summary(p.characterId)).balance).toBe(2000);
    const led = (await w.gameReq('GET', `/v1/game/characters/${p.characterId}/ledger`)).body.entries;
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ type: 'starting_grant', delta: 2000, balance_after: 2000 });
  });

  it('purchase debits, grants item, and survives a "reconnect" (fresh read of persisted state)', async () => {
    const p = await w.newPlayer();
    const r = await buy(p.characterId, 'sandwich', 2);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ totalPrice: 50, balance: 1950 });
    const s = (await w.gameReq('POST', `/v1/game/characters/${p.characterId}/join`)).body;
    expect(s.balance).toBe(1950);
    expect(s.inventory).toEqual([{ itemId: 'sandwich', quantity: 2 }]);
  });

  it('rejects insufficient funds without side effects', async () => {
    const p = await w.newPlayer();
    const r = await buy(p.characterId, 'sandwich', 99); // 99 x 25 = 2475 > 2000
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('insufficient_funds');
    const s = await summary(p.characterId);
    expect(s.balance).toBe(2000);
    expect(s.inventory).toEqual([]);
  });

  it('a failed payment does not consume limited stock (atomicity)', async () => {
    const p = await w.newPlayer();
    await buy(p.characterId, 'sandwich', 76); // 1900 spent, 100 left
    const lampQty = async () => (await w.gameReq('GET', '/v1/game/world/shops/shop_corner_grocery')).body.stock.find((x: any) => x.itemId === 'desk_lamp').quantity;
    const before = await lampQty();
    const r = await buy(p.characterId, 'desk_lamp', 1); // 120 > 100
    expect(r.status).toBe(402);
    expect(await lampQty()).toBe(before);
    expect((await summary(p.characterId)).balance).toBe(100);
  });

  it('duplicate request with the same idempotency key does not charge twice', async () => {
    const p = await w.newPlayer();
    const k = key();
    const a = await buy(p.characterId, 'sandwich', 1, k);
    const b = await buy(p.characterId, 'sandwich', 1, k);
    expect(a.body.txId).toBe(b.body.txId);
    expect(b.body.replayed).toBe(true);
    const s = await summary(p.characterId);
    expect(s.balance).toBe(2000 - 25);
    expect(s.inventory).toEqual([{ itemId: 'sandwich', quantity: 1 }]);
  });

  it('50 concurrent retries of one request charge exactly once', async () => {
    const p = await w.newPlayer();
    const k = key();
    const results = await Promise.all(Array.from({ length: 50 }, () => buy(p.characterId, 'sandwich', 1, k)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.txId)).size).toBe(1);
    expect((await summary(p.characterId)).balance).toBe(1975);
  });

  it('reusing a key for a different request is rejected', async () => {
    const p = await w.newPlayer();
    const k = key();
    await buy(p.characterId, 'sandwich', 1, k);
    const r = await buy(p.characterId, 'bottled_water', 1, k);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('idempotency_key_reused');
  });

  it('ignores any client-supplied price', async () => {
    const p = await w.newPlayer();
    const r = await buy(p.characterId, 'sandwich', 1, key(), { price: 1, totalPrice: 0, amount: -500 });
    expect(r.body.totalPrice).toBe(25);
    expect((await summary(p.characterId)).balance).toBe(1975);
  });

  it('validates quantities', async () => {
    const p = await w.newPlayer();
    for (const q of [0, -3, 1.5, 100]) expect((await buy(p.characterId, 'sandwich', q)).status).toBe(400);
    expect((await buy(p.characterId, 'nonexistent', 1)).status).toBe(404);
    expect((await summary(p.characterId)).balance).toBe(2000);
  });

  it('simultaneous purchases of exclusive stock: exactly the available quantity succeeds', async () => {
    const players = await Promise.all(Array.from({ length: 6 }, () => w.newPlayer()));
    const stockBefore = (await w.gameReq('GET', '/v1/game/world/shops/shop_corner_grocery')).body.stock.find((x: any) => x.itemId === 'desk_lamp').quantity;
    const results = await Promise.all(players.map((p) => buy(p.characterId, 'desk_lamp', 1)));
    const ok = results.filter((r) => r.status === 200).length;
    const soldOut = results.filter((r) => r.status === 409 && r.body.error === 'out_of_stock').length;
    expect(ok).toBe(Math.min(stockBefore, 6));
    expect(ok + soldOut).toBe(6);
    const stockAfter = (await w.gameReq('GET', '/v1/game/world/shops/shop_corner_grocery')).body.stock.find((x: any) => x.itemId === 'desk_lamp').quantity;
    expect(stockAfter).toBe(stockBefore - ok);
    // Losers were not charged.
    for (let i = 0; i < players.length; i++) {
      expect((await summary(players[i]!.characterId)).balance).toBe(results[i]!.status === 200 ? 2000 - 120 : 2000);
    }
  });

  it('parallel spending from one wallet can never overdraw it', async () => {
    const p = await w.newPlayer();
    const results = await Promise.all(Array.from({ length: 100 }, () => buy(p.characterId, 'sandwich', 1))); // 100 x 25 > 2000
    expect(results.filter((r) => r.status === 200)).toHaveLength(80);
    expect(results.filter((r) => r.status === 402)).toHaveLength(20);
    const s = await summary(p.characterId);
    expect(s.balance).toBe(0);
    expect(s.inventory).toEqual([{ itemId: 'sandwich', quantity: 80 }]);
  });

  it('ledger stays globally consistent after all of the above', async () => {
    const v = await verifyLedgerIntegrity(w.ctx.pool);
    expect(v).toMatchObject({ ok: true, total: 0, driftedAccounts: 0, unbalancedTransactions: 0 });
  });
});

describe('database-level protections', () => {
  it('ledger entries are append-only', async () => {
    await expect(w.ctx.pool.query('UPDATE ledger_entries SET delta = delta + 1')).rejects.toThrow(/append-only/);
    await expect(w.ctx.pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only/);
  });

  it('an unbalanced ledger transaction cannot commit', async () => {
    const p = await w.newPlayer();
    const acct = (await w.ctx.pool.query(`SELECT id FROM ledger_accounts WHERE owner_ref=$1`, [p.characterId])).rows[0].id;
    const c = await w.ctx.pool.connect();
    try {
      await c.query('BEGIN');
      const t = (await c.query(`INSERT INTO ledger_transactions (type,idempotency_key,request_hash,amount) VALUES ('x',$1,'h',5) RETURNING id`, [key()])).rows[0].id;
      await c.query('INSERT INTO ledger_entries (tx_id,account_id,delta,balance_after) VALUES ($1,$2,5,5)', [t, acct]);
      await expect(c.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });

  it('negative balances are rejected by the schema itself', async () => {
    const p = await w.newPlayer();
    await expect(w.ctx.pool.query(`UPDATE ledger_accounts SET balance=-1 WHERE owner_ref=$1`, [p.characterId])).rejects.toThrow(/balance_non_negative/);
  });
});

describe('trust boundary', () => {
  it('game endpoints reject missing/incorrect server keys and player JWTs', async () => {
    const p = await w.newPlayer();
    const url = `/v1/game/characters/${p.characterId}/shops/shop_corner_grocery/purchase`;
    const body = { itemId: 'sandwich', quantity: 1, idempotencyKey: key() };
    expect((await w.app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(401);
    expect((await w.app.inject({ method: 'POST', url, payload: body, headers: { 'x-server-key': 'wrong-wrong-wrong-wrong-wrong' } })).statusCode).toBe(401);
    expect((await w.app.inject({ method: 'POST', url, payload: body, headers: { authorization: `Bearer ${p.token}` } })).statusCode).toBe(401);
    expect((await summary(p.characterId)).balance).toBe(2000);
  });

  it('players cannot read other players\' summaries or call admin routes', async () => {
    const a = await w.newPlayer(); const b = await w.newPlayer();
    expect((await w.playerReq(a.token, 'GET', `/v1/characters/${b.characterId}/summary`)).status).toBe(404);
    expect((await w.playerReq(a.token, 'POST', '/v1/admin/adjustments', { characterId: a.characterId, delta: 1_000_000, reason: 'give me money please', idempotencyKey: key() })).status).toBe(403);
    expect((await summary(a.characterId)).balance).toBe(2000);
  });
});

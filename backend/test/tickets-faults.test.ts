import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { createWorld, key, type TestWorld } from './helpers.js';
import { withTx } from '../src/db.js';
import { claim, post, playerAccount, systemAccount, verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';
import { addItem } from '../src/modules/inventory/inventory.js';

let w: TestWorld;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });

const ticketFor = async (p: { token: string; characterId: string }) =>
  (await w.playerReq(p.token, 'POST', `/v1/characters/${p.characterId}/join-ticket`)).body.ticket as string;
const redeem = (ticket: string) => w.gameReq('POST', '/v1/game/tickets/redeem', { ticket });

describe('join tickets', () => {
  it('owner gets a ticket; server redeems it once and receives the character', async () => {
    const p = await w.newPlayer('Ticket Holder');
    const t = await ticketFor(p);
    const r = await redeem(t);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ characterId: p.characterId, displayName: 'Ticket Holder', balance: 2000 });
    const again = await redeem(t);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('ticket_already_used');
  });

  it('50 concurrent redemptions of one ticket: exactly one succeeds', async () => {
    const p = await w.newPlayer();
    const t = await ticketFor(p);
    const rs = await Promise.all(Array.from({ length: 50 }, () => redeem(t)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(49);
  });

  it('cannot get a ticket for someone else\'s character', async () => {
    const a = await w.newPlayer(); const b = await w.newPlayer();
    const r = await w.playerReq(a.token, 'POST', `/v1/characters/${b.characterId}/join-ticket`);
    expect(r.status).toBe(404);
  });

  it('expires after 60 seconds', async () => {
    const p = await w.newPlayer();
    const t = await ticketFor(p);
    w.clock.t = new Date(w.clock.t.getTime() + 61_000);
    const r = await redeem(t);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_ticket');
  });

  it('rejects tampered tickets, login tokens, and tickets signed with another key', async () => {
    const p = await w.newPlayer(); const other = await w.newPlayer();
    const t = await ticketFor(p);
    const [h, body, sig] = t.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), sub: other.characterId })).toString('base64url');
    expect((await redeem(`${h}.${forgedBody}.${sig}`)).status).toBe(401);
    expect((await redeem(p.token)).status).toBe(401); // a normal login JWT is not a ticket
    const now = Math.floor(w.clock.t.getTime() / 1000);
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(other.characterId).setAudience('mvw-join-ticket')
      .setJti(key()).setIssuedAt(now).setExpirationTime(now + 60).sign(new TextEncoder().encode('attacker-key-attacker-key-attacker-key'));
    expect((await redeem(forged)).status).toBe(401);
    expect((await w.app.inject({ method: 'POST', url: '/v1/game/tickets/redeem', payload: { ticket: t } })).statusCode).toBe(401); // no server key
  });

  it('banned and suspended players cannot obtain or redeem tickets', async () => {
    const p = await w.newPlayer();
    const t = await ticketFor(p);
    await w.ctx.pool.query(`UPDATE accounts SET status='suspended', suspended_until=$2 WHERE id=$1`, [p.accountId, new Date(w.clock.t.getTime() + 3600_000)]);
    expect((await redeem(t)).status).toBe(403);
    expect((await w.playerReq(p.token, 'POST', `/v1/characters/${p.characterId}/join-ticket`)).status).toBe(403);
  });
});

describe('fault injection: failures never leave partial or corrupt money state', () => {
  const bal = async (cid: string) => (await w.gameReq('GET', `/v1/game/characters/${cid}/summary`)).body;

  it('an error after the payment posted rolls back payment, stock and inventory together', async () => {
    const p = await w.newPlayer();
    await expect(withTx(w.ctx.pool, async (tx) => {
      const c = await claim(tx, { key: 'fault-1', type: 'shop_purchase', amount: 25, payload: {} });
      if (c.replay) return;
      await post(tx, c.txId, [{ account: playerAccount(p.characterId), delta: -25 }, { account: systemAccount('shop:shop_corner_grocery'), delta: 25 }]);
      await addItem(tx, p.characterId, 'sandwich', 1);
      throw new Error('simulated crash after payment, before commit');
    })).rejects.toThrow(/simulated crash/);
    const s = await bal(p.characterId);
    expect(s.balance).toBe(2000);
    expect(s.inventory).toEqual([]);
    expect((await w.ctx.pool.query(`SELECT 1 FROM ledger_transactions WHERE idempotency_key='fault-1'`)).rowCount).toBe(0);
    // the same intent can still be retried cleanly with the same key
    const ok = await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'sandwich', quantity: 1, idempotencyKey: 'fault-key-0001' });
    expect(ok.status).toBe(200);
    expect(await verifyLedgerIntegrity(w.ctx.pool)).toMatchObject({ ok: true });
  });

  it('killing the database connection mid-transaction (server-side termination) loses nothing and corrupts nothing', async () => {
    const p = await w.newPlayer();
    const client = await w.ctx.pool.connect();
    client.on('error', () => {}); // the terminated backend emits an error event; expected
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    try {
      await client.query('BEGIN');
      const c = await claim(client, { key: 'fault-2', type: 'shop_purchase', amount: 25, payload: {} });
      if (c.replay) throw new Error('unexpected');
      await post(client, c.txId, [{ account: playerAccount(p.characterId), delta: -25 }, { account: systemAccount('shop:shop_corner_grocery'), delta: 25 }]);
      await w.ctx.pool.query('SELECT pg_terminate_backend($1)', [pid]); // pull the plug
      await expect(client.query('COMMIT')).rejects.toThrow();
    } finally { client.release(true); }
    expect((await bal(p.characterId)).balance).toBe(2000);
    expect((await w.ctx.pool.query(`SELECT 1 FROM ledger_transactions WHERE idempotency_key='fault-2'`)).rowCount).toBe(0);
    expect(await verifyLedgerIntegrity(w.ctx.pool)).toMatchObject({ ok: true, total: 0 });
  });

  it('a client that times out and retries (original request actually committed) is not double-charged', async () => {
    const p = await w.newPlayer();
    const k = 'retry-after-timeout-1';
    const url = `/v1/game/characters/${p.characterId}/shops/shop_corner_grocery/purchase`;
    const first = await w.gameReq('POST', url, { itemId: 'sandwich', quantity: 1, idempotencyKey: k }); // pretend the response was lost
    expect(first.status).toBe(200);
    const retry = await w.gameReq('POST', url, { itemId: 'sandwich', quantity: 1, idempotencyKey: k });
    expect(retry.body).toMatchObject({ replayed: true, txId: first.body.txId, balance: 1975 });
    expect((await bal(p.characterId)).balance).toBe(1975);
  });

  it('constraint violations from a buggy caller cannot create money or negative stock', async () => {
    const p = await w.newPlayer();
    await expect(w.ctx.pool.query(`UPDATE shop_stock SET quantity=-1 WHERE item_id='desk_lamp'`)).rejects.toThrow();
    await expect(w.ctx.pool.query(`INSERT INTO inventory_items (character_id,item_id,quantity) VALUES ($1,'x',-5)`, [p.characterId])).rejects.toThrow();
    await expect(w.ctx.pool.query(`UPDATE ledger_accounts SET balance=balance+1000000 WHERE owner_ref=$1`, [p.characterId]).then(() => verifyLedgerIntegrity(w.ctx.pool)))
      .resolves.toMatchObject({ ok: false }); // direct tampering is *detected* by the integrity check
  });
});

describe('production hardening', () => {
  it('dev console, dev cheats and bare-id join do not exist when NODE_ENV=production', async () => {
    const { buildApp } = await import('../src/app.js');
    const prod = await buildApp({ ...w.ctx, config: { ...w.ctx.config, NODE_ENV: 'production' } }, { rateLimit: false });
    try {
      const p = await w.newPlayer();
      const h = { 'x-server-key': w.ctx.config.SERVER_API_KEY };
      expect((await prod.inject({ method: 'GET', url: '/dev' })).statusCode).toBe(404);
      expect((await prod.inject({ method: 'POST', url: '/v1/dev/grant', headers: h, payload: { characterId: p.characterId, amount: 100 } })).statusCode).toBe(404);
      expect((await prod.inject({ method: 'POST', url: '/v1/dev/run-customers', headers: h, payload: {} })).statusCode).toBe(404);
      expect((await prod.inject({ method: 'POST', url: `/v1/game/characters/${p.characterId}/join`, headers: h, payload: {} })).statusCode).toBe(404);
      // ticket flow still works in production
      const t = (await w.playerReq(p.token, 'POST', `/v1/characters/${p.characterId}/join-ticket`)).body.ticket;
      const r = await prod.inject({ method: 'POST', url: '/v1/game/tickets/redeem', headers: h, payload: { ticket: t } });
      expect(r.statusCode).toBe(200);
    } finally { await prod.close(); }
  });
});

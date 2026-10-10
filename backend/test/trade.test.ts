import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, key, type TestWorld } from './helpers.js';
import { verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';

let w: TestWorld;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });
const G = '/v1/game';
type P = { characterId: string };
const summary = async (p: P) => (await w.gameReq('GET', `${G}/characters/${p.characterId}/summary`)).body;
const buy = (p: P, itemId: string, quantity = 1) => w.gameReq('POST', `${G}/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId, quantity, idempotencyKey: key() });
const open = async (a: P, b: P) => (await w.gameReq('POST', `${G}/characters/${a.characterId}/trades`, { partnerId: b.characterId })).body.tradeId as string;
const offer = (p: P, t: string, mvc: number, items: { itemId: string; quantity: number }[] = []) => w.gameReq('PUT', `${G}/characters/${p.characterId}/trades/${t}/offer`, { mvc, items });
const confirm = (p: P, t: string, version: number) => w.gameReq('POST', `${G}/characters/${p.characterId}/trades/${t}/confirm`, { version });
const view = async (p: P, t: string) => (await w.gameReq('GET', `${G}/characters/${p.characterId}/trades/${t}`)).body;

async function pair() {
  const a = await w.newPlayer('Seller Sam'), b = await w.newPlayer('Buyer Bea');
  await buy(a, 'sandwich', 4);
  return { a, b };
}

describe('player trading', () => {
  it('swaps items for MVC atomically after both confirm; ledger stays balanced', async () => {
    const { a, b } = await pair(); // a has 4 sandwiches and 1900 MVC
    const t = await open(a, b);
    expect((await offer(a, t, 0, [{ itemId: 'sandwich', quantity: 3 }])).status).toBe(200);
    const v = (await offer(b, t, 150)).body.version;
    expect((await confirm(a, t, v)).body).toMatchObject({ status: 'open', waitingForPartner: true });
    const done = await confirm(b, t, v);
    expect(done.body.status).toBe('completed');
    const [sa, sb] = [await summary(a), await summary(b)];
    expect(sa.balance).toBe(1900 + 150); expect(sb.balance).toBe(2000 - 150);
    expect(sa.inventory).toEqual([{ itemId: 'sandwich', quantity: 1 }]);
    expect(sb.inventory).toEqual([{ itemId: 'sandwich', quantity: 3 }]);
    expect((await view(a, t)).status).toBe('completed');
    expect(await verifyLedgerIntegrity(w.ctx.pool)).toMatchObject({ ok: true, total: 0 });
    // re-confirming a finished trade is a harmless replay, never a second swap
    expect((await confirm(b, t, v)).body).toMatchObject({ status: 'completed', replayed: true });
    expect((await summary(b)).balance).toBe(1850);
  });

  it('bait-and-switch protection: changing an offer voids confirmations; stale versions are refused', async () => {
    const { a, b } = await pair();
    const t = await open(a, b);
    const v1 = (await offer(a, t, 0, [{ itemId: 'sandwich', quantity: 1 }])).body.version;
    await offer(b, t, 100);
    const v2 = (await view(a, t)).version;
    await confirm(b, t, v2);                       // Bea confirms trading 100 MVC for 1 sandwich
    const swap = await offer(a, t, 0, []);         // Sam secretly removes the sandwich
    expect(swap.body.version).toBeGreaterThan(v2);
    expect((await view(b, t)).iConfirmed).toBe(false);
    const late = await confirm(a, t, v2);          // Sam confirms the OLD version
    expect(late.status).toBe(409); expect(late.body.error).toBe('offer_changed');
    expect((await confirm(b, t, v1)).status).toBe(409);
    expect((await summary(b)).balance).toBe(2000); // nothing moved
  });

  it('simultaneous confirms execute exactly once', async () => {
    const { a, b } = await pair();
    const t = await open(a, b);
    await offer(a, t, 0, [{ itemId: 'sandwich', quantity: 2 }]);
    const v = (await offer(b, t, 50)).body.version;
    const rs = await Promise.all([confirm(a, t, v), confirm(b, t, v)]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect((await view(a, t)).status).toBe('completed');
    expect((await summary(b)).balance).toBe(1950);
    expect((await summary(b)).inventory).toEqual([{ itemId: 'sandwich', quantity: 2 }]);
    expect((await w.ctx.pool.query(`SELECT count(*)::int n FROM ledger_transactions WHERE type='trade'`)).rows[0].n).toBe(1);
  });

  it('promised items cannot be duplicated: the same sandwich offered in two trades only moves once', async () => {
    const a = await w.newPlayer('Double Dealer'), b = await w.newPlayer('Victim Bee'), c = await w.newPlayer('Victim Cee');
    await buy(a, 'sandwich', 1);
    const t1 = await open(a, b), t2 = await open(a, c);
    await offer(a, t1, 0, [{ itemId: 'sandwich', quantity: 1 }]); await offer(a, t2, 0, [{ itemId: 'sandwich', quantity: 1 }]);
    const v1 = (await offer(b, t1, 100)).body.version, v2 = (await offer(c, t2, 100)).body.version;
    await Promise.all([confirm(a, t1, v1), confirm(a, t2, v2)]);
    const rs = await Promise.all([confirm(b, t1, v1), confirm(c, t2, v2)]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.body.error === 'not_enough_items')).toHaveLength(1);
    const owned = [b, c].map(async (p) => (await summary(p)).inventory.find((i: any) => i.itemId === 'sandwich')?.quantity ?? 0);
    expect((await Promise.all(owned)).reduce((x, y) => x + y, 0)).toBe(1);
    // loser's money was not taken
    const balances = await Promise.all([b, c].map(async (p) => (await summary(p)).balance));
    expect(balances.sort()).toEqual([1900, 2000]);
  });

  it('if funds vanish before the swap, nothing moves and the trade stays open', async () => {
    const { a, b } = await pair();
    const t = await open(a, b);
    await offer(a, t, 0, [{ itemId: 'sandwich', quantity: 1 }]);
    const v = (await offer(b, t, 1500)).body.version;
    await buy(b, 'starter_sofa', 2); // Bea spends 700 -> 1300 < 1500 after offering
    await confirm(a, t, v);
    const r = await confirm(b, t, v);
    expect(r.status).toBe(402);
    expect((await view(a, t)).status).toBe('open');
    expect((await summary(a)).inventory).toEqual([{ itemId: 'sandwich', quantity: 4 }]);
    expect((await summary(b)).balance).toBe(1300);
  });

  it('cannot offer more than you have; validates items; outsiders cannot touch a trade', async () => {
    const { a, b } = await pair(); const x = await w.newPlayer('Nosy Parker');
    const t = await open(a, b);
    expect((await offer(a, t, 999999)).body.error).toBe('insufficient_funds');
    expect((await offer(a, t, 0, [{ itemId: 'sandwich', quantity: 5 }])).body.error).toBe('not_enough_items');
    expect((await offer(a, t, 0, [{ itemId: 'nope', quantity: 1 }])).status).toBe(400);
    expect((await offer(a, t, 0, [{ itemId: 'sandwich', quantity: 1 }, { itemId: 'sandwich', quantity: 1 }])).status).toBe(400);
    expect((await offer(x, t, 0)).status).toBe(404);
    expect((await confirm(x, t, 0)).status).toBe(404);
    expect((await view(x, t)).error).toBe('trade_not_found');
    expect((await w.gameReq('POST', `${G}/characters/${x.characterId}/trades/${t}/cancel`)).status).toBe(404);
  });

  it('blocked players cannot trade; self-trade refused; cancel and expiry stop a trade', async () => {
    const { a, b } = await pair();
    expect((await w.gameReq('POST', `${G}/characters/${a.characterId}/trades`, { partnerId: a.characterId })).status).toBe(400);
    await w.gameReq('POST', `${G}/characters/${b.characterId}/blocks`, { targetCharacterId: a.characterId });
    expect((await w.gameReq('POST', `${G}/characters/${a.characterId}/trades`, { partnerId: b.characterId })).status).toBe(403);
    await w.gameReq('DELETE', `${G}/characters/${b.characterId}/blocks/${a.characterId}`);
    const t = await open(a, b);
    const v = (await offer(b, t, 10)).body.version;
    await w.gameReq('POST', `${G}/characters/${a.characterId}/trades/${t}/cancel`);
    expect((await confirm(b, t, v)).body.error).toBe('trade_not_open');
    const t2 = await open(a, b);
    w.clock.t = new Date(w.clock.t.getTime() + 6 * 60_000);
    expect((await offer(a, t2, 0)).body.error).toBe('trade_expired');
    expect((await view(a, t2)).status).toBe('expired');
  });

  it('a block placed mid-trade or a suspension stops execution', async () => {
    const { a, b } = await pair();
    const t = await open(a, b);
    await offer(a, t, 0, [{ itemId: 'sandwich', quantity: 1 }]);
    const v = (await offer(b, t, 10)).body.version;
    await confirm(a, t, v);
    await w.gameReq('POST', `${G}/characters/${b.characterId}/blocks`, { targetCharacterId: a.characterId });
    expect((await confirm(b, t, v)).status).toBe(403);
    expect((await summary(b)).balance).toBe(2000);
  });

  it('limits open trades per character', async () => {
    const a = await w.newPlayer('Busy Trader');
    const others = await Promise.all([1, 2, 3, 4].map(() => w.newPlayer()));
    for (let i = 0; i < 3; i++) expect((await w.gameReq('POST', `${G}/characters/${a.characterId}/trades`, { partnerId: others[i]!.characterId })).status).toBe(200);
    expect((await w.gameReq('POST', `${G}/characters/${a.characterId}/trades`, { partnerId: others[3]!.characterId })).body.error).toBe('too_many_open_trades');
  });
});

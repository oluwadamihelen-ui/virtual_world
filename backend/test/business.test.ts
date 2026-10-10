import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, key, type TestWorld } from './helpers.js';
import { simulateNpcCustomers } from '../src/modules/commerce/business.js';
import { verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';

let w: TestWorld;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });
const G = '/v1/game';
const seeded = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

async function openShop(owner: { characterId: string }, premisesId = 'prem_market_01', type = 'convenience_shop', name = 'Corner Plus') {
  return w.gameReq('POST', `${G}/characters/${owner.characterId}/businesses`, { premisesId, type, name, idempotencyKey: key() });
}
const fund = (o: any, b: string, direction: string, amount: number, k = key()) => w.gameReq('POST', `${G}/characters/${o.characterId}/businesses/${b}/fund`, { direction, amount, idempotencyKey: k });
const restock = (o: any, b: string, itemId: string, quantity: number, k = key()) => w.gameReq('POST', `${G}/characters/${o.characterId}/businesses/${b}/restock`, { itemId, quantity, idempotencyKey: k });
const setPrice = (o: any, b: string, itemId: string, price: number) => w.gameReq('PUT', `${G}/characters/${o.characterId}/businesses/${b}/prices`, { itemId, price });
const report = async (o: any, b: string) => (await w.gameReq('GET', `${G}/characters/${o.characterId}/businesses/${b}/report`)).body;
const summary = async (cid: string) => (await w.gameReq('GET', `${G}/characters/${cid}/summary`)).body;

describe('business lifecycle', () => {
  async function richOwner(name?: string) {
    const o = await w.newPlayer(name);
    const adminP = await w.newPlayer(); const tok = await w.setRole(adminP.accountId, 'admin');
    await w.playerReq(tok, 'POST', '/v1/admin/adjustments', { characterId: o.characterId, delta: 5000, reason: 'test funding for business scenarios', idempotencyKey: key() });
    return o;
  }

  it('insufficient funds blocks opening; nothing is charged', async () => {
    const o = await w.newPlayer();
    const r = await openShop(o);
    expect(r.status).toBe(402);
    expect((await summary(o.characterId)).balance).toBe(2000);
    expect((await w.gameReq('GET', `${G}/world/premises`)).body.premises.every((p: any) => p.available)).toBe(true);
  });

  it('full loop: open, fund, restock, price, NPC sales, player sale, report with revenue/expenses/net profit', async () => {
    const o = await richOwner('Shop Owner');
    const open = await openShop(o);
    expect(open.status).toBe(200);
    const b = open.body.businessId;
    expect((await summary(o.characterId)).balance).toBe(7000 - 3000);
    expect((await summary(o.characterId)).achievements.map((a: any) => a.achievementId)).toContain('first_business');

    expect((await fund(o, b, 'deposit', 1000)).body.cash).toBe(1000);
    const rs = await restock(o, b, 'sandwich', 50); // wholesale 12 x 50 = 600
    expect(rs.body).toMatchObject({ cost: 600, quantity: 50 });
    expect((await restock(o, b, 'coffee', 10)).status).toBe(409); // cafe item in a convenience shop
    expect((await setPrice(o, b, 'sandwich', 1000)).status).toBe(400); // price gouging cap
    expect((await setPrice(o, b, 'sandwich', 20)).status).toBe(200);

    const sim = await simulateNpcCustomers({ ...w.ctx }, 'tick-A', seeded(7));
    expect(sim.sales).toBeGreaterThan(0);
    const buyer = await w.newPlayer();
    const pb = await w.gameReq('POST', `${G}/characters/${buyer.characterId}/business-purchase/${b}`, { itemId: 'sandwich', quantity: 2, idempotencyKey: key() });
    expect(pb.body).toMatchObject({ totalPrice: 40, balance: 1960 });

    const rep = await report(o, b);
    const soldUnits = rep.unitsSold.reduce((a: number, x: any) => a + x.units, 0);
    expect(rep.revenue).toBe(soldUnits * 20);
    expect(rep.expenses).toBe(600);
    expect(rep.netProfit).toBe(rep.revenue - 600);
    expect(rep.cash).toBe(1000 - 600 + rep.revenue);
    expect(rep.ownerDeposits).toBe(1000);
    const stock = (await w.gameReq('GET', `${G}/world/businesses/${b}`)).body.stock.find((s: any) => s.itemId === 'sandwich');
    expect(stock.quantity).toBe(50 - soldUnits);
    expect(await verifyLedgerIntegrity(w.ctx.pool)).toMatchObject({ ok: true, total: 0 });
  });

  it('simultaneous attempts to open the same premises: exactly one wins, others are not charged', async () => {
    const owners = await Promise.all(Array.from({ length: 5 }, () => richOwner()));
    const rs = await Promise.all(owners.map((o, i) => openShop(o, 'prem_market_01', 'convenience_shop', `Race Shop ${i}`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(4);
    for (let i = 0; i < owners.length; i++) expect((await summary(owners[i]!.characterId)).balance).toBe(rs[i]!.status === 200 ? 4000 : 7000);
  });

  it('duplicate open request charges once', async () => {
    const o = await richOwner();
    const k = key();
    const body = { premisesId: 'prem_market_02', type: 'cafe', name: 'Dupe Cafe', idempotencyKey: k };
    const send = () => w.gameReq('POST', `${G}/characters/${o.characterId}/businesses`, body);
    const [a, c] = await Promise.all([send(), send()]);
    expect(a.body.businessId).toBe(c.body.businessId);
    expect((await summary(o.characterId)).balance).toBe(4000);
  });

  it('only the owner can manage; owner cannot buy from themselves; till cannot overdraw', async () => {
    const o = await richOwner(); const other = await richOwner();
    const b = (await openShop(o)).body.businessId;
    await fund(o, b, 'deposit', 500);
    expect((await fund(other, b, 'withdraw', 100)).status).toBe(403);
    expect((await restock(other, b, 'sandwich', 1)).status).toBe(403);
    expect((await setPrice(other, b, 'sandwich', 20)).status).toBe(403);
    expect((await report(other, b)).error).toBe('not_business_owner');
    expect((await restock(o, b, 'sandwich', 200)).status).toBe(402); // 2400 > 500 in till
    expect((await fund(o, b, 'withdraw', 99999)).status).toBe(402);
    await restock(o, b, 'sandwich', 10);
    expect((await w.gameReq('POST', `${G}/characters/${o.characterId}/business-purchase/${b}`, { itemId: 'sandwich', quantity: 1, idempotencyKey: key() })).status).toBe(400);
  });

  it('concurrent buyers of the last units: no overselling, losers not charged', async () => {
    const o = await richOwner();
    const b = (await openShop(o)).body.businessId;
    await fund(o, b, 'deposit', 500); await restock(o, b, 'sandwich', 3);
    const buyers = await Promise.all(Array.from({ length: 8 }, () => w.newPlayer()));
    const rs = await Promise.all(buyers.map((p) => w.gameReq('POST', `${G}/characters/${p.characterId}/business-purchase/${b}`, { itemId: 'sandwich', quantity: 1, idempotencyKey: key() })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(3);
    expect(rs.filter((r) => r.body.error === 'out_of_stock')).toHaveLength(5);
    for (let i = 0; i < buyers.length; i++) expect((await summary(buyers[i]!.characterId)).balance).toBe(rs[i]!.status === 200 ? 1975 : 2000);
    expect(await verifyLedgerIntegrity(w.ctx.pool)).toMatchObject({ ok: true });
  });

  it('competition: cheaper businesses win more NPC customers; overpriced ones win none', async () => {
    const a = await richOwner(), c = await richOwner(), d = await richOwner();
    const mk = async (o: any, prem: string, price: number) => {
      const b = (await openShop(o, prem, 'convenience_shop', 'Shop at ' + prem.slice(-2) + ' ' + price)).body.businessId;
      await fund(o, b, 'deposit', 2000); await restock(o, b, 'bottled_water', 200); await setPrice(o, b, 'bottled_water', price);
      return b;
    };
    const cheap = await mk(a, 'prem_market_01', 6), pricey = await mk(c, 'prem_market_02', 11), absurd = await mk(d, 'prem_market_03', 24); // base 8; NPC refuses > 12.8
    w.ctx.data.businesses.npcDemand.customersPerTick = 400;
    for (let t = 0; t < 3; t++) await simulateNpcCustomers(w.ctx, 'comp-' + t, seeded(99 + t));
    const units = async (b: string, who: any) => (await report(who, b)).unitsSold.reduce((n: number, x: any) => n + x.units, 0);
    const [uc, up, ua] = [await units(cheap, a), await units(pricey, c), await units(absurd, d)];
    expect(uc).toBeGreaterThan(up);
    expect(up).toBeGreaterThan(0);
    expect(ua).toBe(0);
    expect(await verifyLedgerIntegrity(w.ctx.pool)).toMatchObject({ ok: true, total: 0 });
  });

  it('NPC tick is idempotent: replaying the same tick id does not double-sell', async () => {
    const o = await richOwner();
    const b = (await openShop(o)).body.businessId;
    await fund(o, b, 'deposit', 500); await restock(o, b, 'bottled_water', 100);
    await Promise.all([1, 2, 3].map(() => simulateNpcCustomers(w.ctx, 'same-tick', seeded(5))));
    const rep = await report(o, b);
    expect(rep.unitsSold.reduce((n: number, x: any) => n + x.units, 0)).toBeLessThanOrEqual(w.ctx.data.businesses.npcDemand.customersPerTick);
  });

  it('closing returns till cash to the owner and frees the premises', async () => {
    const o = await richOwner();
    const b = (await openShop(o)).body.businessId;
    await fund(o, b, 'deposit', 800);
    const before = (await summary(o.characterId)).balance;
    const c = await w.gameReq('POST', `${G}/characters/${o.characterId}/businesses/${b}/close`, { idempotencyKey: key() });
    expect(c.body.returnedCash).toBe(800);
    expect((await summary(o.characterId)).balance).toBe(before + 800);
    expect((await w.gameReq('GET', `${G}/world/premises`)).body.premises.find((p: any) => p.premisesId === 'prem_market_01').available).toBe(true);
  });

  it('name rules: blocked words and bad characters rejected', async () => {
    const o = await richOwner();
    expect((await openShop(o, 'prem_market_01', 'convenience_shop', 'Idiot Mart')).status).toBe(400);
    expect((await openShop(o, 'prem_market_01', 'convenience_shop', '<b>x</b>')).status).toBe(400);
  });
});

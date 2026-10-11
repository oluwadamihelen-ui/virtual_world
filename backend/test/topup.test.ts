import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createWorld, type TestWorld } from './helpers.js';
import * as topup from '../src/modules/topup/topup.js';
import { verifyLedgerIntegrity, balanceOf } from '../src/modules/economy/ledger.js';
import { handleApp } from '../src/modules/phone/index.js';

let w: TestWorld;
const cfg = () => w.ctx.config as any;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });

/** A fake payment provider API: records calls and answers with whatever the test sets. */
function fakeHttp(answer: (url: string, init: any) => any) {
  const calls: { url: string; init: any }[] = [];
  w.ctx.http = (async (url: any, init: any) => { calls.push({ url: String(url), init }); const body = answer(String(url), init); if (body instanceof Error) throw body; return { ok: true, status: 200, text: async () => JSON.stringify(body) } as any; }) as any;
  return calls;
}
const bal = (id: string) => balanceOf(w.ctx.pool as any, id);
const sha512 = (k: string, d: string) => createHmac('sha512', k).update(d).digest('hex');
const sha256 = (k: string, d: string) => createHmac('sha256', k).update(d).digest('hex');
const hook = (provider: string, headers: Record<string, string>, raw: string) => w.app.inject({ method: 'POST', url: `/v1/webhooks/${provider}`, headers: { 'content-type': 'application/json', ...headers }, payload: raw });

describe('top-ups: packs, rules and the ledger', () => {
  it('lists the packs at the fixed rates and only offers methods that are switched on', async () => {
    const c = topup.catalogue(w.ctx);
    expect(c.packs.map((p) => [p.mvc, p.ngn, p.usd])).toEqual([[500, 1000, 1], [3000, 5000, 4], [7000, 10000, 7], [16000, 20000, 14]]);   // N50,000 / 300,000 / 700,000 / 1,600,000 game money
    expect(c.providers.every((p) => !p.available)).toBe(true); expect(c.manual.available).toBe(false);
    cfg().PAYSTACK_SECRET_KEY = 'sk_test_paystack_key'; cfg().MANUAL_TOPUP_INSTRUCTIONS = 'Test Bank 0123456789';
    const c2 = topup.catalogue(w.ctx);
    expect(c2.providers.find((p) => p.id === 'paystack')!.available).toBe(true); expect(c2.manual.instructions).toContain('0123456789');
  });

  it('is for adults, and refuses methods that are not configured', async () => {
    cfg().PAYSTACK_SECRET_KEY = 'sk_test_paystack_key';
    const teen = await w.newPlayer('Young Buyer', undefined, { birthDate: '2010-03-01' }); const a = await w.newPlayer('Adult Buyer');
    await expect(topup.start(w.ctx, teen.characterId, 'paystack', 'pack_s', 'NGN')).rejects.toMatchObject({ code: 'adults_only' });
    await expect(topup.start(w.ctx, a.characterId, 'korapay', 'pack_s', 'NGN')).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(topup.start(w.ctx, a.characterId, 'paystack', 'nope', 'NGN')).rejects.toMatchObject({ code: 'unknown_pack' });
  });

  it('Paystack: signed webhook credits once; bad signature, replays and short payments do not', async () => {
    cfg().PAYSTACK_SECRET_KEY = 'sk_test_paystack_key';
    const p = await w.newPlayer('Paystack Payer'); const before = await bal(p.characterId);
    const calls = fakeHttp((url) => url.includes('/initialize') ? { status: true, data: { authorization_url: 'https://checkout.paystack.test/abc', access_code: 'ac_1' } }
      : { status: true, data: { status: 'success', amount: 500000, currency: 'NGN', id: 99 } });
    const { order } = await topup.start(w.ctx, p.characterId, 'paystack', 'pack_m', 'NGN');
    expect(order).toMatchObject({ status: 'pending', mvc: 3000, amountMinor: 500000, checkoutUrl: 'https://checkout.paystack.test/abc' });
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ amount: 500000, currency: 'NGN', reference: order.reference });
    expect(calls[0]!.init.headers.authorization).toBe('Bearer sk_test_paystack_key');
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: order.reference, amount: 1, status: 'success' } });   // body lies about the amount: we must not use it
    expect((await hook('paystack', { 'x-paystack-signature': 'deadbeef' }, raw)).statusCode).toBe(401);
    expect(await bal(p.characterId)).toBe(before);
    const sig = sha512('sk_test_paystack_key', raw);
    expect((await hook('paystack', { 'x-paystack-signature': sig }, raw)).statusCode).toBe(200);
    expect(await bal(p.characterId)).toBe(before + 3000);
    expect((await hook('paystack', { 'x-paystack-signature': sig }, raw)).statusCode).toBe(200);   // replay
    expect(await bal(p.characterId)).toBe(before + 3000);
    expect((await topup.listOrders(w.ctx, p.characterId))[0]).toMatchObject({ status: 'paid' });
    expect((await verifyLedgerIntegrity(w.ctx.pool as any)).ok).toBe(true);

    // a payment that is short of the price is never credited
    fakeHttp((url) => url.includes('/initialize') ? { status: true, data: { authorization_url: 'https://x.test/1' } } : { status: true, data: { status: 'success', amount: 100000, currency: 'NGN', id: 5 } });
    const o2 = (await topup.start(w.ctx, p.characterId, 'paystack', 'pack_l', 'NGN')).order;
    const r = await topup.check(w.ctx, p.characterId, o2.id);
    expect(r.credited).toBe(false); expect(r.order.status).toBe('review');
    expect(await bal(p.characterId)).toBe(before + 3000);
  });

  it('check(): credits after a verified payment, and leaves the order alone if the provider cannot be reached', async () => {
    cfg().PAYSTACK_SECRET_KEY = 'sk_test_paystack_key';
    const p = await w.newPlayer('Checker'); const before = await bal(p.characterId);
    fakeHttp(() => ({ status: true, data: { authorization_url: 'https://x.test/2' } }));
    const o = (await topup.start(w.ctx, p.characterId, 'paystack', 'pack_s', 'NGN')).order;
    fakeHttp(() => new Error('network down'));
    expect(await topup.check(w.ctx, p.characterId, o.id)).toMatchObject({ credited: false, unreachable: true });
    fakeHttp(() => ({ status: true, data: { status: 'success', amount: 100000, currency: 'NGN', id: 7 } }));
    expect(await topup.check(w.ctx, p.characterId, o.id)).toMatchObject({ credited: true });
    expect(await topup.check(w.ctx, p.characterId, o.id)).toMatchObject({ credited: false });
    expect(await bal(p.characterId)).toBe(before + 500);
    // abandoned payments are marked failed
    fakeHttp(() => ({ status: true, data: { authorization_url: 'https://x.test/3' } }));
    const o3 = (await topup.start(w.ctx, p.characterId, 'paystack', 'pack_s', 'NGN')).order;
    fakeHttp(() => ({ status: true, data: { status: 'abandoned', amount: 0, currency: 'NGN' } }));
    expect((await topup.check(w.ctx, p.characterId, o3.id)).order.status).toBe('failed');
  });

  it('Flutterwave (verif-hash) and Korapay (HMAC of the data object) webhooks, in dollars too', async () => {
    cfg().FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST-key-12345'; cfg().FLUTTERWAVE_SECRET_HASH = 'my-flw-secret-hash'; cfg().KORAPAY_SECRET_KEY = 'sk_test_kora_key_123';
    const p = await w.newPlayer('Multi Payer'); const before = await bal(p.characterId);
    const fw = fakeHttp((url) => url.includes('/payments') ? { status: 'success', data: { link: 'https://ravepay.test/pay' } } : { status: 'success', data: { status: 'successful', tx_ref: fw.refSeen, amount: 4, currency: 'USD', id: 321 } }) as any;
    const o1 = (await topup.start(w.ctx, p.characterId, 'flutterwave', 'pack_m', 'USD')).order; fw.refSeen = o1.reference;
    expect(JSON.parse(fw[0].init.body)).toMatchObject({ tx_ref: o1.reference, amount: 4, currency: 'USD' });
    const raw1 = JSON.stringify({ event: 'charge.completed', data: { tx_ref: o1.reference, status: 'successful' } });
    expect((await hook('flutterwave', { 'verif-hash': 'wrong' }, raw1)).statusCode).toBe(401);
    expect((await hook('flutterwave', { 'verif-hash': 'my-flw-secret-hash' }, raw1)).statusCode).toBe(200);
    expect(await bal(p.characterId)).toBe(before + 3000);

    const kp = fakeHttp((url) => url.endsWith('/initialize') ? { status: true, data: { checkout_url: 'https://kora.test/c', reference: 'k1' } } : { status: true, data: { status: 'success', amount: 10000, currency: 'NGN', reference: kp.ref } }) as any;
    const o2 = (await topup.start(w.ctx, p.characterId, 'korapay', 'pack_l', 'NGN')).order; kp.ref = o2.reference;
    const data = { reference: o2.reference, status: 'success', amount: 10000 }; const raw2 = JSON.stringify({ event: 'charge.success', data });
    expect((await hook('korapay', { 'x-korapay-signature': sha256('sk_test_kora_key_123', JSON.stringify({ ...data, amount: 1 })) }, raw2)).statusCode).toBe(401);
    expect((await hook('korapay', { 'x-korapay-signature': sha256('sk_test_kora_key_123', JSON.stringify(data)) }, raw2)).statusCode).toBe(200);
    expect(await bal(p.characterId)).toBe(before + 3000 + 7000);
    expect((await verifyLedgerIntegrity(w.ctx.pool as any)).ok).toBe(true);
  });

  it('manual bank transfer: player reports it, an admin approves once; rejection credits nothing; non-admins cannot decide', async () => {
    cfg().MANUAL_TOPUP_INSTRUCTIONS = 'Test Bank 0123456789, My Virtual World';
    const p = await w.newPlayer('Transfer Tola'); const admin = await w.newPlayer('Admin Ade'); const tok = await w.setRole(admin.accountId, 'admin');
    const before = await bal(p.characterId);
    const { order, instructions } = await topup.start(w.ctx, p.characterId, 'manual', 'pack_xl', 'NGN') as any;
    expect(instructions).toContain('0123456789'); expect(order.reference).toMatch(/^MVW-/);
    await topup.submitManual(w.ctx, p.characterId, order.id, 'Tola Transfer', 'paid at 2pm');
    const list = await w.playerReq(tok, 'GET', '/v1/admin/topups?status=review');
    expect(list.body.orders).toHaveLength(1); expect(list.body.orders[0]).toMatchObject({ player: 'Transfer Tola', senderName: 'Tola Transfer', mvc: 16000 });
    expect((await w.playerReq(p.token, 'POST', `/v1/admin/topups/${order.id}/decide`, { approve: true })).status).toBe(403);
    expect(await bal(p.characterId)).toBe(before);
    expect((await w.playerReq(tok, 'POST', `/v1/admin/topups/${order.id}/decide`, { approve: true })).body.credited).toBe(true);
    expect((await w.playerReq(tok, 'POST', `/v1/admin/topups/${order.id}/decide`, { approve: true })).body.credited).toBe(false);
    expect(await bal(p.characterId)).toBe(before + 16000);
    const o2 = (await topup.start(w.ctx, p.characterId, 'manual', 'pack_s', 'NGN')).order;
    await topup.submitManual(w.ctx, p.characterId, o2.id, 'Tola Transfer');
    expect((await w.playerReq(tok, 'POST', `/v1/admin/topups/${o2.id}/decide`, { approve: false, note: 'no matching transfer' })).body.order.status).toBe('rejected');
    expect(await bal(p.characterId)).toBe(before + 16000);
    expect((await verifyLedgerIntegrity(w.ctx.pool as any)).ok).toBe(true);
  });

  it('limits open orders and the daily total; the phone app exposes info/start/check', async () => {
    cfg().MANUAL_TOPUP_INSTRUCTIONS = 'Test Bank 0123456789';
    const p = await w.newPlayer('Heavy Buyer');
    for (let i = 0; i < 5; i++) await topup.start(w.ctx, p.characterId, 'manual', 'pack_s', 'NGN');
    await expect(topup.start(w.ctx, p.characterId, 'manual', 'pack_s', 'NGN')).rejects.toMatchObject({ code: 'too_many_open_orders' });
    const q = await w.newPlayer('Whale');
    for (let i = 0; i < 5; i++) { const o = (await topup.start(w.ctx, q.characterId, 'manual', 'pack_xl', 'NGN')).order; await topup.submitManual(w.ctx, q.characterId, o.id, 'Whale W'); await w.ctx.pool.query(`UPDATE topup_orders SET status='paid' WHERE id=$1`, [o.id]); }
    await expect(topup.start(w.ctx, q.characterId, 'manual', 'pack_s', 'NGN')).rejects.toMatchObject({ code: 'daily_limit' });
    const info: any = (await handleApp(w.ctx, { id: p.characterId, name: 'Heavy Buyer', city: 'lagos' }, 'topup', 'info', {})).data;
    expect(info.packs).toHaveLength(4); expect(info.orders.length).toBe(5);
  });
});

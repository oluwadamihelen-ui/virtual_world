import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppContext } from '../../context.js';

/**
 * Payment providers. Rules that keep real money safe:
 *  - Secrets come from the environment only.
 *  - A webhook is never trusted for the amount or status: it only tells us WHICH order to look at. We then ask the provider's API
 *    (with our secret key) whether it was paid, for how much and in which currency, and compare with what we expected.
 *  - These adapters follow each provider's public API as documented, but they have NOT been run against live or sandbox accounts
 *    from this project yet. Test with each provider's test keys before accepting real money (see docs/PAYMENTS.md).
 */
export type ProviderId = 'paystack' | 'flutterwave' | 'korapay';
export interface OrderLike { reference: string; currency: 'NGN' | 'USD'; amountMinor: number; packName: string }
export interface Payer { email: string; name: string }
export interface Verified { paid: boolean; failed: boolean; amountMinor: number; currency: string; providerRef: string | null }

export interface Provider {
  id: ProviderId;
  configured(ctx: AppContext): boolean;
  init(ctx: AppContext, o: OrderLike, who: Payer, returnUrl: string): Promise<{ url: string; providerRef: string | null }>;
  verify(ctx: AppContext, o: OrderLike): Promise<Verified>;
  /** Does this webhook request carry a valid signature? `raw` is the exact request body. */
  signatureOk(ctx: AppContext, headers: Record<string, unknown>, raw: string): boolean;
  /** Which of our references does this webhook talk about (and is it a charge event we care about)? */
  referenceOf(raw: string): string | null;
}

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const hmac = (algo: 'sha256' | 'sha512', key: string, data: string) => createHmac(algo, key).update(data).digest('hex');
const header = (h: Record<string, unknown>, name: string) => { const v = h[name]; return typeof v === 'string' ? v : ''; };
const major = (minor: number) => Math.round(minor) / 100;

async function call(ctx: AppContext, method: 'GET' | 'POST', url: string, key: string, body?: unknown): Promise<any> {
  const f = ctx.http ?? fetch;
  const res = await f(url, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) throw new Error(`provider_http_${res.status}`);
  return json;
}

export const paystack: Provider = {
  id: 'paystack',
  configured: (ctx) => !!ctx.config.PAYSTACK_SECRET_KEY,
  async init(ctx, o, who, returnUrl) {
    const j = await call(ctx, 'POST', 'https://api.paystack.co/transaction/initialize', ctx.config.PAYSTACK_SECRET_KEY!, {
      email: who.email, amount: o.amountMinor, currency: o.currency, reference: o.reference, callback_url: returnUrl, metadata: { pack: o.packName },
    });
    if (!j?.status || !j.data?.authorization_url) throw new Error('provider_bad_response');
    return { url: j.data.authorization_url, providerRef: j.data.access_code ?? null };
  },
  async verify(ctx, o) {
    const j = await call(ctx, 'GET', `https://api.paystack.co/transaction/verify/${encodeURIComponent(o.reference)}`, ctx.config.PAYSTACK_SECRET_KEY!);
    const d = j?.data ?? {};
    return { paid: !!j?.status && d.status === 'success', failed: ['failed', 'abandoned', 'reversed'].includes(d.status), amountMinor: Number(d.amount ?? 0), currency: String(d.currency ?? ''), providerRef: d.id != null ? String(d.id) : null };
  },
  // Paystack signs the raw body with HMAC-SHA512 using the secret key: header x-paystack-signature.
  signatureOk: (ctx, h, raw) => !!ctx.config.PAYSTACK_SECRET_KEY && safeEq(header(h, 'x-paystack-signature'), hmac('sha512', ctx.config.PAYSTACK_SECRET_KEY, raw)),
  referenceOf(raw) { try { const j = JSON.parse(raw); return j?.event === 'charge.success' && typeof j.data?.reference === 'string' ? j.data.reference : null; } catch { return null; } },
};

export const flutterwave: Provider = {
  id: 'flutterwave',
  configured: (ctx) => !!ctx.config.FLUTTERWAVE_SECRET_KEY,
  async init(ctx, o, who, returnUrl) {
    const j = await call(ctx, 'POST', 'https://api.flutterwave.com/v3/payments', ctx.config.FLUTTERWAVE_SECRET_KEY!, {
      tx_ref: o.reference, amount: major(o.amountMinor), currency: o.currency, redirect_url: returnUrl,
      customer: { email: who.email, name: who.name }, customizations: { title: 'My Virtual World', description: o.packName },
    });
    if (j?.status !== 'success' || !j.data?.link) throw new Error('provider_bad_response');
    return { url: j.data.link, providerRef: null };
  },
  async verify(ctx, o) {
    const j = await call(ctx, 'GET', `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(o.reference)}`, ctx.config.FLUTTERWAVE_SECRET_KEY!);
    const d = j?.data ?? {};
    return { paid: j?.status === 'success' && d.status === 'successful' && d.tx_ref === o.reference, failed: d.status === 'failed', amountMinor: Math.round(Number(d.amount ?? 0) * 100), currency: String(d.currency ?? ''), providerRef: d.id != null ? String(d.id) : null };
  },
  // Flutterwave sends the "secret hash" you configured in its dashboard, unchanged, in the verif-hash header.
  signatureOk: (ctx, h, _raw) => !!ctx.config.FLUTTERWAVE_SECRET_HASH && safeEq(header(h, 'verif-hash'), ctx.config.FLUTTERWAVE_SECRET_HASH),
  referenceOf(raw) { try { const j = JSON.parse(raw); const d = j?.data ?? {}; const t = d.tx_ref ?? j?.txRef; return (j?.event === 'charge.completed' || j?.event === undefined) && typeof t === 'string' ? t : null; } catch { return null; } },
};

export const korapay: Provider = {
  id: 'korapay',
  configured: (ctx) => !!ctx.config.KORAPAY_SECRET_KEY,
  async init(ctx, o, who, returnUrl) {
    const j = await call(ctx, 'POST', 'https://api.korapay.com/merchant/api/v1/charges/initialize', ctx.config.KORAPAY_SECRET_KEY!, {
      reference: o.reference, amount: major(o.amountMinor), currency: o.currency, redirect_url: returnUrl,
      customer: { name: who.name, email: who.email }, merchant_bears_cost: false, narration: o.packName,
    });
    if (!j?.status || !j.data?.checkout_url) throw new Error('provider_bad_response');
    return { url: j.data.checkout_url, providerRef: j.data.reference ?? null };
  },
  async verify(ctx, o) {
    const j = await call(ctx, 'GET', `https://api.korapay.com/merchant/api/v1/charges/${encodeURIComponent(o.reference)}`, ctx.config.KORAPAY_SECRET_KEY!);
    const d = j?.data ?? {};
    return { paid: !!j?.status && d.status === 'success', failed: d.status === 'failed', amountMinor: Math.round(Number(d.amount ?? 0) * 100), currency: String(d.currency ?? ''), providerRef: d.reference ?? null };
  },
  // Korapay signs only the "data" object (HMAC-SHA256, secret key) in the x-korapay-signature header.
  signatureOk(ctx, h, raw) {
    if (!ctx.config.KORAPAY_SECRET_KEY) return false;
    try { return safeEq(header(h, 'x-korapay-signature'), hmac('sha256', ctx.config.KORAPAY_SECRET_KEY, JSON.stringify(JSON.parse(raw).data))); } catch { return false; }
  },
  referenceOf(raw) { try { const j = JSON.parse(raw); return j?.event === 'charge.success' && typeof j.data?.reference === 'string' ? j.data.reference : null; } catch { return null; } },
};

export const PROVIDERS: Record<ProviderId, Provider> = { paystack, flutterwave, korapay };

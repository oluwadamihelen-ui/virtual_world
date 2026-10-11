import { randomBytes } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { withTx } from '../../db.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { assertCanAct, characterAgeBand } from '../identity/service.js';
import { audit } from '../moderation/moderation.js';
import { playerAccount, systemAccount, transfer, balanceOf } from '../economy/ledger.js';
import { PROVIDERS, type ProviderId, type Verified } from './providers.js';

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newReference = () => 'MVW-' + Array.from(randomBytes(10), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
const minor = (major: number) => Math.round(major * 100);

export type OrderRow = {
  id: string; provider: string; packId: string; mvc: number; currency: 'NGN' | 'USD'; amountMinor: number; status: string; reference: string;
  checkoutUrl: string | null; createdAt: string; paidAt: string | null; note: string | null;
};
const toOrder = (r: any): OrderRow => ({
  id: r.id, provider: r.provider, packId: r.pack_id, mvc: Number(r.mvc), currency: r.currency, amountMinor: Number(r.amount_minor), status: r.status, reference: r.reference,
  checkoutUrl: r.checkout_url, createdAt: (r.created_at as Date).toISOString(), paidAt: r.paid_at ? (r.paid_at as Date).toISOString() : null, note: r.note,
});

/** What the Top up app shows: packs at the fixed rates, and which payment methods are switched on. */
export function catalogue(ctx: AppContext) {
  const t = ctx.data.topup;
  return {
    packs: t.packs,
    providers: t.providers.map((p) => ({ ...p, available: PROVIDERS[p.id].configured(ctx) })),
    manual: { ...t.manual, available: !!ctx.config.MANUAL_TOPUP_INSTRUCTIONS, instructions: ctx.config.MANUAL_TOPUP_INSTRUCTIONS ?? null },
    minAge: t.limits.minAge, expiresMinutes: t.orderExpiresMinutes,
  };
}

async function assertMayBuy(ctx: AppContext, characterId: string) {
  if ((await characterAgeBand(ctx, characterId)) !== 'adult') throw new AppError(403, 'adults_only', `Buying game money with real money is for players aged ${ctx.data.topup.limits.minAge} and over.`);
  await assertCanAct(ctx, ctx.pool, characterId);
}

export async function listOrders(ctx: AppContext, characterId: string, limit = 20): Promise<OrderRow[]> {
  const r = await ctx.pool.query('SELECT * FROM topup_orders WHERE character_id=$1 ORDER BY created_at DESC LIMIT $2', [characterId, limit]);
  return r.rows.map(toOrder);
}

export async function start(ctx: AppContext, characterId: string, provider: ProviderId | 'manual', packId: string, currency: 'NGN' | 'USD') {
  await assertMayBuy(ctx, characterId);
  const t = ctx.data.topup, pack = t.packs.find((p) => p.id === packId);
  if (!pack) throw badRequest('unknown_pack');
  const info = provider === 'manual' ? t.manual : t.providers.find((p) => p.id === provider);
  if (!info || !info.currencies.includes(currency)) throw badRequest('currency_not_supported', `${provider} cannot take ${currency}.`);
  if (provider === 'manual' ? !ctx.config.MANUAL_TOPUP_INSTRUCTIONS : !PROVIDERS[provider].configured(ctx)) throw conflict('provider_unavailable', 'That payment method is not switched on yet.');

  // old unpaid orders expire; then enforce the open-order and daily limits
  await ctx.pool.query(`UPDATE topup_orders SET status='cancelled' WHERE character_id=$1 AND status='pending' AND provider<>'manual' AND created_at < $2`, [characterId, new Date(ctx.now().getTime() - t.orderExpiresMinutes * 60_000)]);
  const open = (await ctx.pool.query(`SELECT count(*)::int n FROM topup_orders WHERE character_id=$1 AND status IN ('pending','review')`, [characterId])).rows[0].n;
  if (open >= t.limits.maxOpenOrders) throw conflict('too_many_open_orders', 'You have several unfinished top-ups. Finish or wait for them first.');
  const day = (await ctx.pool.query(
    `SELECT COALESCE(SUM(CASE currency WHEN 'NGN' THEN amount_minor ELSE amount_minor * $3 END),0)::bigint s FROM topup_orders
      WHERE character_id=$1 AND status IN ('paid','review') AND created_at > $2`, [characterId, new Date(ctx.now().getTime() - 86_400_000), t.limits.usdToNgnForLimits])).rows[0].s;
  const thisNgn = currency === 'NGN' ? minor(pack.ngn) : minor(pack.usd) * t.limits.usdToNgnForLimits;
  if (Number(day) + thisNgn > minor(t.limits.maxNgnPerDay)) throw conflict('daily_limit', 'That is over the daily top-up limit. Try again tomorrow.');

  const amountMinor = minor(currency === 'NGN' ? pack.ngn : pack.usd), reference = newReference();
  const who = (await ctx.pool.query(`SELECT a.id account_id, a.email, c.display_name FROM characters c JOIN accounts a ON a.id=c.account_id WHERE c.id=$1`, [characterId])).rows[0];
  const row = (await ctx.pool.query(
    `INSERT INTO topup_orders (character_id, account_id, provider, pack_id, mvc, currency, amount_minor, reference) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [characterId, who.account_id, provider, pack.id, pack.mvc, currency, amountMinor, reference])).rows[0];
  if (provider === 'manual') return { order: toOrder(row), instructions: ctx.config.MANUAL_TOPUP_INSTRUCTIONS };

  const base = (ctx.config.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  try {
    const init = await PROVIDERS[provider].init(ctx, { reference, currency, amountMinor, packName: pack.name }, { email: who.email, name: who.display_name }, `${base}/topup/return?ref=${reference}`);
    const up = (await ctx.pool.query('UPDATE topup_orders SET checkout_url=$2, provider_ref=$3 WHERE id=$1 RETURNING *', [row.id, init.url, init.providerRef])).rows[0];
    return { order: toOrder(up) };
  } catch {
    await ctx.pool.query(`UPDATE topup_orders SET status='failed', note='could not start checkout' WHERE id=$1`, [row.id]);
    throw new AppError(502, 'provider_error', 'The payment provider did not respond. Nothing was charged. Please try again in a moment.');
  }
}

/** Player says "I have paid" on a manual bank-transfer order: it now waits for an admin. */
export async function submitManual(ctx: AppContext, characterId: string, orderId: string, senderName: string, note?: string) {
  const r = await ctx.pool.query(
    `UPDATE topup_orders SET status='review', sender_name=$3, note=$4 WHERE id=$1 AND character_id=$2 AND provider='manual' AND status IN ('pending','review') RETURNING *`,
    [orderId, characterId, senderName.trim().slice(0, 80), (note ?? '').slice(0, 200)]);
  if (r.rowCount === 0) throw notFound('order_not_found');
  return { order: toOrder(r.rows[0]) };
}

/**
 * Credit an order, exactly once. Used by webhooks, by the player's own "check payment" and by admin approval.
 * The provider's own answer (amount and currency) must cover what we asked for; a short payment is never credited.
 */
export async function settle(ctx: AppContext, orderId: string, v: Verified, decidedBy: string | null = null) {
  return withTx(ctx.pool, async (tx) => {
    const o = (await tx.query('SELECT * FROM topup_orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw notFound('order_not_found');
    if (o.status === 'paid' || o.status === 'rejected') return { order: toOrder(o), credited: false };
    if (!v.paid) {
      if (v.failed && o.status === 'pending') { const u = (await tx.query(`UPDATE topup_orders SET status='failed' WHERE id=$1 RETURNING *`, [orderId])).rows[0]; return { order: toOrder(u), credited: false }; }
      return { order: toOrder(o), credited: false };
    }
    if (v.currency.toUpperCase() !== o.currency || v.amountMinor < Number(o.amount_minor)) {
      await audit(tx, decidedBy, 'topup.amount_mismatch', 'topup', orderId, { expected: [o.currency, Number(o.amount_minor)], got: [v.currency, v.amountMinor] });
      const u = (await tx.query(`UPDATE topup_orders SET status='review', note='amount or currency did not match; needs an admin' WHERE id=$1 RETURNING *`, [orderId])).rows[0];
      return { order: toOrder(u), credited: false };
    }
    await transfer(tx, {
      key: `topup:${orderId}`, type: 'topup', actorCharacterId: o.character_id, referenceType: 'topup', referenceId: orderId,
      from: systemAccount('faucet:topup'), to: playerAccount(o.character_id), amount: Number(o.mvc), payload: { orderId, mvc: Number(o.mvc) },
    }, (txId) => ({ txId }));
    const u = (await tx.query(`UPDATE topup_orders SET status='paid', paid_at=now(), provider_ref=COALESCE($2, provider_ref), decided_by=$3 WHERE id=$1 RETURNING *`, [orderId, v.providerRef, decidedBy])).rows[0];
    await audit(tx, decidedBy, 'topup.paid', 'character', o.character_id, { orderId, provider: o.provider, reference: o.reference, mvc: Number(o.mvc), currency: o.currency, amountMinor: Number(o.amount_minor) });
    return { order: toOrder(u), credited: true, balance: await balanceOf(tx, o.character_id) };
  });
}

/** Ask the provider about one of the player's own orders (used when they come back from checkout). */
export async function check(ctx: AppContext, characterId: string, orderId: string) {
  const o = (await ctx.pool.query('SELECT * FROM topup_orders WHERE id=$1 AND character_id=$2', [orderId, characterId])).rows[0];
  if (!o) throw notFound('order_not_found');
  if (o.provider === 'manual' || o.status === 'paid' || o.status === 'rejected') return { order: toOrder(o), credited: false };
  try {
    const v = await PROVIDERS[o.provider as ProviderId].verify(ctx, { reference: o.reference, currency: o.currency, amountMinor: Number(o.amount_minor), packName: o.pack_id });
    return await settle(ctx, o.id, v);
  } catch (e) {
    if (e instanceof AppError) throw e;
    return { order: toOrder(o), credited: false, unreachable: true };      // provider unreachable: the order stays as it was
  }
}

/** Provider webhook. Returns the HTTP status to answer with. Never trusts the body beyond "look at this reference". */
export async function handleWebhook(ctx: AppContext, providerId: string, headers: Record<string, unknown>, raw: string): Promise<{ status: number; characterId?: string; credited?: boolean }> {
  const p = (PROVIDERS as any)[providerId] as (typeof PROVIDERS)[ProviderId] | undefined;
  if (!p || !p.configured(ctx)) return { status: 404 };
  if (!p.signatureOk(ctx, headers, raw)) return { status: 401 };
  const ref = p.referenceOf(raw); if (!ref) return { status: 200 };
  const o = (await ctx.pool.query('SELECT * FROM topup_orders WHERE reference=$1 AND provider=$2', [ref, providerId])).rows[0];
  if (!o) return { status: 200 };
  try {
    const v = await p.verify(ctx, { reference: o.reference, currency: o.currency, amountMinor: Number(o.amount_minor), packName: o.pack_id });
    const r = await settle(ctx, o.id, v);
    return { status: 200, characterId: o.character_id, credited: r.credited };
  } catch { return { status: 503 }; }       // ask the provider to retry later
}

// ---------------------------------------------------------------- admin (manual transfers)
export async function adminList(ctx: AppContext, status: string) {
  const r = await ctx.pool.query(
    `SELECT o.*, c.display_name, a.email FROM topup_orders o JOIN characters c ON c.id=o.character_id JOIN accounts a ON a.id=o.account_id WHERE o.status=$1 ORDER BY o.created_at LIMIT 200`, [status]);
  return r.rows.map((x) => ({ ...toOrder(x), player: x.display_name as string, email: x.email as string, senderName: x.sender_name as string | null }));
}

export async function adminDecide(ctx: AppContext, adminAccountId: string, orderId: string, approve: boolean, note: string) {
  const o = (await ctx.pool.query('SELECT * FROM topup_orders WHERE id=$1', [orderId])).rows[0];
  if (!o) throw notFound('order_not_found');
  if (o.provider !== 'manual' && approve) throw forbidden('not_manual');   // provider orders are credited only from the provider's own confirmation
  if (approve) return settle(ctx, orderId, { paid: true, failed: false, amountMinor: Number(o.amount_minor), currency: o.currency, providerRef: null }, adminAccountId);
  return withTx(ctx.pool, async (tx) => {
    const u = (await tx.query(`UPDATE topup_orders SET status='rejected', note=$2, decided_by=$3 WHERE id=$1 AND status IN ('pending','review') RETURNING *`, [orderId, note.slice(0, 200), adminAccountId])).rows[0];
    if (!u) throw conflict('not_open', 'That order is already settled.');
    await audit(tx, adminAccountId, 'topup.rejected', 'character', o.character_id, { orderId, note });
    return { order: toOrder(u), credited: false };
  });
}

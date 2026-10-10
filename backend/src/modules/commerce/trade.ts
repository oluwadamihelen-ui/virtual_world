import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { isBlockedEitherWay } from '../social/social.js';
import { addItem, removeItem } from '../inventory/inventory.js';
import { claim, post, finish, assertAmount, playerAccount } from '../economy/ledger.js';

/**
 * Safe player-to-player trading.
 *  - Each side sets an offer (MVC + items). Any change to ANY offer bumps `version` and thereby voids both confirmations,
 *    so nobody can swap an item after the other side confirmed (the classic bait-and-switch).
 *  - Confirm must name the version the player actually saw.
 *  - When both confirmations match the current version the swap runs in ONE database transaction:
 *    holdings are re-checked at that moment, so offers are promises, never escrow that can get stale.
 *  - Duplicate execution is impossible (ledger idempotency key = trade id; status transition under row lock).
 * The game server is responsible for proximity / "both players are at the trade window" checks.
 */
const TRADE_TTL_MS = 5 * 60_000;
const MAX_OPEN_PER_CHARACTER = 3;
const MAX_DISTINCT_ITEMS = 8;
const MAX_QTY = 99;

export interface OfferInput { mvc: number; items: { itemId: string; quantity: number }[] }

const sideOf = (t: { initiator_id: string; partner_id: string }, id: string): 'initiator' | 'partner' => {
  if (t.initiator_id === id) return 'initiator';
  if (t.partner_id === id) return 'partner';
  throw notFound('trade_not_found'); // do not reveal other people's trades
};

async function loadTrade(tx: Tx, tradeId: string, characterId: string, lock = true) {
  const t = (await tx.query(`SELECT * FROM trades WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [tradeId])).rows[0];
  if (!t) throw notFound('trade_not_found');
  return { t, side: sideOf(t, characterId) };
}

export async function openTrade(ctx: AppContext, characterId: string, partnerId: string) {
  if (characterId === partnerId) throw badRequest('cannot_trade_with_self');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await assertCanAct(ctx, tx, partnerId).catch((e) => { if (e.code === 'character_not_found') throw notFound('partner_not_found'); throw conflict('partner_unavailable'); });
    if (await isBlockedEitherWay(ctx, characterId, partnerId)) throw forbidden('trade_blocked');
    await tx.query('SELECT 1 FROM characters WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[characterId, partnerId]]);
    const now = ctx.now();
    await tx.query(`UPDATE trades SET status='expired' WHERE status='open' AND expires_at <= $1 AND (initiator_id=$2 OR partner_id=$2)`, [now, characterId]);
    const open = (await tx.query(`SELECT count(*)::int n FROM trades WHERE status='open' AND (initiator_id=$1 OR partner_id=$1)`, [characterId])).rows[0].n;
    if (open >= MAX_OPEN_PER_CHARACTER) throw conflict('too_many_open_trades');
    const t = (await tx.query(
      `INSERT INTO trades (initiator_id,partner_id,created_at,expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [characterId, partnerId, now, new Date(now.getTime() + TRADE_TTL_MS)])).rows[0];
    await tx.query(`INSERT INTO trade_offers (trade_id,character_id) VALUES ($1,$2),($1,$3)`, [t.id, characterId, partnerId]);
    return { tradeId: t.id as string, expiresAt: new Date(now.getTime() + TRADE_TTL_MS).toISOString() };
  });
}

export async function setOffer(ctx: AppContext, characterId: string, tradeId: string, offer: OfferInput) {
  assertAmount(offer.mvc, 'mvc');
  if (offer.items.length > MAX_DISTINCT_ITEMS) throw badRequest('too_many_items');
  const seen = new Set<string>();
  for (const it of offer.items) {
    if (!ctx.data.itemIds.has(it.itemId)) throw badRequest('unknown_item');
    if (seen.has(it.itemId)) throw badRequest('duplicate_item_line');
    seen.add(it.itemId);
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > MAX_QTY) throw badRequest('invalid_quantity');
  }
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const { t } = await loadTrade(tx, tradeId, characterId);
    if (t.status !== 'open') throw conflict('trade_not_open');
    if (t.expires_at <= ctx.now()) throw conflict('trade_expired');
    // Offers must be backed by what the player holds *right now* (re-checked again at execution).
    const bal = (await tx.query(`SELECT balance FROM ledger_accounts WHERE kind='player' AND owner_ref=$1`, [characterId])).rows[0]?.balance ?? 0;
    if (offer.mvc > bal) throw conflict('insufficient_funds', 'You cannot offer more MVC than you have');
    for (const it of offer.items) {
      const have = (await tx.query('SELECT quantity FROM inventory_items WHERE character_id=$1 AND item_id=$2', [characterId, it.itemId])).rows[0]?.quantity ?? 0;
      if (have < it.quantity) throw conflict('not_enough_items', `You do not have ${it.quantity} of ${it.itemId}`);
    }
    await tx.query('UPDATE trade_offers SET mvc=$3, items=$4 WHERE trade_id=$1 AND character_id=$2', [tradeId, characterId, offer.mvc, JSON.stringify(offer.items)]);
    // Any change voids all confirmations.
    await tx.query('UPDATE trades SET version=version+1, initiator_confirmed_version=NULL, partner_confirmed_version=NULL WHERE id=$1', [tradeId]);
    return { tradeId, version: t.version + 1 };
  });
}

export async function cancelTrade(ctx: AppContext, characterId: string, tradeId: string) {
  return withTx(ctx.pool, async (tx) => {
    const { t } = await loadTrade(tx, tradeId, characterId);
    if (t.status !== 'open') throw conflict('trade_not_open');
    await tx.query(`UPDATE trades SET status='cancelled' WHERE id=$1`, [tradeId]);
    return { tradeId, status: 'cancelled' };
  });
}

export async function viewTrade(ctx: AppContext, characterId: string, tradeId: string) {
  const { t } = await loadTrade(ctx.pool as any, tradeId, characterId, false);
  const offers = (await ctx.pool.query('SELECT character_id, mvc, items FROM trade_offers WHERE trade_id=$1', [tradeId])).rows;
  const mine = offers.find((o) => o.character_id === characterId), theirs = offers.find((o) => o.character_id !== characterId);
  const side = sideOf(t, characterId);
  const myConf = side === 'initiator' ? t.initiator_confirmed_version : t.partner_confirmed_version;
  const theirConf = side === 'initiator' ? t.partner_confirmed_version : t.initiator_confirmed_version;
  const status = t.status === 'open' && t.expires_at <= ctx.now() ? 'expired' : t.status;
  return {
    tradeId, status, version: t.version as number, expiresAt: (t.expires_at as Date).toISOString(),
    mine: { mvc: mine.mvc as number, items: mine.items }, theirs: { characterId: theirs.character_id as string, mvc: theirs.mvc as number, items: theirs.items },
    iConfirmed: myConf === t.version, theyConfirmed: theirConf === t.version,
  };
}

export async function confirmTrade(ctx: AppContext, characterId: string, tradeId: string, version: number) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const { t, side } = await loadTrade(tx, tradeId, characterId);
    if (t.status === 'completed') return { tradeId, status: 'completed', txId: t.tx_id as string, replayed: true };
    if (t.status !== 'open') throw conflict('trade_not_open');
    if (t.expires_at <= ctx.now()) throw conflict('trade_expired');
    if (version !== t.version) throw conflict('offer_changed', 'The offer changed. Review it again before confirming.');
    const col = side === 'initiator' ? 'initiator_confirmed_version' : 'partner_confirmed_version';
    await tx.query(`UPDATE trades SET ${col}=$2 WHERE id=$1`, [tradeId, version]);
    const fresh = (await tx.query('SELECT * FROM trades WHERE id=$1', [tradeId])).rows[0];
    if (fresh.initiator_confirmed_version !== version || fresh.partner_confirmed_version !== version) {
      return { tradeId, status: 'open', waitingForPartner: true };
    }
    return execute(ctx, tx, fresh);
  });
}

async function execute(ctx: AppContext, tx: Tx, t: any) {
  // Block/sanction state may have changed since the trade was opened.
  await assertCanAct(ctx, tx, t.initiator_id); await assertCanAct(ctx, tx, t.partner_id);
  if (await isBlockedEitherWay(ctx, t.initiator_id, t.partner_id)) throw forbidden('trade_blocked');
  await tx.query('SELECT 1 FROM characters WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[t.initiator_id, t.partner_id]]);
  const offers = (await tx.query('SELECT character_id, mvc, items FROM trade_offers WHERE trade_id=$1', [t.id])).rows;
  const a = offers.find((o) => o.character_id === t.initiator_id), b = offers.find((o) => o.character_id === t.partner_id);

  const c = await claim<{ txId: string }>(tx, {
    key: `trade:${t.id}`, type: 'trade', actorCharacterId: t.initiator_id, referenceType: 'trade', referenceId: t.id,
    amount: a.mvc + b.mvc, payload: { tradeId: t.id },
  });
  if (c.replay) return { tradeId: t.id, status: 'completed', txId: c.response.txId, replayed: true };

  // Items first (throws not_enough_items -> whole swap rolls back), then money (throws insufficient_funds).
  for (const it of a.items as { itemId: string; quantity: number }[]) { await removeItem(tx, a.character_id, it.itemId, it.quantity); await addItem(tx, b.character_id, it.itemId, it.quantity); }
  for (const it of b.items as { itemId: string; quantity: number }[]) { await removeItem(tx, b.character_id, it.itemId, it.quantity); await addItem(tx, a.character_id, it.itemId, it.quantity); }
  await post(tx, c.txId, [
    { account: playerAccount(a.character_id), delta: b.mvc - a.mvc },
    { account: playerAccount(b.character_id), delta: a.mvc - b.mvc },
  ]);
  await tx.query(`UPDATE trades SET status='completed', completed_at=$2, tx_id=$3 WHERE id=$1`, [t.id, ctx.now(), c.txId]);
  await finish(tx, c.txId, { txId: c.txId });
  return { tradeId: t.id as string, status: 'completed', txId: c.txId, replayed: false };
}

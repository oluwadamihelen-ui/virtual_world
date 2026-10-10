import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { maskBlockedWords, awardAchievement } from '../social/social.js';
import { addItem } from '../inventory/inventory.js';
import {
  claim, post, finish, transfer, balanceOf, assertAmount,
  playerAccount, systemAccount, businessAccount,
} from '../economy/ledger.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '&-]{1,28}[A-Za-z0-9]$/;

function item(ctx: AppContext, itemId: string) {
  const it = ctx.data.items.find((i) => i.id === itemId);
  if (!it || !it.wholesalePrice || !it.basePrice) throw badRequest('item_not_tradable');
  return it as typeof it & { wholesalePrice: number; basePrice: number };
}

async function ownedBusiness(tx: Tx, characterId: string, businessId: string, forUpdate = false) {
  const b = (await tx.query(`SELECT * FROM businesses WHERE id=$1 ${forUpdate ? 'FOR UPDATE' : ''}`, [businessId])).rows[0];
  if (!b) throw notFound('business_not_found');
  if (b.owner_character_id !== characterId) throw forbidden('not_business_owner');
  if (b.status !== 'open') throw conflict('business_closed');
  return b;
}

export async function listPremises(ctx: AppContext) {
  const r = await ctx.pool.query(
    `SELECT p.*, EXISTS (SELECT 1 FROM businesses b WHERE b.premises_id=p.id AND b.status='open') AS taken FROM premises p ORDER BY p.id`);
  return r.rows.map((p) => ({ premisesId: p.id, district: p.district, name: p.name, setupCost: p.setup_cost as number, available: !p.taken }));
}

/** Open a business. Exclusive premises: row lock + partial unique index. Setup fee is a ledger sink. */
export async function openBusiness(ctx: AppContext, characterId: string, i: { premisesId: string; type: string; name: string; idempotencyKey: string }) {
  const cfg = ctx.data.businesses;
  if (!cfg.types[i.type]) throw badRequest('invalid_business_type');
  const name = i.name.trim().replace(/\s+/g, ' ');
  if (!NAME_RE.test(name)) throw badRequest('invalid_business_name', 'Use 3-30 letters, numbers, spaces, & or -');
  if (maskBlockedWords(name, ctx.data.chat.blockedWords).filtered) throw badRequest('invalid_business_name', 'That name is not allowed');

  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const prem = (await tx.query('SELECT * FROM premises WHERE id=$1 FOR UPDATE', [i.premisesId])).rows[0];
    if (!prem) throw notFound('premises_not_found');

    const c = await claim<OpenResult>(tx, {
      key: `${characterId}:open-business:${i.idempotencyKey}`, type: 'business_setup', actorCharacterId: characterId,
      referenceType: 'premises', referenceId: i.premisesId, amount: prem.setup_cost, payload: { premisesId: i.premisesId, type: i.type, name },
    });
    if (c.replay) return { ...c.response, replayed: true };

    const taken = (await tx.query(`SELECT 1 FROM businesses WHERE premises_id=$1 AND status='open'`, [i.premisesId])).rowCount;
    if (taken) throw conflict('premises_unavailable', 'Those premises are already in use');
    const open = (await tx.query(`SELECT count(*)::int n FROM businesses WHERE owner_character_id=$1 AND status='open'`, [characterId])).rows[0].n;
    if (open >= cfg.maxOpenPerOwner) throw conflict('business_limit', 'You already own the maximum number of businesses');

    await post(tx, c.txId, [{ account: playerAccount(characterId), delta: -prem.setup_cost }, { account: systemAccount('sink:city_fees'), delta: prem.setup_cost }]);
    const b = (await tx.query(
      `INSERT INTO businesses (owner_character_id,premises_id,type,name,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [characterId, i.premisesId, i.type, name, ctx.now()])).rows[0];
    await awardAchievement(ctx, tx, characterId, 'first_business');
    const response: OpenResult = { txId: c.txId, businessId: b.id, name, setupCost: prem.setup_cost, replayed: false };
    await finish(tx, c.txId, response);
    return response;
  });
}
export interface OpenResult { txId: string; businessId: string; name: string; setupCost: number; replayed: boolean }

/** Move MVC between the owner's wallet and the business till. Neither is revenue/expense. */
export async function fundBusiness(ctx: AppContext, characterId: string, businessId: string, direction: 'deposit' | 'withdraw', amount: number, idempotencyKey: string) {
  assertAmount(amount);
  if (amount < 1) throw badRequest('invalid_amount');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    await ownedBusiness(tx, characterId, businessId, true);
    const biz = businessAccount(businessId), me = playerAccount(characterId);
    const out = await transfer(tx, {
      key: `${characterId}:biz-${direction}:${idempotencyKey}`, type: `business_${direction}`, actorCharacterId: characterId,
      referenceType: 'business', referenceId: businessId, from: direction === 'deposit' ? me : biz, to: direction === 'deposit' ? biz : me,
      amount, payload: { businessId, direction, amount },
    }, (txId) => ({ txId }));
    return { txId: out.response.txId, replayed: out.replay, cash: await tillBalance(tx, businessId), walletBalance: await balanceOf(tx, characterId) };
  });
}

const tillBalance = async (tx: Pick<Tx, 'query'>, businessId: string): Promise<number> =>
  (await tx.query(`SELECT balance FROM ledger_accounts WHERE kind='business' AND owner_ref=$1`, [businessId])).rows[0]?.balance ?? 0;

/** Buy wholesale stock from the NPC supplier, paid from the business till (an expense). */
export async function restock(ctx: AppContext, characterId: string, businessId: string, itemId: string, quantity: number, idempotencyKey: string) {
  const it = item(ctx, itemId);
  const cfg = ctx.data.businesses;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > cfg.maxRestockPerOrder) throw badRequest('invalid_quantity');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const b = await ownedBusiness(tx, characterId, businessId, true);
    if (!cfg.types[b.type]!.categories.includes(it.category)) throw conflict('item_not_allowed_for_business_type');
    const total = it.wholesalePrice * quantity;
    const c = await claim<{ txId: string; itemId: string; quantity: number; cost: number }>(tx, {
      key: `${characterId}:restock:${idempotencyKey}`, type: 'business_restock', actorCharacterId: characterId,
      referenceType: 'business', referenceId: businessId, amount: total, payload: { businessId, itemId, quantity },
    });
    if (c.replay) return { ...c.response, replayed: true };

    const cur = (await tx.query('SELECT quantity FROM business_stock WHERE business_id=$1 AND item_id=$2 FOR UPDATE', [businessId, itemId])).rows[0];
    if ((cur?.quantity ?? 0) + quantity > cfg.maxStockPerItem) throw conflict('stock_limit', `Shelf limit is ${cfg.maxStockPerItem} per item`);
    await post(tx, c.txId, [{ account: businessAccount(businessId), delta: -total }, { account: systemAccount('sink:supplier_npc'), delta: total }]);
    // New items start at the reference price until the owner sets their own.
    await tx.query(
      `INSERT INTO business_stock (business_id,item_id,quantity,price) VALUES ($1,$2,$3,$4)
       ON CONFLICT (business_id,item_id) DO UPDATE SET quantity = business_stock.quantity + EXCLUDED.quantity`,
      [businessId, itemId, quantity, it.basePrice]);
    const response = { txId: c.txId, itemId, quantity, cost: total };
    await finish(tx, c.txId, response);
    return { ...response, replayed: false };
  });
}

/** Owner sets a price within configured bounds (prevents absurd gouging and wash-trading price games). */
export async function setPrice(ctx: AppContext, characterId: string, businessId: string, itemId: string, price: number) {
  const it = item(ctx, itemId);
  const cfg = ctx.data.businesses;
  const min = Math.max(1, Math.ceil(it.basePrice * cfg.priceMinMultiplier)), max = Math.floor(it.basePrice * cfg.priceMaxMultiplier);
  if (!Number.isInteger(price) || price < min || price > max) throw badRequest('price_out_of_range', `Price must be between ${min} and ${max} MVC`);
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await ownedBusiness(tx, characterId, businessId);
    const r = await tx.query('UPDATE business_stock SET price=$3 WHERE business_id=$1 AND item_id=$2', [businessId, itemId, price]);
    if (r.rowCount === 0) throw notFound('item_not_stocked');
    return { itemId, price };
  });
}

export async function viewBusiness(ctx: AppContext, businessId: string) {
  const b = (await ctx.pool.query(
    `SELECT b.id,b.name,b.type,b.status,b.premises_id,p.name AS premises_name,c.display_name AS owner FROM businesses b
       JOIN premises p ON p.id=b.premises_id JOIN characters c ON c.id=b.owner_character_id WHERE b.id=$1`, [businessId])).rows[0];
  if (!b) throw notFound('business_not_found');
  const names = new Map(ctx.data.items.map((i) => [i.id, i.name]));
  const stock = (await ctx.pool.query('SELECT item_id,quantity,price FROM business_stock WHERE business_id=$1 ORDER BY item_id', [businessId])).rows;
  return { businessId: b.id as string, name: b.name as string, type: b.type as string, status: b.status as string, owner: b.owner as string, premises: b.premises_name as string,
    stock: stock.map((s) => ({ itemId: s.item_id as string, name: names.get(s.item_id), quantity: s.quantity as number, price: s.price as number })) };
}

export async function listBusinesses(ctx: AppContext, district?: string) {
  const r = await ctx.pool.query(
    `SELECT b.id,b.name,b.type,p.district,c.display_name AS owner FROM businesses b JOIN premises p ON p.id=b.premises_id
       JOIN characters c ON c.id=b.owner_character_id WHERE b.status='open' AND ($1::text IS NULL OR p.district=$1) ORDER BY b.created_at`, [district ?? null]);
  return r.rows.map((x) => ({ businessId: x.id as string, name: x.name as string, type: x.type as string, district: x.district as string, owner: x.owner as string }));
}

/** Owner dashboard. Revenue, expenses and net profit are derived from the ledger; deposits/withdrawals are NOT profit or loss. */
export async function report(ctx: AppContext, characterId: string, businessId: string) {
  const b = (await ctx.pool.query('SELECT * FROM businesses WHERE id=$1', [businessId])).rows[0];
  if (!b) throw notFound('business_not_found');
  if (b.owner_character_id !== characterId) throw forbidden('not_business_owner');
  const sums = (await ctx.pool.query(
    `SELECT t.type, SUM(e.delta)::bigint AS s FROM ledger_entries e
       JOIN ledger_accounts a ON a.id=e.account_id AND a.kind='business' AND a.owner_ref=$1
       JOIN ledger_transactions t ON t.id=e.tx_id GROUP BY t.type`, [businessId])).rows;
  const by = Object.fromEntries(sums.map((x) => [x.type, Number(x.s)]));
  const revenue = (by.business_sale_npc ?? 0) + (by.business_sale_player ?? 0);
  const expenses = -(by.business_restock ?? 0);
  const sold = (await ctx.pool.query(
    `SELECT item_id, buyer_type, SUM(quantity)::int AS units FROM business_sales WHERE business_id=$1 GROUP BY item_id, buyer_type ORDER BY item_id`, [businessId])).rows;
  return {
    businessId, name: b.name as string, status: b.status as string,
    cash: await tillBalance(ctx.pool, businessId),
    revenue, expenses, netProfit: revenue - expenses,
    ownerDeposits: by.business_deposit ?? 0, ownerWithdrawals: -(by.business_withdraw ?? 0),
    unitsSold: sold.map((s) => ({ itemId: s.item_id as string, buyer: s.buyer_type as string, units: s.units as number })),
  };
}

/** A player buys from a player-owned business. Price comes from the DB; payment, stock and inventory are atomic. */
export async function purchaseFromBusiness(ctx: AppContext, buyerId: string, businessId: string, i: { itemId: string; quantity: number; idempotencyKey: string }) {
  if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99) throw badRequest('invalid_quantity');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, buyerId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [buyerId]);
    const b = (await tx.query('SELECT id, owner_character_id, status FROM businesses WHERE id=$1', [businessId])).rows[0];
    if (!b || b.status !== 'open') throw notFound('business_not_found');
    if (b.owner_character_id === buyerId) throw badRequest('cannot_buy_from_own_business');
    const s = (await tx.query('SELECT quantity, price FROM business_stock WHERE business_id=$1 AND item_id=$2 FOR UPDATE', [businessId, i.itemId])).rows[0];
    if (!s) throw notFound('item_not_sold_here');
    const total = (s.price as number) * i.quantity;
    const c = await claim<Record<string, unknown>>(tx, {
      key: `${buyerId}:biz-purchase:${i.idempotencyKey}`, type: 'business_sale_player', actorCharacterId: buyerId,
      referenceType: 'business', referenceId: businessId, amount: total, payload: { businessId, itemId: i.itemId, quantity: i.quantity },
    });
    if (c.replay) return { ...c.response, replayed: true };
    if (s.quantity < i.quantity) throw conflict('out_of_stock', 'Not enough stock');
    await tx.query('UPDATE business_stock SET quantity = quantity - $3 WHERE business_id=$1 AND item_id=$2', [businessId, i.itemId, i.quantity]);
    await post(tx, c.txId, [{ account: playerAccount(buyerId), delta: -total }, { account: businessAccount(businessId), delta: total }]);
    await addItem(tx, buyerId, i.itemId, i.quantity);
    await tx.query(`INSERT INTO business_sales (business_id,item_id,quantity,unit_price,buyer_type,buyer_character_id,tx_id,created_at) VALUES ($1,$2,$3,$4,'player',$5,$6,$7)`,
      [businessId, i.itemId, i.quantity, s.price, buyerId, c.txId, ctx.now()]);
    await awardAchievement(ctx, tx, b.owner_character_id, 'first_sale');
    await awardAchievement(ctx, tx, buyerId, 'first_purchase');
    const response = { txId: c.txId, businessId, itemId: i.itemId, quantity: i.quantity, totalPrice: total, balance: await balanceOf(tx, buyerId) };
    await finish(tx, c.txId, response);
    return { ...response, replayed: false };
  });
}

/** Close a business: till cash returns to the owner; remaining shelf stock is forfeited. */
export async function closeBusiness(ctx: AppContext, characterId: string, businessId: string, idempotencyKey: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    await ownedBusiness(tx, characterId, businessId, true);
    const cash = await tillBalance(tx, businessId);
    let txId: string | null = null;
    if (cash > 0) {
      const out = await transfer(tx, {
        key: `${characterId}:biz-close:${idempotencyKey}`, type: 'business_withdraw', actorCharacterId: characterId, referenceType: 'business', referenceId: businessId,
        from: businessAccount(businessId), to: playerAccount(characterId), amount: cash, payload: { businessId, close: true },
      }, (id) => ({ txId: id }));
      txId = out.response.txId;
    }
    await tx.query(`UPDATE businesses SET status='closed', closed_at=$2 WHERE id=$1`, [businessId, ctx.now()]);
    await tx.query('DELETE FROM business_stock WHERE business_id=$1', [businessId]);
    return { businessId, returnedCash: cash, txId };
  });
}

/**
 * Simulated NPC customers. Each tick a fixed pool of customers shops city-wide, so owners genuinely compete:
 * a customer picks an item by demand weight, then picks among businesses that stock it at an acceptable price,
 * favouring cheaper ones. NPC money comes from the `faucet:npc_customers` account so inflow is measurable.
 * `rng` is injectable for deterministic tests; `tickId` makes each customer's sale idempotent.
 */
export async function simulateNpcCustomers(ctx: AppContext, tickId: string, rng: () => number = Math.random) {
  const d = ctx.data.businesses.npcDemand;
  const tradable = ctx.data.items.filter((i) => i.wholesalePrice && i.basePrice);
  let sales = 0;
  for (let n = 0; n < d.customersPerTick; n++) {
    const totalDemand = tradable.reduce((a, i) => a + (i.npcDemand ?? 1), 0);
    let pick = rng() * totalDemand, chosen = tradable[0]!;
    for (const i of tradable) { pick -= i.npcDemand ?? 1; if (pick <= 0) { chosen = i; break; } }
    const base = chosen.basePrice!;
    const cands = (await ctx.pool.query(
      `SELECT s.business_id, s.price FROM business_stock s JOIN businesses b ON b.id=s.business_id
        WHERE b.status='open' AND s.item_id=$1 AND s.quantity > 0 AND s.price <= $2`, [chosen.id, Math.floor(base * d.maxPriceMultiplier)])).rows;
    if (cands.length === 0) continue;
    const weights = cands.map((c) => Math.pow(base / (c.price as number), d.priceSensitivity));
    let w = rng() * weights.reduce((a, b) => a + b, 0), idx = 0;
    for (let k = 0; k < weights.length; k++) { w -= weights[k]!; if (w <= 0) { idx = k; break; } }
    const target = cands[idx]!;
    const ok = await withTx(ctx.pool, async (tx) => {
      const s = (await tx.query('SELECT quantity, price FROM business_stock WHERE business_id=$1 AND item_id=$2 FOR UPDATE', [target.business_id, chosen.id])).rows[0];
      if (!s || s.quantity < 1) return false;
      const biz = (await tx.query(`SELECT status FROM businesses WHERE id=$1`, [target.business_id])).rows[0];
      if (biz?.status !== 'open') return false;
      const c = await claim(tx, { key: `npc-sale:${tickId}:${n}`, type: 'business_sale_npc', referenceType: 'business', referenceId: target.business_id, amount: s.price, payload: { n, tickId } });
      if (c.replay) return false;
      await tx.query('UPDATE business_stock SET quantity = quantity - 1 WHERE business_id=$1 AND item_id=$2', [target.business_id, chosen.id]);
      await post(tx, c.txId, [{ account: systemAccount('faucet:npc_customers'), delta: -s.price }, { account: businessAccount(target.business_id), delta: s.price }]);
      await tx.query(`INSERT INTO business_sales (business_id,item_id,quantity,unit_price,buyer_type,tx_id,created_at) VALUES ($1,$2,1,$3,'npc',$4,$5)`,
        [target.business_id, chosen.id, s.price, c.txId, ctx.now()]);
      await finish(tx, c.txId, { ok: true });
      const owner = (await tx.query('SELECT owner_character_id FROM businesses WHERE id=$1', [target.business_id])).rows[0].owner_character_id;
      await awardAchievement(ctx, tx, owner, 'first_sale');
      return true;
    });
    if (ok) sales++;
  }
  return { customers: d.customersPerTick, sales };
}

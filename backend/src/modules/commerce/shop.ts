import type { AppContext } from '../../context.js';
import { withTx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { claim, post, finish, playerAccount, systemAccount, balanceOf } from '../economy/ledger.js';
import { addItem } from '../inventory/inventory.js';
import { awardAchievement } from '../social/social.js';

export interface PurchaseInput { shopId: string; itemId: string; quantity: number; idempotencyKey: string }

export async function listShop(ctx: AppContext, shopId: string) {
  const shop = ctx.data.shops.find((s) => s.id === shopId);
  if (!shop) throw notFound('shop_not_found');
  const r = await ctx.pool.query('SELECT item_id, price, quantity FROM shop_stock WHERE shop_id=$1 ORDER BY item_id', [shopId]);
  const names = new Map(ctx.data.items.map((i) => [i.id, i.name]));
  return { shopId, name: shop.name, stock: r.rows.map((x) => ({ itemId: x.item_id, name: names.get(x.item_id), price: x.price as number, quantity: x.quantity as number | null })) };
}

/** Authoritative purchase: price comes from the DB, never from the caller. Payment + stock + inventory are one atomic unit. */
export async function purchase(ctx: AppContext, characterId: string, i: PurchaseInput) {
  if (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99) throw badRequest('invalid_quantity');
  if (!ctx.data.shops.some((s) => s.id === i.shopId)) throw notFound('shop_not_found');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    // Serialize this character's money-moving actions; prevents racing double-spends from one wallet.
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);

    const key = `${characterId}:purchase:${i.idempotencyKey}`;
    const stockRow = await tx.query('SELECT price, quantity FROM shop_stock WHERE shop_id=$1 AND item_id=$2 FOR UPDATE', [i.shopId, i.itemId]);
    const stock = stockRow.rows[0];
    if (!stock) throw notFound('item_not_sold_here');
    const total = (stock.price as number) * i.quantity;

    const c = await claim<PurchaseResult>(tx, {
      key, type: 'shop_purchase', actorCharacterId: characterId, referenceType: 'shop', referenceId: i.shopId,
      amount: total, payload: { shopId: i.shopId, itemId: i.itemId, quantity: i.quantity },
    });
    if (c.replay) return { ...c.response, replayed: true };

    if (stock.quantity !== null) {
      if (stock.quantity < i.quantity) throw conflict('out_of_stock', 'Not enough stock');
      await tx.query('UPDATE shop_stock SET quantity = quantity - $3 WHERE shop_id=$1 AND item_id=$2', [i.shopId, i.itemId, i.quantity]);
    }
    await post(tx, c.txId, [
      { account: playerAccount(characterId), delta: -total },
      { account: systemAccount(`shop:${i.shopId}`), delta: total },
    ]);
    await addItem(tx, characterId, i.itemId, i.quantity);
    await awardAchievement(ctx, tx, characterId, 'first_purchase');
    const response: PurchaseResult = { txId: c.txId, shopId: i.shopId, itemId: i.itemId, quantity: i.quantity, totalPrice: total, balance: await balanceOf(tx, characterId), replayed: false };
    await finish(tx, c.txId, response);
    return response;
  });
}

export interface PurchaseResult { txId: string; shopId: string; itemId: string; quantity: number; totalPrice: number; balance: number; replayed: boolean }

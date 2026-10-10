import type { Tx } from '../../db.js';
import { conflict } from '../../errors.js';

export async function addItem(tx: Tx, characterId: string, itemId: string, qty: number) {
  await tx.query(
    `INSERT INTO inventory_items (character_id,item_id,quantity) VALUES ($1,$2,$3)
     ON CONFLICT (character_id,item_id) DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity`,
    [characterId, itemId, qty],
  );
}

export async function removeItem(tx: Tx, characterId: string, itemId: string, qty: number) {
  const r = await tx.query(
    `UPDATE inventory_items SET quantity = quantity - $3 WHERE character_id=$1 AND item_id=$2 AND quantity >= $3`,
    [characterId, itemId, qty],
  );
  if (r.rowCount === 0) throw conflict('not_enough_items', 'You do not have that item');
}

export async function listInventory(tx: Pick<Tx, 'query'>, characterId: string) {
  const r = await tx.query('SELECT item_id, quantity FROM inventory_items WHERE character_id=$1 AND quantity>0 ORDER BY item_id', [characterId]);
  return r.rows.map((x) => ({ itemId: x.item_id as string, quantity: x.quantity as number }));
}

-- Metros are now one continuous world of districts, so saved positions and placed furniture from the old per-area worlds no longer apply.
ALTER TABLE characters ADD COLUMN pos_rev integer NOT NULL DEFAULT 1;      -- 1 = old per-area coordinates (ignored on join), 2 = metro coordinates
ALTER TABLE characters ALTER COLUMN pos_rev SET DEFAULT 2;
INSERT INTO inventory_items (character_id, item_id, quantity)
  SELECT t.character_id, f.item_id, count(*)::int FROM placed_furniture f JOIN tenancies t ON t.id = f.tenancy_id GROUP BY t.character_id, f.item_id
  ON CONFLICT (character_id, item_id) DO UPDATE SET quantity = inventory_items.quantity + EXCLUDED.quantity;
DELETE FROM placed_furniture;

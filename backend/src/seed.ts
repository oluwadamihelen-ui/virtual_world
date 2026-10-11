import type { Pool } from './db.js';
import type { GameData } from './gamedata.js';

/** Sync static game data into the DB. Safe to run on every boot: never resets live stock or occupancy. */
export async function syncGameData(pool: Pool, data: GameData) {
  for (const p of data.properties) {
    await pool.query(
      `INSERT INTO properties (id,type,district,name,rent_per_period,capacity,furniture_slots,lot_id,sale_price,beds,size_sqm,blurb,build_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET district=EXCLUDED.district, capacity=EXCLUDED.capacity, lot_id=EXCLUDED.lot_id, size_sqm=EXCLUDED.size_sqm, blurb=EXCLUDED.blurb, build_cost=EXCLUDED.build_cost,
         -- rows a player changed (land built into a house) keep their live type/name/prices
         type = CASE WHEN properties.built THEN properties.type ELSE EXCLUDED.type END,
         name = CASE WHEN properties.built THEN properties.name ELSE EXCLUDED.name END,
         rent_per_period = CASE WHEN properties.built THEN properties.rent_per_period ELSE EXCLUDED.rent_per_period END,
         sale_price = CASE WHEN properties.built THEN properties.sale_price ELSE EXCLUDED.sale_price END,
         furniture_slots = CASE WHEN properties.built THEN properties.furniture_slots ELSE EXCLUDED.furniture_slots END,
         beds = CASE WHEN properties.built THEN properties.beds ELSE EXCLUDED.beds END`,
      [p.id, p.type, p.district, p.name, p.rentPerPeriod, p.capacity, p.furnitureSlots, p.lot ?? null, p.salePrice ?? null, p.beds ?? 1, p.sizeSqm ?? 30, p.blurb ?? '', p.buildCost ?? null],
    );
  }
  for (const pr of data.businesses.premises) {
    await pool.query(
      `INSERT INTO premises (id,district,name,setup_cost) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET district=EXCLUDED.district, name=EXCLUDED.name, setup_cost=EXCLUDED.setup_cost`,
      [pr.id, pr.district, pr.name, pr.setupCost],
    );
  }
  for (const s of data.shops) for (const st of s.stock) {
    await pool.query(
      `INSERT INTO shop_stock (shop_id,item_id,price,quantity) VALUES ($1,$2,$3,$4)
       ON CONFLICT (shop_id,item_id) DO UPDATE SET price=EXCLUDED.price`,
      [s.id, st.itemId, st.price, st.quantity],
    );
  }
}

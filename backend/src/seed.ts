import type { Pool } from './db.js';
import type { GameData } from './gamedata.js';

/** Sync static game data into the DB. Safe to run on every boot: never resets live stock or occupancy. */
export async function syncGameData(pool: Pool, data: GameData) {
  for (const p of data.properties) {
    await pool.query(
      `INSERT INTO properties (id,type,district,name,rent_per_period,capacity,furniture_slots)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, district=EXCLUDED.district, name=EXCLUDED.name,
         rent_per_period=EXCLUDED.rent_per_period, capacity=EXCLUDED.capacity, furniture_slots=EXCLUDED.furniture_slots`,
      [p.id, p.type, p.district, p.name, p.rentPerPeriod, p.capacity, p.furnitureSlots],
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

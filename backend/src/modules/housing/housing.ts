import type { AppContext } from '../../context.js';
import { withTx, savepoint, type Tx } from '../../db.js';
import { AppError, badRequest, conflict, notFound } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { claim, post, finish, playerAccount, systemAccount } from '../economy/ledger.js';
import { addItem, removeItem } from '../inventory/inventory.js';
import { awardAchievement } from '../social/social.js';

const HOUR = 3600_000;
const LIVE = ['active', 'grace'];

export async function listProperties(ctx: AppContext) {
  const r = await ctx.pool.query('SELECT id,type,district,name,rent_per_period,capacity,furniture_slots,status FROM properties ORDER BY id');
  return r.rows.map((p) => ({
    propertyId: p.id, type: p.type, district: p.district, name: p.name, rentPerPeriod: p.rent_per_period as number,
    rentPeriodHours: ctx.data.economy.rentPeriodHours, graceHours: ctx.data.economy.rentGraceHours,
    capacity: p.capacity, furnitureSlots: p.furniture_slots, available: p.status === 'available',
  }));
}

/** Rent a property. Exclusive: the property row lock + partial unique index guarantee a single winner. */
export async function rent(ctx: AppContext, characterId: string, propertyId: string, idempotencyKey: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const now = ctx.now();
    const e = ctx.data.economy;

    const prop = (await tx.query('SELECT * FROM properties WHERE id=$1 FOR UPDATE', [propertyId])).rows[0];
    if (!prop) throw notFound('property_not_found');

    const c = await claim<RentResult>(tx, {
      key: `${characterId}:rent:${idempotencyKey}`, type: 'rent_initial', actorCharacterId: characterId,
      referenceType: 'property', referenceId: propertyId, amount: prop.rent_per_period, payload: { propertyId },
    });
    if (c.replay) return { ...c.response, replayed: true };

    if (prop.status !== 'available') throw conflict('property_unavailable', 'This property is already taken');
    if (prop.type === 'land' || !(prop.rent_per_period > 0)) throw conflict('not_for_rent', 'This property is not for rent.');
    const mine = (await tx.query(`SELECT count(*)::int n FROM tenancies WHERE character_id=$1 AND status = ANY($2)`, [characterId, LIVE])).rows[0].n;
    if (mine >= e.maxActiveTenanciesPerCharacter) throw conflict('tenancy_limit', 'You already rent a property');

    await post(tx, c.txId, [
      { account: playerAccount(characterId), delta: -prop.rent_per_period },
      { account: systemAccount('sink:landlord_npc'), delta: prop.rent_per_period },
    ]);
    const periodEnd = new Date(now.getTime() + e.rentPeriodHours * HOUR);
    const t = (await tx.query(
      `INSERT INTO tenancies (property_id,character_id,status,rent_amount,started_at,paid_until) VALUES ($1,$2,'active',$3,$4,$5) RETURNING id`,
      [propertyId, characterId, prop.rent_per_period, now, periodEnd],
    )).rows[0];
    await tx.query(`INSERT INTO rent_payments (tenancy_id,tx_id,amount,period_start,period_end,paid_at) VALUES ($1,$2,$3,$4,$5,$4)`, [t.id, c.txId, prop.rent_per_period, now, periodEnd]);
    await tx.query(`UPDATE properties SET status='occupied' WHERE id=$1`, [propertyId]);
    await awardAchievement(ctx, tx, characterId, 'first_home');
    const response: RentResult = { txId: c.txId, tenancyId: t.id, propertyId, rentPaid: prop.rent_per_period, paidUntil: periodEnd.toISOString(), replayed: false };
    await finish(tx, c.txId, response);
    return response;
  });
}
export interface RentResult { txId: string; tenancyId: string; propertyId: string; rentPaid: number; paidUntil: string; replayed: boolean }

export async function currentTenancy(tx: Pick<Tx, 'query'>, characterId: string) {
  const r = await tx.query(
    `SELECT t.*, p.name AS property_name, p.furniture_slots, p.district AS property_district, p.type AS property_type, p.beds AS property_beds FROM tenancies t JOIN properties p ON p.id=t.property_id
      WHERE t.character_id=$1 AND t.status = ANY($2) ORDER BY t.started_at DESC LIMIT 1`, [characterId, LIVE]);
  const t = r.rows[0];
  if (!t) return null;
  return {
    tenancyId: t.id as string, propertyId: t.property_id as string, propertyName: t.property_name as string, district: t.property_district as string, status: t.status as string, kind: t.kind as string, propertyType: t.property_type as string, beds: t.property_beds as number,
    rentAmount: t.rent_amount as number, paidUntil: (t.paid_until as Date).toISOString(),
    graceUntil: t.grace_until ? (t.grace_until as Date).toISOString() : null, furnitureSlots: t.furniture_slots as number,
  };
}

export async function rentHistory(ctx: AppContext, characterId: string) {
  const r = await ctx.pool.query(
    `SELECT rp.amount, rp.period_start, rp.period_end, rp.paid_at, t.property_id FROM rent_payments rp
       JOIN tenancies t ON t.id=rp.tenancy_id WHERE t.character_id=$1 ORDER BY rp.paid_at DESC, rp.period_start DESC LIMIT 100`, [characterId]);
  return r.rows.map((x) => ({ propertyId: x.property_id, amount: x.amount, periodStart: x.period_start, periodEnd: x.period_end, paidAt: x.paid_at }));
}

/** Door check used by the game server before letting a character into a property's interior. */
export async function checkAccess(ctx: AppContext, propertyId: string, characterId: string) {
  await assertCanAct(ctx, ctx.pool, characterId);
  const r = await ctx.pool.query(`SELECT status FROM tenancies WHERE property_id=$1 AND character_id=$2 AND status = ANY($3)`, [propertyId, characterId, LIVE]);
  return r.rowCount ? { allowed: true, tenancyStatus: r.rows[0].status as string } : { allowed: false, reason: 'no_active_tenancy' };
}

export async function endTenancy(tx: Tx, t: { id: string; property_id: string; character_id: string }, reason: string, now: Date) {
  await tx.query(`UPDATE tenancies SET status='ended', ended_at=$2, end_reason=$3 WHERE id=$1`, [t.id, now, reason]);
  await tx.query(`UPDATE properties SET status = CASE WHEN owner_id IS NULL THEN 'available' ELSE 'owned' END WHERE id=$1`, [t.property_id]);
  // Nothing is destroyed: placed furniture goes back to the tenant's inventory.
  const f = await tx.query('DELETE FROM placed_furniture WHERE tenancy_id=$1 RETURNING item_id', [t.id]);
  for (const row of f.rows) await addItem(tx, t.character_id, row.item_id, 1);
}

/**
 * Rent lifecycle for one tenancy: auto-pay when due; on failure enter a grace period; end only after grace expires.
 * Safe to call repeatedly (idempotent per billing period). Tenancies of suspended/banned accounts are left untouched.
 */
export async function processTenancy(ctx: AppContext, tenancyId: string): Promise<string> {
  return withTx(ctx.pool, async (tx) => {
    const now = ctx.now();
    const e = ctx.data.economy;
    const t = (await tx.query(`SELECT * FROM tenancies WHERE id=$1 AND status = ANY($2) AND kind='rent' FOR UPDATE`, [tenancyId, LIVE])).rows[0];
    if (!t) return 'ended_or_missing';
    try { await assertCanAct(ctx, tx, t.character_id); } catch { return 'skipped_sanctioned'; }

    let status: string = t.status;
    let paidUntil: Date = t.paid_until;
    for (let i = 0; i < 4 && paidUntil <= now; i++) {
      try {
        const periodEnd = new Date(paidUntil.getTime() + e.rentPeriodHours * HOUR);
        await savepoint(tx, async () => {
          const c = await claim<{ txId: string }>(tx, {
            key: `rent:${t.id}:${paidUntil.toISOString()}`, type: 'rent_renewal', actorCharacterId: t.character_id,
            referenceType: 'tenancy', referenceId: t.id, amount: t.rent_amount, payload: { tenancy: t.id, due: paidUntil.toISOString() },
          });
          if (c.replay) return c.response;
          await post(tx, c.txId, [{ account: playerAccount(t.character_id), delta: -t.rent_amount }, { account: systemAccount('sink:landlord_npc'), delta: t.rent_amount }]);
          await tx.query(`INSERT INTO rent_payments (tenancy_id,tx_id,amount,period_start,period_end,paid_at) VALUES ($1,$2,$3,$4,$5,$6)`, [t.id, c.txId, t.rent_amount, paidUntil, periodEnd, now]);
          await finish(tx, c.txId, { txId: c.txId });
          return { txId: c.txId };
        });
        paidUntil = periodEnd;
        status = 'active';
        await tx.query(`UPDATE tenancies SET status='active', paid_until=$2, grace_until=NULL WHERE id=$1`, [t.id, paidUntil]);
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'insufficient_funds') throw err;
        if (status === 'active') {
          const graceUntil = new Date(now.getTime() + e.rentGraceHours * HOUR);
          await tx.query(`UPDATE tenancies SET status='grace', grace_until=$2 WHERE id=$1`, [t.id, graceUntil]);
          return 'grace';
        }
        if (t.grace_until && t.grace_until <= now) {
          await endTenancy(tx, t, 'rent_unpaid', now);
          return 'ended';
        }
        return 'grace';
      }
    }
    return status;
  });
}

/** Process every tenancy that is due. Called on a timer by the server and on player join. */
export async function sweepTenancies(ctx: AppContext, characterId?: string): Promise<number> {
  const r = await ctx.pool.query(
    `SELECT id FROM tenancies WHERE kind='rent' AND status = ANY($1) AND paid_until <= $2 AND ($3::uuid IS NULL OR character_id=$3)`,
    [LIVE, ctx.now(), characterId ?? null],
  );
  for (const row of r.rows) await processTenancy(ctx, row.id);
  return r.rowCount ?? 0;
}

// ---- Furnishing ----
const Coord = (n: number) => Number.isFinite(n) && Math.abs(n) <= 5000;

export async function placeFurniture(ctx: AppContext, characterId: string, itemId: string, pos: { x: number; y: number; z: number; yaw?: number }) {
  if (![pos.x, pos.y, pos.z].every(Coord)) throw badRequest('invalid_position');
  const item = ctx.data.items.find((i) => i.id === itemId);
  if (!item || item.category !== 'furniture') throw badRequest('not_furniture');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const t = await currentTenancy(tx, characterId);
    if (!t) throw conflict('no_tenancy', 'You do not rent a property');
    const n = (await tx.query('SELECT count(*)::int n FROM placed_furniture WHERE tenancy_id=$1', [t.tenancyId])).rows[0].n;
    if (n >= t.furnitureSlots) throw conflict('furniture_limit', 'No free furniture slots');
    await removeItem(tx, characterId, itemId, 1);
    const r = await tx.query(`INSERT INTO placed_furniture (tenancy_id,item_id,pos_x,pos_y,pos_z,yaw) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [t.tenancyId, itemId, pos.x, pos.y, pos.z, pos.yaw ?? 0]);
    return { furnitureId: r.rows[0].id as string, slotsUsed: n + 1, slotsTotal: t.furnitureSlots };
  });
}

export async function removeFurniture(ctx: AppContext, characterId: string, furnitureId: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const r = await tx.query(
      `DELETE FROM placed_furniture f USING tenancies t WHERE f.id=$1 AND f.tenancy_id=t.id AND t.character_id=$2 AND t.status = ANY($3) RETURNING f.item_id`,
      [furnitureId, characterId, LIVE]);
    if (r.rowCount === 0) throw notFound('furniture_not_found');
    await addItem(tx, characterId, r.rows[0].item_id, 1);
    return { returned: r.rows[0].item_id as string };
  });
}

export async function listFurniture(tx: Pick<Tx, 'query'>, characterId: string) {
  const r = await tx.query(
    `SELECT f.id,f.item_id,f.pos_x,f.pos_y,f.pos_z,f.yaw FROM placed_furniture f JOIN tenancies t ON t.id=f.tenancy_id
      WHERE t.character_id=$1 AND t.status = ANY($2) ORDER BY f.id`, [characterId, LIVE]);
  return r.rows.map((x) => ({ furnitureId: x.id, itemId: x.item_id, x: x.pos_x, y: x.pos_y, z: x.pos_z, yaw: x.yaw }));
}

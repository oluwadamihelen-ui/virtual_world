import { randomBytes } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { claim, post, finish, playerAccount, systemAccount } from '../economy/ledger.js';
import { payBill, settlePremiums, coverShare } from './bills.js';
import { completeDue, hasCredential } from './courses.js';

const L = (ctx: AppContext) => ctx.data.life.cars;
const model = (ctx: AppContext, id: string) => { const m = L(ctx).models.find((x) => x.id === id); if (!m) throw badRequest('unknown_model'); return m; };
const PLATE = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const newPlate = () => { const b = randomBytes(5); return `${PLATE[b[0]! % PLATE.length]}${PLATE[b[1]! % PLATE.length]}${PLATE[b[2]! % PLATE.length]}-${100 + (b[3]! * 3) % 900}-${PLATE[b[4]! % PLATE.length]}${PLATE[(b[4]! >> 3) % PLATE.length]}`; };
const r1 = (n: number) => Math.round(n * 10) / 10;

export const resaleValue = (ctx: AppContext, m: { price: number }, condition: number) =>
  Math.round(m.price * (L(ctx).resaleMin + (L(ctx).resaleMax - L(ctx).resaleMin) * Math.max(0, Math.min(100, condition)) / 100));
const atGarage = (ctx: AppContext, at: string | null) => !!at && L(ctx).garageDiscountAt.includes(at);
const discounted = (ctx: AppContext, fee: number, at: string | null) => Math.round(fee * (atGarage(ctx, at) ? 1 - L(ctx).garageDiscountPercent / 100 : 1));
export const repairFee = (ctx: AppContext, carRow: { model_id: string; condition: unknown }, at: string | null) =>
  discounted(ctx, Math.ceil((100 - Number(carRow.condition)) * model(ctx, carRow.model_id).repairPerPoint), at);

const view = (ctx: AppContext, c: any, at: string | null) => {
  const m = model(ctx, c.model_id), fuel = Number(c.fuel), cond = Number(c.condition);
  return { id: c.id as string, modelId: m.id, name: m.name, emoji: m.emoji, color: m.color, plate: c.plate as string, active: !!c.active, fuel: r1(fuel), tank: m.tank, condition: r1(cond),
    value: resaleValue(ctx, m, cond), repairFee: repairFee(ctx, c, at), speedMult: m.speedMult, range: Math.floor(fuel / m.litresPerKm * 10) / 10 };
};

export async function garage(ctx: AppContext, characterId: string, at: string | null) {
  return withTx(ctx.pool, async (tx) => {
    await completeDue(ctx, tx, characterId); await settlePremiums(ctx, tx, characterId);
    const cars = (await tx.query('SELECT * FROM cars WHERE character_id=$1 AND sold_at IS NULL ORDER BY created_at', [characterId])).rows;
    const licence = await hasCredential(ctx, tx, characterId, L(ctx).requiresCredential);
    const pol = (await tx.query(`SELECT car_id, plan_id FROM policies WHERE character_id=$1 AND kind='car' AND status='active'`, [characterId])).rows;
    return {
      licence, licenceName: ctx.data.life.credentials[L(ctx).requiresCredential], maxOwned: L(ctx).maxOwned, fuelPrice: L(ctx).fuelPricePerLitre,
      garageDiscount: atGarage(ctx, at) ? L(ctx).garageDiscountPercent : 0, at,
      owned: cars.map((c) => ({ ...view(ctx, c, at), insured: pol.some((p) => p.car_id === c.id) })),
      showroom: L(ctx).models.map((m) => ({ id: m.id, name: m.name, emoji: m.emoji, color: m.color, price: m.price, speedMult: m.speedMult, tank: m.tank, kmPerFullTank: Math.floor(m.tank / m.litresPerKm) })),
    };
  });
}

async function owned(ctx: AppContext, tx: Tx, characterId: string, carId: string) {
  const c = (await tx.query('SELECT * FROM cars WHERE id=$1 AND character_id=$2 AND sold_at IS NULL FOR UPDATE', [carId, characterId])).rows[0];
  if (!c) throw notFound('car_not_found');
  return c;
}

export async function buy(ctx: AppContext, characterId: string, modelId: string, key: string) {
  const m = model(ctx, modelId);
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    await completeDue(ctx, tx, characterId);
    if (!(await hasCredential(ctx, tx, characterId, L(ctx).requiresCredential))) throw conflict('licence_needed', 'You need a driving licence first. Study for it in the Courses app.');
    const n = (await tx.query('SELECT count(*)::int n FROM cars WHERE character_id=$1 AND sold_at IS NULL', [characterId])).rows[0].n;
    const k = await claim(tx, { key: `car-buy:${key}`, type: 'car_purchase', actorCharacterId: characterId, referenceType: 'car_model', referenceId: m.id, amount: m.price, payload: { model: m.id } });
    if (k.replay) return { replayed: true };
    if (n >= L(ctx).maxOwned) throw conflict('garage_full', `You can own at most ${L(ctx).maxOwned} cars.`);
    await post(tx, k.txId, [{ account: playerAccount(characterId), delta: -m.price }, { account: systemAccount('sink:dealer'), delta: m.price }]);
    const car = (await tx.query(`INSERT INTO cars (character_id, model_id, plate, fuel, bought_for, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [characterId, m.id, newPlate(), m.tank / 2, m.price, n === 0])).rows[0];
    await finish(tx, k.txId, { carId: car.id });
    return { replayed: false, car: view(ctx, car, null) };
  });
}

export async function sell(ctx: AppContext, characterId: string, carId: string, key: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const c = await owned(ctx, tx, characterId, carId), m = model(ctx, c.model_id), value = resaleValue(ctx, m, Number(c.condition));
    const k = await claim(tx, { key: `car-sell:${key}`, type: 'car_sale', actorCharacterId: characterId, referenceType: 'car', referenceId: carId, amount: value, payload: { carId } });
    if (k.replay) return { replayed: true, value };
    await post(tx, k.txId, [{ account: systemAccount('faucet:dealer'), delta: -value }, { account: playerAccount(characterId), delta: value }]);
    await finish(tx, k.txId, { value });
    await tx.query('UPDATE cars SET sold_at=$2, active=false WHERE id=$1', [carId, ctx.now()]);
    await tx.query(`UPDATE policies SET status='cancelled' WHERE car_id=$1 AND status='active'`, [carId]);
    return { replayed: false, value, wasActive: !!c.active };
  });
}

export async function activate(ctx: AppContext, characterId: string, carId: string) {
  return withTx(ctx.pool, async (tx) => {
    await owned(ctx, tx, characterId, carId);
    await tx.query('UPDATE cars SET active=(id=$2) WHERE character_id=$1 AND sold_at IS NULL', [characterId, carId]);
    return { ok: true };
  });
}

export async function refuel(ctx: AppContext, characterId: string, carId: string, litres: number | 'full', key: string, at: string | null) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const c = await owned(ctx, tx, characterId, carId), m = model(ctx, c.model_id), room = m.tank - Number(c.fuel);
    const add = Math.min(litres === 'full' ? room : litres, room);
    if (add < 0.5) throw conflict('tank_full', 'The tank is already full.');
    const fee = Math.max(1, discounted(ctx, Math.round(add * L(ctx).fuelPricePerLitre), at));
    const bill = await payBill(ctx, tx, characterId, { amount: fee, sink: 'sink:fuel', type: 'fuel', key: `fuel:${key}`, refId: carId });
    if (!bill.replay) await tx.query('UPDATE cars SET fuel=fuel+$2 WHERE id=$1', [carId, add]);
    return { added: r1(add), fee, replayed: bill.replay };
  });
}

export async function repair(ctx: AppContext, characterId: string, carId: string, key: string, at: string | null) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const c = await owned(ctx, tx, characterId, carId);
    if (Number(c.condition) >= 99.5) throw conflict('no_repair_needed', 'The car is in perfect condition.');
    const fee = repairFee(ctx, c, at);
    const bill = await payBill(ctx, tx, characterId, { amount: fee, sink: 'sink:garage', type: 'car_repair', key: `repair:${key}`, kind: 'car', carId, refId: carId });
    if (!bill.replay) await tx.query('UPDATE cars SET condition=100 WHERE id=$1', [carId]);
    return { fee, youPaid: bill.paid, insurerPaid: bill.covered, replayed: bill.replay };
  });
}

/** The car the player drives: their active car, with its model, or null. */
export async function activeCar(ctx: AppContext, characterId: string) {
  const c = (await ctx.pool.query('SELECT * FROM cars WHERE character_id=$1 AND active AND sold_at IS NULL', [characterId])).rows[0];
  if (!c) return null;
  return { row: c, model: model(ctx, c.model_id) };
}
export async function saveWear(ctx: AppContext, carId: string, fuel: number, condition: number) {
  await ctx.pool.query('UPDATE cars SET fuel=$2, condition=$3 WHERE id=$1 AND sold_at IS NULL', [carId, Math.max(0, fuel), Math.max(0, Math.min(100, condition))]);
}
export { coverShare };

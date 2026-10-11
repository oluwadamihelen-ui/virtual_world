import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createWorld, key, type TestWorld } from './helpers.js';
import { Gateway } from '../src/realtime/gateway.js';
import { Client } from './wsclient.js';
import * as health from '../src/modules/life/health.js';
import * as courses from '../src/modules/life/courses.js';
import * as cars from '../src/modules/life/cars.js';
import * as assurance from '../src/modules/life/assurance.js';
import * as jobs from '../src/modules/employment/jobs.js';
import { verifyLedgerIntegrity, balanceOf } from '../src/modules/economy/ledger.js';

let w: TestWorld; let gw: Gateway; let port: number;
beforeEach(async () => {
  w = await createWorld(); gw = new Gateway(w.ctx); gw.attach(w.app.server);
  await w.app.listen({ port: 0, host: '127.0.0.1' }); port = (w.app.server.address() as AddressInfo).port;
});
afterEach(async () => { await gw.close(); await w.close(); });

type P = { token: string; characterId: string; accountId: string };
const HOUR = 3600_000;
const bal = (p: P) => balanceOf(w.ctx.pool as any, p.characterId);
const advance = (ms: number) => { w.clock.t = new Date(w.clock.t.getTime() + ms); };
const give = async (p: P, delta: number) => { const a = await w.newPlayer('Banker ' + key().slice(0, 6)); const tok = await w.setRole(a.accountId, 'admin'); await w.playerReq(tok, 'POST', '/v1/admin/adjustments', { characterId: p.characterId, delta, reason: 'test funding for life apps', idempotencyKey: key() }); };
const licence = (p: P) => w.ctx.pool.query(`INSERT INTO credentials (character_id, credential_id) VALUES ($1,'driving_licence') ON CONFLICT DO NOTHING`, [p.characterId]);
const hv = async (p: P) => (await w.ctx.pool.query('SELECT value FROM character_health WHERE character_id=$1', [p.characterId])).rows[0]?.value as number | undefined;
async function join(p: P): Promise<Client> {
  const t = (await w.playerReq(p.token, 'POST', `/v1/characters/${p.characterId}/join-ticket`)).body.ticket;
  const c = await Client.open(`ws://127.0.0.1:${port}/ws?ticket=${t}`);
  if (!(c instanceof Client)) throw new Error('rejected');
  await c.until(() => c.of('welcome').length > 0); return c;
}
const me = (p: P) => gw.players.get(p.characterId)!;

describe('health', () => {
  it('starts healthy, decays with time, can be treated, and gates work', async () => {
    const p = await w.newPlayer('Hale Hana'); await give(p, 3000);
    expect((await health.overview(w.ctx, p.characterId, null)).state.value).toBe(90);
    advance(10 * HOUR);                                                   // 3 per hour
    expect((await health.overview(w.ctx, p.characterId, null)).state.value).toBe(60);
    advance(100 * HOUR);                                                  // offline decay is capped (16 h)
    expect((await health.overview(w.ctx, p.characterId, null)).state.value).toBe(12);
    const before = await bal(p);
    await expect(health.treat(w.ctx, p.characterId, 'hospital', key(), null)).rejects.toMatchObject({ code: 'wrong_place' });
    const t1 = await health.treat(w.ctx, p.characterId, 'tablets', key(), null);
    expect(t1).toMatchObject({ paid: 40, covered: 0 }); expect(t1.state.value).toBe(32); expect(await bal(p)).toBe(before - 40);
    const t2 = await health.treat(w.ctx, p.characterId, 'checkup', key(), 'clinic');   // 40% off inside a clinic
    expect(t2.paid).toBe(72);
    const t3 = await health.treat(w.ctx, p.characterId, 'hospital', key(), 'hospital');
    expect(t3.state.value).toBe(100);
    await expect(health.treat(w.ctx, p.characterId, 'tablets', key(), null)).rejects.toMatchObject({ code: 'already_healthy' });
    // too unwell to start a shift; a finished shift tires you out
    await w.ctx.pool.query('UPDATE character_health SET value=10 WHERE character_id=$1', [p.characterId]);
    await expect(jobs.startShift(w.ctx, p.characterId, 'job_grocery_assistant')).rejects.toMatchObject({ code: 'too_unwell' });
    await w.ctx.pool.query('UPDATE character_health SET value=80 WHERE character_id=$1', [p.characterId]);
    const sh = await jobs.startShift(w.ctx, p.characterId, 'job_grocery_assistant');
    for (let i = 0; i < sh.tasksRequired; i++) { advance(25_000); await jobs.completeTask(w.ctx, p.characterId, sh.shiftId); }
    await jobs.completeShift(w.ctx, p.characterId, sh.shiftId);
    expect(await hv(p)).toBeCloseTo(74, 0);
    expect((await verifyLedgerIntegrity(w.ctx.pool as any)).ok).toBe(true);
  });
});

describe('courses and credentials', () => {
  it('studying takes time, unlocks qualified jobs, and is one course at a time', async () => {
    const p = await w.newPlayer('Student Sade'); await give(p, 5000);
    await expect(jobs.startShift(w.ctx, p.characterId, 'job_bank_teller')).rejects.toMatchObject({ code: 'qualification_needed' });
    const before = await bal(p);
    await expect(courses.enrol(w.ctx, p.characterId, 'course_admin', key())).rejects.toMatchObject({ code: 'requirements_not_met' });   // needs reputation
    const k = key(); await courses.enrol(w.ctx, p.characterId, 'course_service', k);
    expect(await bal(p)).toBe(before - 600);
    expect((await courses.enrol(w.ctx, p.characterId, 'course_service', k)) as any).toMatchObject({ replayed: true }); expect(await bal(p)).toBe(before - 600);
    await expect(courses.enrol(w.ctx, p.characterId, 'course_driving', key())).rejects.toMatchObject({ code: 'already_studying' });
    expect((await courses.overview(w.ctx, p.characterId)).studying?.courseId).toBe('course_service');
    advance(6 * 60_000);
    const ov = await courses.overview(w.ctx, p.characterId);
    expect(ov.studying).toBeNull(); expect(ov.credentials.map((c) => c.id)).toEqual(['cert_service']);
    expect((await w.ctx.pool.query(`SELECT xp FROM skills WHERE character_id=$1 AND skill_id='hospitality'`, [p.characterId])).rows[0].xp).toBe(30);
    expect((await jobs.startShift(w.ctx, p.characterId, 'job_bank_teller')).jobId).toBe('job_bank_teller');
    await expect(courses.enrol(w.ctx, p.characterId, 'course_service', key())).rejects.toMatchObject({ code: 'already_qualified' });
  });
});

describe('insurance', () => {
  it('cover starts after the waiting period, the insurer pays its share, premiums renew weekly and lapse when unaffordable', async () => {
    const p = await w.newPlayer('Covered Chidi'); await give(p, 3000);
    const pol = await assurance.buy(w.ctx, p.characterId, 'health_basic', undefined, key()) as any;
    expect(pol.premium).toBe(50);
    await expect(assurance.buy(w.ctx, p.characterId, 'health_plus', undefined, key())).rejects.toMatchObject({ code: 'already_covered' });
    await w.ctx.pool.query('UPDATE character_health SET value=10 WHERE character_id=$1', [p.characterId]).catch(() => {});
    await health.overview(w.ctx, p.characterId, null);
    await w.ctx.pool.query('UPDATE character_health SET value=10, updated_at=$2 WHERE character_id=$1', [p.characterId, w.clock.t]);
    expect((await health.treat(w.ctx, p.characterId, 'checkup', key(), null)).covered).toBe(0);      // still in the waiting period
    advance(13 * HOUR); await w.ctx.pool.query('UPDATE character_health SET value=10, updated_at=$2 WHERE character_id=$1', [p.characterId, w.clock.t]);
    const t = await health.treat(w.ctx, p.characterId, 'checkup', key(), null);
    expect(t).toMatchObject({ covered: 84, paid: 36 });                                               // 70% of 120
    expect((await verifyLedgerIntegrity(w.ctx.pool as any)).ok).toBe(true);
    // the first week is paid; the next premium is taken when it falls due
    const b0 = await bal(p); advance(170 * HOUR); await assurance.overview(w.ctx, p.characterId);
    expect(await bal(p)).toBe(b0 - 50);
    // a player who cannot pay loses cover instead of going negative
    await w.ctx.pool.query(`UPDATE policies SET paid_until=$2 WHERE character_id=$1`, [p.characterId, new Date(w.clock.t.getTime() - HOUR)]);
    const left = await bal(p); await give(p, -left, ).catch(() => {});
    const o = await assurance.overview(w.ctx, p.characterId);
    expect(o.policies[0]!.status).toBe('lapsed'); expect(await bal(p)).toBeGreaterThanOrEqual(0);
  });
});

describe('cars', () => {
  it('needs a licence, limits the garage, refuels, repairs (insured), and sells for a depreciated price', async () => {
    const p = await w.newPlayer('Driver Dayo'); await give(p, 100000);
    await expect(cars.buy(w.ctx, p.characterId, 'hatch', key())).rejects.toMatchObject({ code: 'licence_needed' });
    await licence(p);
    const b0 = await bal(p);
    const bought = await cars.buy(w.ctx, p.characterId, 'hatch', key()) as any;
    expect(await bal(p)).toBe(b0 - 8000); expect(bought.car).toMatchObject({ fuel: 30, condition: 100, active: true });
    await cars.buy(w.ctx, p.characterId, 'sedan', key()); await cars.buy(w.ctx, p.characterId, 'suv', key());
    await expect(cars.buy(w.ctx, p.characterId, 'sport', key())).rejects.toMatchObject({ code: 'garage_full' });
    const id = bought.car.id as string;
    const f = await cars.refuel(w.ctx, p.characterId, id, 'full', key(), null);
    expect(f).toMatchObject({ added: 30, fee: 45 });                                    // 30 L at 1.5
    expect((await cars.refuel(w.ctx, p.characterId, id, 'full', key(), null).catch((e) => e.code))).toBe('tank_full');
    await w.ctx.pool.query('UPDATE cars SET condition=50, fuel=10 WHERE id=$1', [id]);
    expect((await cars.refuel(w.ctx, p.characterId, id, 20, key(), 'garage')).fee).toBe(21);   // garage is 30% off
    await assurance.buy(w.ctx, p.characterId, 'car_basic', id, key());
    expect((await cars.repair(w.ctx, p.characterId, id, key(), null)).insurerPaid).toBe(0);      // waiting period
    await w.ctx.pool.query('UPDATE cars SET condition=50 WHERE id=$1', [id]); advance(13 * HOUR);
    const r = await cars.repair(w.ctx, p.characterId, id, key(), null);
    expect(r).toMatchObject({ fee: 150, insurerPaid: 105, youPaid: 45 });
    await w.ctx.pool.query('UPDATE cars SET condition=50 WHERE id=$1', [id]);
    const s = await cars.sell(w.ctx, p.characterId, id, key()) as any;
    expect(s.value).toBe(Math.round(8000 * (0.5 + 0.35 * 0.5)));
    expect((await w.ctx.pool.query(`SELECT status FROM policies WHERE car_id=$1`, [id])).rows[0].status).toBe('cancelled');
    expect((await verifyLedgerIntegrity(w.ctx.pool as any)).ok).toBe(true);
  });

  it('driving is faster than walking, burns fuel and wear on the server, stops when empty, and crashes can happen', async () => {
    const p = await w.newPlayer('Speedy Segun'); await give(p, 20000); await licence(p);
    const car = (await cars.buy(w.ctx, p.characterId, 'hatch', key()) as any).car;
    const c = await join(p); const world = w.ctx.data.worlds.get('lagos')!;
    const place = () => { me(p).x = 0; me(p).z = world.rowZ[0]; me(p).input = { dx: 0, dz: 0, run: false }; };
    const run = (n: number) => { for (let i = 0; i < n; i++) { me(p).input = { dx: 1, dz: 0, run: false }; me(p).lastInputAt = Date.now(); gw.step(0.05); } };
    place(); run(60); const walked = me(p).x;
    place(); c.send({ t: 'drive', on: true }); await c.until(() => c.of('ride').some((m) => m.on));
    run(60); const driven = me(p).x;
    expect(driven).toBeGreaterThan(walked * 2.3);                                       // about 2.8 times faster
    gw.rng = () => 0.99;                                                                 // no crash this time
    run(200); await new Promise((r) => setTimeout(r, 50));
    const rtc = me(p).ride!.car!; expect(rtc.fuel).toBeLessThan(30); expect(rtc.cond).toBeLessThan(100);
    // forced crash
    gw.rng = () => 0; rtc.incKm = 0.24; const condBefore = rtc.cond; run(60);
    await c.until(() => c.of('toast').some((m) => /hit something/i.test(m.text))); expect(rtc.cond).toBeLessThan(condBefore - 10);
    // run dry: stops, and the wear is saved
    rtc.fuel = 0.001; gw.rng = () => 0.99; run(80);
    expect(me(p).ride).toBeNull(); await c.until(() => c.of('toast').some((m) => /out of fuel/i.test(m.text)));
    await new Promise((r) => setTimeout(r, 100));
    const row = (await w.ctx.pool.query('SELECT fuel, condition FROM cars WHERE id=$1', [car.id])).rows[0];
    expect(Number(row.fuel)).toBeLessThan(0.1); expect(Number(row.condition)).toBeLessThan(90);
    c.send({ t: 'drive', on: true }); await c.until(() => c.of('error').length > 0 || c.of('toast').some((m) => /empty/i.test(m.text)) || c.of('app').length >= 0).catch(() => {});
    expect(me(p).ride).toBeNull();
    c.close();
  });
});

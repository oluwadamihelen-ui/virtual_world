import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, type TestWorld } from './helpers.js';
import { verifyLedgerIntegrity } from '../src/modules/economy/ledger.js';

let w: TestWorld;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });
const adv = (sec: number) => { w.clock.t = new Date(w.clock.t.getTime() + sec * 1000); };
const J = 'job_grocery_assistant';

async function fullShift(cid: string) {
  const s = await w.gameReq('POST', `/v1/game/characters/${cid}/shifts`, { jobId: J });
  if (s.status !== 200) return s;
  for (let i = 0; i < s.body.tasksRequired; i++) {
    adv(21);
    const t = await w.gameReq('POST', `/v1/game/characters/${cid}/shifts/${s.body.shiftId}/task`);
    expect(t.status).toBe(200);
  }
  return w.gameReq('POST', `/v1/game/characters/${cid}/shifts/${s.body.shiftId}/complete`);
}

describe('jobs', () => {
  it('a completed shift pays the configured wage and grants skill XP', async () => {
    const p = await w.newPlayer();
    const r = await fullShift(p.characterId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ wage: 250, balance: 2250 });
    const s = (await w.gameReq('GET', `/v1/game/characters/${p.characterId}/summary`)).body;
    expect(s.skills).toEqual([{ skillId: 'retail', xp: 10 }]);
    const hist = (await w.gameReq('GET', `/v1/game/characters/${p.characterId}/employment-history`)).body.shifts;
    expect(hist[0]).toMatchObject({ status: 'completed', wage: 250 });
  });

  it('cannot claim a wage without doing the work', async () => {
    const p = await w.newPlayer();
    const s = await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shifts`, { jobId: J });
    const c = await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shifts/${s.body.shiftId}/complete`);
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('shift_incomplete');
    expect((await w.gameReq('GET', `/v1/game/characters/${p.characterId}/summary`)).body.balance).toBe(2000);
  });

  it('tasks cannot be completed faster than the configured pace', async () => {
    const p = await w.newPlayer();
    const s = await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shifts`, { jobId: J });
    const url = `/v1/game/characters/${p.characterId}/shifts/${s.body.shiftId}/task`;
    expect((await w.gameReq('POST', url)).status).toBe(409); // 0s elapsed
    adv(21);
    expect((await w.gameReq('POST', url)).status).toBe(200);
    expect((await w.gameReq('POST', url)).status).toBe(409); // immediately again
  });

  it('completing a shift twice (retry / replay) pays exactly once', async () => {
    const p = await w.newPlayer();
    const s = await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shifts`, { jobId: J });
    for (let i = 0; i < 5; i++) { adv(21); await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shifts/${s.body.shiftId}/task`); }
    const url = `/v1/game/characters/${p.characterId}/shifts/${s.body.shiftId}/complete`;
    const results = await Promise.all(Array.from({ length: 10 }, () => w.gameReq('POST', url)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await w.gameReq('GET', `/v1/game/characters/${p.characterId}/summary`)).body.balance).toBe(2250);
    expect(await verifyLedgerIntegrity(w.ctx.pool)).toMatchObject({ ok: true });
  });

  it('cannot run two shifts at once, and the daily shift limit prevents endless grinding', async () => {
    const p = await w.newPlayer();
    const s = await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shifts`, { jobId: J });
    expect((await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shifts`, { jobId: J })).body.error).toBe('shift_in_progress');
    await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shifts/${s.body.shiftId}/abandon`);
    for (let i = 0; i < 4; i++) expect((await fullShift(p.characterId)).status).toBe(200);
    const fifth = await w.gameReq('POST', `/v1/game/characters/${p.characterId}/shifts`, { jobId: J });
    expect(fifth.status).toBe(409);
    expect(fifth.body.error).toBe('shift_limit_reached');
    adv(25 * 3600);
    expect((await fullShift(p.characterId)).status).toBe(200);
    expect((await w.gameReq('GET', `/v1/game/characters/${p.characterId}/summary`)).body.balance).toBe(2000 + 5 * 250);
  });

  it('players cannot complete someone else\'s shift', async () => {
    const a = await w.newPlayer(); const b = await w.newPlayer();
    const s = await w.gameReq('POST', `/v1/game/characters/${a.characterId}/shifts`, { jobId: J });
    adv(21);
    expect((await w.gameReq('POST', `/v1/game/characters/${b.characterId}/shifts/${s.body.shiftId}/task`)).status).toBe(404);
  });
});

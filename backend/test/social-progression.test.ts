import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, key, type TestWorld } from './helpers.js';
import { maskBlockedWords } from '../src/modules/social/social.js';

let w: TestWorld;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });
const G = '/v1/game';
const summary = async (cid: string) => (await w.gameReq('GET', `${G}/characters/${cid}/summary`)).body;
const chat = (cid: string, text: string) => w.gameReq('POST', `${G}/chat/check`, { characterId: cid, text });

describe('blocking', () => {
  it('block is two-way for delivery purposes, listable, reversible, and not self-applicable', async () => {
    const a = await w.newPlayer('Alpha One'); const b = await w.newPlayer('Beta Two');
    expect((await w.gameReq('GET', `${G}/social/blocked/${a.characterId}/${b.characterId}`)).body.blocked).toBe(false);
    expect((await w.gameReq('POST', `${G}/characters/${a.characterId}/blocks`, { targetCharacterId: b.characterId })).status).toBe(200);
    expect((await w.gameReq('POST', `${G}/characters/${a.characterId}/blocks`, { targetCharacterId: b.characterId })).status).toBe(200); // idempotent
    expect((await w.gameReq('GET', `${G}/social/blocked/${b.characterId}/${a.characterId}`)).body.blocked).toBe(true);
    expect((await w.gameReq('GET', `${G}/characters/${a.characterId}/blocks`)).body.blocked).toEqual([{ characterId: b.characterId, displayName: 'Beta Two' }]);
    expect((await w.gameReq('POST', `${G}/characters/${a.characterId}/blocks`, { targetCharacterId: a.characterId })).status).toBe(400);
    await w.gameReq('DELETE', `${G}/characters/${a.characterId}/blocks/${b.characterId}`);
    expect((await w.gameReq('GET', `${G}/social/blocked/${a.characterId}/${b.characterId}`)).body.blocked).toBe(false);
  });
});

describe('chat checks', () => {
  it('masks blocked words, strips control characters, enforces length', async () => {
    const p = await w.newPlayer();
    const r = await chat(p.characterId, 'you are a Stupid   IDIOT\u0007!');
    expect(r.body).toMatchObject({ allowed: true, filtered: true, text: 'you are a ******   *****!' });
    expect((await chat(p.characterId, 'x'.repeat(201))).body).toMatchObject({ allowed: false, reason: 'too_long' });
    expect((await chat(p.characterId, '   ')).body).toMatchObject({ allowed: false, reason: 'empty' });
    expect(maskBlockedWords('a.b (c)', ['a.b']).text).toBe('*** (c)'); // regex metacharacters in the list are treated literally
  });

  it('rate limits spam per character', async () => {
    const p = await w.newPlayer();
    const results = [];
    for (let i = 0; i < 10; i++) results.push((await chat(p.characterId, 'hello ' + i)).body);
    expect(results.filter((r) => r.allowed)).toHaveLength(8);
    expect(results[9]).toMatchObject({ allowed: false, reason: 'rate_limited' });
    w.clock.t = new Date(w.clock.t.getTime() + 11_000);
    expect((await chat(p.characterId, 'hello again')).body.allowed).toBe(true);
  });

  it('a moderator mute silences chat but not gameplay; it expires and can be lifted', async () => {
    const bad = await w.newPlayer('Spammer'); const victim = await w.newPlayer('Target Person');
    const m = await w.newPlayer('Mod Mute'); const tok = await w.setRole(m.accountId, 'moderator');
    const rep = await w.playerReq(victim.token, 'POST', '/v1/reports', { reporterCharacterId: victim.characterId, targetCharacterId: bad.characterId, category: 'harassment' });
    expect((await w.playerReq(tok, 'POST', `/v1/mod/reports/${rep.body.reportId}/resolve`, { action: 'mute', hours: 2, note: 'spamming chat' })).status).toBe(200);
    expect((await chat(bad.characterId, 'hi')).body).toMatchObject({ allowed: false, reason: 'muted' });
    expect((await w.gameReq('POST', `${G}/characters/${bad.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'sandwich', quantity: 1, idempotencyKey: key() })).status).toBe(200);
    w.clock.t = new Date(w.clock.t.getTime() + 3 * 3600_000);
    expect((await chat(bad.characterId, 'sorry')).body.allowed).toBe(true);
    const rep2 = await w.playerReq(victim.token, 'POST', '/v1/reports', { reporterCharacterId: victim.characterId, targetCharacterId: bad.characterId, category: 'other' });
    await w.playerReq(tok, 'POST', `/v1/mod/reports/${rep2.body.reportId}/resolve`, { action: 'mute', hours: 24, note: 'again' });
    await w.playerReq(tok, 'POST', `/v1/mod/characters/${bad.characterId}/lift-sanction`, { note: 'appeal granted' });
    expect((await chat(bad.characterId, 'thanks')).body.allowed).toBe(true);
  });

  it('suspended players cannot chat', async () => {
    const p = await w.newPlayer();
    await w.ctx.pool.query(`UPDATE accounts SET status='suspended', suspended_until=$2 WHERE id=$1`, [p.accountId, new Date(w.clock.t.getTime() + 3600_000)]);
    expect((await chat(p.characterId, 'hi')).status).toBe(403);
  });
});

describe('progression', () => {
  const J = 'job_grocery_assistant';
  async function shift(cid: string, job = J) {
    const s = await w.gameReq('POST', `${G}/characters/${cid}/shifts`, { jobId: job });
    if (s.status !== 200) return s;
    for (let i = 0; i < s.body.tasksRequired; i++) {
      w.clock.t = new Date(w.clock.t.getTime() + 61_000);
      await w.gameReq('POST', `${G}/characters/${cid}/shifts/${s.body.shiftId}/task`);
    }
    return w.gameReq('POST', `${G}/characters/${cid}/shifts/${s.body.shiftId}/complete`);
  }

  it('achievements are awarded once and grant reputation; reputation unlocks a better job', async () => {
    const p = await w.newPlayer();
    expect((await w.gameReq('POST', `${G}/characters/${p.characterId}/shifts`, { jobId: 'job_office_assistant' })).body.error).toBe('requirements_not_met');
    expect((await shift(p.characterId)).status).toBe(200);
    expect((await shift(p.characterId)).status).toBe(200); // second shift: no second award
    const s = await summary(p.characterId);
    expect(s.achievements.map((a: any) => a.achievementId)).toEqual(['first_shift']);
    expect(s.reputation).toBe(1);
    const office = await shift(p.characterId, 'job_office_assistant');
    expect(office.status).toBe(200);
    expect(office.body.wage).toBe(340);
    expect((await summary(p.characterId)).skills.map((k: any) => k.skillId).sort()).toEqual(['admin', 'retail']);
  });

  it('home and purchase achievements; each only once', async () => {
    const p = await w.newPlayer();
    await w.gameReq('POST', `${G}/characters/${p.characterId}/rent`, { propertyId: 'prop_resi_room_101', idempotencyKey: key() });
    await w.gameReq('POST', `${G}/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'sandwich', quantity: 1, idempotencyKey: key() });
    await w.gameReq('POST', `${G}/characters/${p.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'sandwich', quantity: 1, idempotencyKey: key() });
    const s = await summary(p.characterId);
    expect(s.achievements.map((a: any) => a.achievementId).sort()).toEqual(['first_home', 'first_purchase']);
    expect(s.reputation).toBe(1);
  });

  it('new jobs pay their configured wages', async () => {
    const p = await w.newPlayer();
    expect((await shift(p.characterId, 'job_cafe_barista')).body.wage).toBe(260);
    expect((await shift(p.characterId, 'job_courier')).body.wage).toBe(300);
  });
});

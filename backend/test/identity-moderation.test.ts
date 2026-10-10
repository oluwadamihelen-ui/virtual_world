import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, key, type TestWorld } from './helpers.js';
import { nameKey } from '../src/modules/identity/names.js';

let w: TestWorld;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });

const appearance = { bodyPreset: 'body_b', skinTone: 3, hairstyle: 'curly', hairColor: 'black', outfit: 'casual_2' };
const mkChar = (token: string, displayName: string, ap: object = appearance) => w.playerReq(token, 'POST', '/v1/characters', { displayName, appearance: ap });

describe('identity', () => {
  it('registers, logs in, rejects bad credentials, never reveals which emails exist', async () => {
    const p = await w.newPlayer('Alice Walker', 'alice@example.com');
    expect(p.token).toBeTruthy();
    const bad = await w.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'alice@example.com', password: 'wrong password!!' } });
    const none = await w.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'nobody@example.com', password: 'wrong password!!' } });
    expect(bad.statusCode).toBe(401); expect(none.statusCode).toBe(401);
    expect(bad.body).toBe(none.body);
    const dup = await w.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'ALICE@example.com', password: 'another long password' } });
    expect(dup.statusCode).toBe(409);
    const weak = await w.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'x@example.com', password: 'short' } });
    expect(weak.statusCode).toBe(400);
  });

  it('stores only a salted hash, never the password', async () => {
    await w.newPlayer();
    const row = (await w.ctx.pool.query('SELECT password_hash FROM accounts')).rows[0];
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain('correct horse');
  });

  it('enforces display-name rules: unique (case/lookalike-insensitive), reserved, charset, length', async () => {
    const p = await w.newPlayer('Original Name');
    const p2 = await w.newPlayer();
    expect((await mkChar(p2.token, 'original name')).status).toBe(409);
    expect((await mkChar(p2.token, '0riginal N4me')).status).toBe(409); // lookalike impersonation
    expect((await mkChar(p2.token, 'Admin')).status).toBe(409);
    expect((await mkChar(p2.token, 'Ad min')).status).toBe(409);
    expect((await mkChar(p2.token, '4dm1n')).status).toBe(409);
    expect((await mkChar(p2.token, 'ab')).status).toBe(400);
    expect((await mkChar(p2.token, 'x'.repeat(21))).status).toBe(400);
    expect((await mkChar(p2.token, 'bad<script>')).status).toBe(400);
    expect((await mkChar(p2.token, 'Fresh Name')).status).toBe(201);
    void p;
    expect(nameKey('Ad-min')).toBe('admin');
  });

  it('names that differ only by digits without letter lookalikes are distinct', async () => {
    const a = await w.newPlayer(); const b = await w.newPlayer();
    expect((await mkChar(a.token, 'Player 2')).status).toBe(201);
    expect((await mkChar(b.token, 'Player 6')).status).toBe(201);
    expect((await mkChar(b.token, 'player2')).status).toBe(409); // same name, different spacing/case
    expect(nameKey('Player 2')).not.toBe(nameKey('Player 6'));
  });

  it('validates appearance against the allowed catalogue', async () => {
    const p = await w.newPlayer();
    expect((await mkChar(p.token, 'Somebody', { ...appearance, hairstyle: 'mohawk_9000' })).status).toBe(400);
    expect((await mkChar(p.token, 'Somebody', { ...appearance, skinTone: 99 })).status).toBe(400);
  });

  it('keeps account identity separate from characters (one account can own several)', async () => {
    const p = await w.newPlayer('First Char');
    expect((await mkChar(p.token, 'Second Char')).status).toBe(201);
    expect((await w.playerReq(p.token, 'GET', '/v1/characters')).body.characters).toHaveLength(2);
  });
});

describe('moderation & admin', () => {
  it('player reports -> moderator reviews -> suspension blocks gameplay -> lifting restores it; all audited', async () => {
    const bad = await w.newPlayer('Troublemaker'); const victim = await w.newPlayer('Victim One');
    const modP = await w.newPlayer('Mod Person'); const modTok = await w.setRole(modP.accountId, 'moderator');

    const rep = await w.playerReq(victim.token, 'POST', '/v1/reports', { reporterCharacterId: victim.characterId, targetCharacterId: bad.characterId, category: 'harassment', detail: 'spam in chat' });
    expect(rep.status).toBe(201);
    // players cannot see the moderation queue
    expect((await w.playerReq(victim.token, 'GET', '/v1/mod/reports')).status).toBe(403);
    // players cannot report as someone else's character
    expect((await w.playerReq(victim.token, 'POST', '/v1/reports', { reporterCharacterId: bad.characterId, targetCharacterId: victim.characterId, category: 'other' })).status).toBe(404);

    const q = await w.playerReq(modTok, 'GET', '/v1/mod/reports');
    expect(q.body.reports).toHaveLength(1);
    expect(q.body.reports[0]).toMatchObject({ reporter: 'Victim One', target: 'Troublemaker', category: 'harassment' });

    const res = await w.playerReq(modTok, 'POST', `/v1/mod/reports/${rep.body.reportId}/resolve`, { action: 'suspend', hours: 24, note: 'chat harassment, 24h' });
    expect(res.status).toBe(200);
    expect((await w.playerReq(modTok, 'POST', `/v1/mod/reports/${rep.body.reportId}/resolve`, { action: 'dismiss' })).status).toBe(400); // already resolved

    const buy = () => w.gameReq('POST', `/v1/game/characters/${bad.characterId}/shops/shop_corner_grocery/purchase`, { itemId: 'sandwich', quantity: 1, idempotencyKey: key() });
    const blocked = await buy();
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('account_suspended');

    // suspension expires on its own
    w.clock.t = new Date(w.clock.t.getTime() + 25 * 3600_000);
    expect((await buy()).status).toBe(200);

    // moderator cannot ban; only admins can
    const rep2 = await w.playerReq(victim.token, 'POST', '/v1/reports', { reporterCharacterId: victim.characterId, targetCharacterId: bad.characterId, category: 'scam' });
    expect((await w.playerReq(modTok, 'POST', `/v1/mod/reports/${rep2.body.reportId}/resolve`, { action: 'ban', note: 'repeat offender' })).status).toBe(403);

    const adminP = await w.newPlayer('Admin Person'); const adminTok = await w.setRole(adminP.accountId, 'admin');
    const audit = (await w.playerReq(adminTok, 'GET', '/v1/admin/audit')).body.entries;
    expect(audit.some((e: any) => e.action === 'report.suspend' && e.actor_account_id === modP.accountId)).toBe(true);
  });

  it('banned accounts cannot log in or act', async () => {
    const bad = await w.newPlayer('Banned Guy'); const victim = await w.newPlayer('Victim Two');
    const adminP = await w.newPlayer('Boss Admin'); const adminTok = await w.setRole(adminP.accountId, 'admin');
    const rep = await w.playerReq(victim.token, 'POST', '/v1/reports', { reporterCharacterId: victim.characterId, targetCharacterId: bad.characterId, category: 'cheating' });
    expect((await w.playerReq(adminTok, 'POST', `/v1/mod/reports/${rep.body.reportId}/resolve`, { action: 'ban', note: 'cheating confirmed' })).status).toBe(200);
    const login = await w.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: (await w.ctx.pool.query('SELECT email FROM accounts WHERE id=$1', [bad.accountId])).rows[0].email, password: 'correct horse battery' } });
    expect(login.statusCode).toBe(403);
    expect((await w.gameReq('POST', `/v1/game/characters/${bad.characterId}/join`)).status).toBe(403);
  });

  it('admin balance adjustments require a reason, are idempotent, ledgered and audited', async () => {
    const p = await w.newPlayer(); const adminP = await w.newPlayer('Admin Dude'); const tok = await w.setRole(adminP.accountId, 'admin');
    const k = key();
    const body = { characterId: p.characterId, delta: 300, reason: 'compensation for lost item bug #12', idempotencyKey: k };
    expect((await w.playerReq(tok, 'POST', '/v1/admin/adjustments', { ...body, reason: 'x' })).status).toBe(400);
    const a = await w.playerReq(tok, 'POST', '/v1/admin/adjustments', body);
    const b = await w.playerReq(tok, 'POST', '/v1/admin/adjustments', body);
    expect(a.body.balance).toBe(2300); expect(b.body.replayed).toBe(true);
    expect((await w.gameReq('GET', `/v1/game/characters/${p.characterId}/summary`)).body.balance).toBe(2300);
    const audit = (await w.playerReq(tok, 'GET', '/v1/admin/audit')).body.entries.filter((e: any) => e.action === 'admin.adjust_balance');
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toMatchObject({ delta: 300 });
    // cannot push a wallet negative
    expect((await w.playerReq(tok, 'POST', '/v1/admin/adjustments', { ...body, delta: -999999, idempotencyKey: key() })).status).toBe(402);
    const integ = await w.playerReq(tok, 'GET', '/v1/admin/ledger-integrity');
    expect(integ.body.ok).toBe(true);
  });
});

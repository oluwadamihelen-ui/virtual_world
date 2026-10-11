import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { createWorld, key, type TestWorld } from './helpers.js';
import { Gateway } from '../src/realtime/gateway.js';

let w: TestWorld; let gw: Gateway; let port: number;
beforeEach(async () => {
  w = await createWorld();
  gw = new Gateway(w.ctx);
  gw.attach(w.app.server);
  await w.app.listen({ port: 0, host: '127.0.0.1' });
  port = (w.app.server.address() as AddressInfo).port;
});
afterEach(async () => { await gw.close(); await w.close(); });

class Client {
  msgs: any[] = []; closed: number | null = null; ws!: WebSocket;
  static async open(url: string, headers: Record<string, string> = {}): Promise<Client | { status: number }> {
    const c = new Client();
    return new Promise((resolve) => {
      c.ws = new WebSocket(url, { headers });
      c.ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
      c.ws.on('close', (code) => { c.closed = code; });
      c.ws.on('open', () => resolve(c));
      c.ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
      c.ws.on('error', () => {});
    });
  }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  of(t: string) { return this.msgs.filter((m) => m.t === t); }
  async until(fn: () => boolean, ms = 2000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout; got: ' + JSON.stringify(this.msgs.map((m) => m.t))); await new Promise((r) => setTimeout(r, 10)); } }
  last(t: string) { return this.of(t).at(-1); }
  close() { this.ws.close(); }
}

async function join(p: { token: string; characterId: string }): Promise<Client> {
  const t = (await w.playerReq(p.token, 'POST', `/v1/characters/${p.characterId}/join-ticket`)).body.ticket;
  const c = await Client.open(`ws://127.0.0.1:${port}/ws?ticket=${t}`);
  if (!(c instanceof Client)) throw new Error('rejected ' + JSON.stringify(c));
  await c.until(() => c.of('welcome').length > 0);
  return c;
}
const me = (p: { characterId: string }) => gw.players.get(p.characterId)!;
const steps = (n: number, dt = 0.05) => { for (let i = 0; i < n; i++) gw.step(dt); };
const summary = async (p: { characterId: string }) => (await w.gameReq('GET', `/v1/game/characters/${p.characterId}/summary`)).body;

describe('connection & identity', () => {
  it('a valid ticket joins and receives the world, summary and door state', async () => {
    const p = await w.newPlayer('Walker One'); const c = await join(p);
    const wel = c.last('welcome');
    expect(wel.you).toMatchObject({ id: p.characterId, name: 'Walker One' });
    expect(wel.summary.balance).toBe(2000);
    expect(wel.world.zones.map((z: any) => z.id)).toContain('lagos:apt_door');
    expect(wel.door.state).toBe('free');
    c.close();
  });

  it('tickets are single use; no ticket, bad ticket and cross-site origins are refused', async () => {
    const p = await w.newPlayer();
    const t = (await w.playerReq(p.token, 'POST', `/v1/characters/${p.characterId}/join-ticket`)).body.ticket;
    const first = await Client.open(`ws://127.0.0.1:${port}/ws?ticket=${t}`);
    expect(first).toBeInstanceOf(Client);
    expect(await Client.open(`ws://127.0.0.1:${port}/ws?ticket=${t}`)).toEqual({ status: 401 });
    expect(await Client.open(`ws://127.0.0.1:${port}/ws`)).toEqual({ status: 401 });
    expect(await Client.open(`ws://127.0.0.1:${port}/ws?ticket=abc.def.ghi`)).toEqual({ status: 401 });
    const t2 = (await w.playerReq(p.token, 'POST', `/v1/characters/${p.characterId}/join-ticket`)).body.ticket;
    expect(await Client.open(`ws://127.0.0.1:${port}/ws?ticket=${t2}`, { Origin: 'http://evil.example' })).toEqual({ status: 403 });
    (first as Client).close();
  });

  it('logging in again from elsewhere replaces the old session', async () => {
    const p = await w.newPlayer(); const a = await join(p); const b = await join(p);
    await a.until(() => a.closed !== null);
    expect(a.closed).toBe(4000);
    expect(gw.players.size).toBe(1);
    b.close();
  });

  it('floods and malformed messages are cut off', async () => {
    const p = await w.newPlayer(); const c = await join(p);
    for (let i = 0; i < 400; i++) c.send({ t: 'ping' });
    await c.until(() => c.closed !== null);
    expect(c.closed).toBe(4008);
    const q = await w.newPlayer(); const d = await join(q);
    for (let i = 0; i < 25; i++) d.send({ t: 'nonsense' });
    await d.until(() => d.closed !== null);
    expect(d.closed).toBe(4009);
  });
});

describe('authoritative movement', () => {
  it('moves by direction at the fixed speed; huge inputs are rejected and cannot speed-hack', async () => {
    const p = await w.newPlayer(); const c = await join(p);
    const x0 = me(p).x;
    c.send({ t: 'input', seq: 1, dx: 1, dz: 0, run: true });
    await c.until(() => me(p).input.dx === 1);
    steps(20); // 1 second
    expect(me(p).x - x0).toBeCloseTo(6.5, 1);
    c.send({ t: 'input', seq: 2, dx: 1000, dz: 0, run: true }); // out of range -> ignored by validation
    await new Promise((r) => setTimeout(r, 100));
    expect(me(p).input.dx).toBe(1);
    c.send({ t: 'input', seq: 3, dx: 0.7, dz: 0.7 });
    await c.until(() => me(p).input.dx === 0.7);
    const before = { x: me(p).x, z: me(p).z };
    steps(20);
    expect(Math.hypot(me(p).x - before.x, me(p).z - before.z)).toBeCloseTo(4.0, 1); // diagonal is normalised: no faster
    c.close();
  });

  it('walls are solid and the apartment door is locked until you rent', async () => {
    const p = await w.newPlayer(); const c = await join(p);
    me(p).x = -8; me(p).z = -6.5;                              // just outside the apartment door
    c.send({ t: 'input', seq: 1, dx: 0, dz: -1 });
    await c.until(() => me(p).input.dz === -1);
    steps(60);
    expect(me(p).z).toBeGreaterThan(-8.5);                     // stopped at the locked doorway
    me(p).x = -13; me(p).z = -6.5;                             // beside the door, facing plain wall
    steps(60);
    expect(me(p).z).toBeGreaterThan(-8.6);                     // wall holds
    c.close();
  });

  it('after renting, the tenant can walk through the door (and nobody else can)', async () => {
    const tenant = await w.newPlayer('Tenant Tim'); const other = await w.newPlayer('Other Olly');
    const ct = await join(tenant); const co = await join(other);
    me(tenant).x = -8; me(tenant).z = -7;
    ct.send({ t: 'interact', zone: 'lagos:apt_door' });
    await ct.until(() => ct.of('toast').some((m) => /rented/.test(m.text)));
    expect((await summary(tenant)).tenancy).not.toBeNull();
    expect((await summary(tenant)).balance).toBe(1500);
    for (const [pl, c] of [[tenant, ct], [other, co]] as const) {
      me(pl).x = -8; me(pl).z = -6.5; c.send({ t: 'input', seq: 1, dx: 0, dz: -1 }); await c.until(() => me(pl).input.dz === -1);
    }
    steps(60);
    expect(me(tenant).z).toBeLessThan(-10);                    // inside
    expect(me(other).z).toBeGreaterThan(-8.5);                 // still outside
    ct.close(); co.close();
  });
});

describe('server-validated interactions', () => {
  it('refuses to trade from far away; sells at the counter; the backend charges the right price', async () => {
    const p = await w.newPlayer(); const c = await join(p);
    c.send({ t: 'interact', zone: 'lagos:grocery_counter', item: 'sandwich' });
    await c.until(() => c.of('toast').length > 0);
    expect(c.last('toast')).toMatchObject({ kind: 'error' });
    expect((await summary(p)).balance).toBe(2000);
    me(p).x = 10; me(p).z = 14.9;
    await new Promise((r) => setTimeout(r, 300));              // the server throttles interactions to one per 250 ms
    c.send({ t: 'interact', zone: 'lagos:grocery_counter', item: 'sandwich' });
    await c.until(() => c.of('summary').length > 0);
    expect(c.last('summary').summary.balance).toBe(1975);
    expect(c.last('summary').summary.inventory).toEqual([{ itemId: 'sandwich', quantity: 1 }]);
    await new Promise((r) => setTimeout(r, 300));
    c.send({ t: 'interact', zone: 'lagos:grocery_counter', item: 'diamond' }); // not on the menu
    await c.until(() => c.of('toast').some((m) => /sell/.test(m.text)));
    c.close();
  });

  it('runs a whole shift through the work station and pays the wage; pacing is still enforced by the backend', async () => {
    const p = await w.newPlayer(); const c = await join(p);
    me(p).x = 15.2; me(p).z = 14.9;
    const act = async () => { const n = c.of('summary').length; c.send({ t: 'interact', zone: 'lagos:grocery_work' }); await c.until(() => c.of('summary').length > n); };
    await act();                                   // start
    expect(c.last('summary').summary.activeShift).not.toBeNull();
    await new Promise((r) => setTimeout(r, 300));
    c.send({ t: 'interact', zone: 'lagos:grocery_work' });
    await c.until(() => c.of('toast').some((m) => m.kind === 'error' && /remaining|yet/i.test(m.text)));  // too fast
    for (let i = 0; i < 5; i++) {                  // use the injected clock to jump 21s between tasks
      w.clock.t = new Date(w.clock.t.getTime() + 21_000); await new Promise((r) => setTimeout(r, 300)); await act();
    }
    expect((await summary(p)).balance).toBe(2250);
    c.close();
  });

  it('the door interaction needs you to be at the door', async () => {
    const p = await w.newPlayer(); const c = await join(p);
    c.send({ t: 'interact', zone: 'lagos:apt_door' });
    await c.until(() => c.of('toast').length > 0);
    expect(c.last('toast').kind).toBe('error');
    expect((await summary(p)).tenancy).toBeNull();
    c.close();
  });

  it('a suspended player cannot act', async () => {
    const p = await w.newPlayer(); const c = await join(p);
    me(p).x = 10; me(p).z = 14.9;
    await w.ctx.pool.query(`UPDATE accounts SET status='suspended', suspended_until=$2 WHERE id=$1`, [p.accountId, new Date(w.clock.t.getTime() + 3600_000)]);
    c.send({ t: 'interact', zone: 'lagos:grocery_counter', item: 'sandwich' });
    await c.until(() => c.of('toast').length > 0);
    expect(c.last('toast').kind).toBe('error');
    expect((await summary(p)).balance).toBe(2000);
    c.close();
  });
});

describe('social: proximity chat, emotes, blocking, reports', () => {
  it('chat reaches only nearby players, is filtered, and respects blocks and mutes', async () => {
    const [a, b, far, blocker] = [await w.newPlayer('Alice A'), await w.newPlayer('Bobby B'), await w.newPlayer('Far Away'), await w.newPlayer('Blocky Bee')];
    const [ca, cb, cf, cx] = [await join(a), await join(b), await join(far), await join(blocker)];
    for (const p of [a, b, blocker]) { me(p).x = -20; me(p).z = 0; }
    me(far).x = 20; me(far).z = 0;
    await w.gameReq('POST', `/v1/game/characters/${blocker.characterId}/blocks`, { targetCharacterId: a.characterId });
    ca.send({ t: 'chat', text: 'hello you stupid people' });
    await cb.until(() => cb.of('chat').length > 0);
    await ca.until(() => ca.of('chat').length > 0);           // sender sees own line
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.last('chat')).toMatchObject({ name: 'Alice A', text: 'hello you ****** people' });
    expect(cf.of('chat')).toHaveLength(0);                    // too far
    expect(cx.of('chat')).toHaveLength(0);                    // blocked her
    // moderator mute silences chat
    await w.ctx.pool.query(`UPDATE accounts SET muted_until=$2 WHERE id=$1`, [a.accountId, new Date(w.clock.t.getTime() + 3600_000)]);
    ca.send({ t: 'chat', text: 'still here?' });
    await ca.until(() => ca.of('toast').some((m) => /muted/i.test(m.text)));
    await new Promise((r) => setTimeout(r, 100));
    expect(cb.of('chat')).toHaveLength(1);
    for (const c of [ca, cb, cf, cx]) c.close();
  });

  it('emotes are broadcast to nearby players only and rate limited; unknown emotes are ignored', async () => {
    const a = await w.newPlayer(); const b = await w.newPlayer(); const f = await w.newPlayer();
    const [ca, cb, cf] = [await join(a), await join(b), await join(f)];
    for (const p of [a, b]) { me(p).x = -20; me(p).z = 0; } me(f).x = 25; me(f).z = 0;
    ca.send({ t: 'emote', e: 'wave' }); ca.send({ t: 'emote', e: 'dance' }); ca.send({ t: 'emote', e: 'hackz' });
    await cb.until(() => cb.of('emote').length > 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(cb.of('emote').map((m) => m.e)).toEqual(['wave']);   // second one rate limited, third unknown
    expect(cf.of('emote')).toHaveLength(0);
    for (const c of [ca, cb, cf]) c.close();
  });

  it('players can report and block through the game connection', async () => {
    const a = await w.newPlayer(); const b = await w.newPlayer(); const ca = await join(a);
    ca.send({ t: 'report', targetId: b.characterId, category: 'harassment', detail: 'rude' });
    await ca.until(() => ca.of('toast').some((m) => /Report sent/.test(m.text)));
    expect((await w.ctx.pool.query('SELECT count(*)::int n FROM reports')).rows[0].n).toBe(1);
    ca.send({ t: 'block', targetId: b.characterId });
    await ca.until(() => ca.of('toast').some((m) => /blocked/i.test(m.text)));
    expect((await w.gameReq('GET', `/v1/game/social/blocked/${a.characterId}/${b.characterId}`)).body.blocked).toBe(true);
    ca.close();
  });
});

describe('world replication & persistence', () => {
  it('players see each other nearby (and NPC residents) but not distant ones; positions persist across reconnects', async () => {
    const a = await w.newPlayer('Seer Sam'); const b = await w.newPlayer('Seen Bea'); const f = await w.newPlayer('Faraway Fred');
    const [ca, cb, cf] = [await join(a), await join(b), await join(f)];
    me(a).x = -20; me(a).z = 0; me(b).x = -18; me(b).z = 0; me(f).x = 200; me(f).z = 0;   // 'far' is outside the interest radius
    steps(4);
    await ca.until(() => ca.of('snap').some((s) => s.spawns.some((x: any) => x.id === b.characterId)));
    const spawn = ca.of('snap').flatMap((s) => s.spawns).find((x: any) => x.id === b.characterId);
    expect(spawn).toMatchObject({ name: 'Seen Bea', npc: false });
    expect(ca.of('snap').flatMap((s) => s.spawns).some((x: any) => x.npc === true && x.name === null)).toBe(true);
    expect(ca.of('snap').flatMap((s) => s.spawns).some((x: any) => x.id === f.characterId)).toBe(false);
    expect(ca.last('snap').online).toBe(3);
    // movement is visible to others
    cb.send({ t: 'input', seq: 1, dx: 0, dz: 1 }); await cb.until(() => me(b).input.dz === 1); steps(10);
    await ca.until(() => (ca.last('snap').ps.find((q: any[]) => q[0] === b.characterId)?.[2] ?? 0) > 0.5);
    // position is saved on disconnect and restored on the next login
    const pos = { x: me(a).x, z: me(a).z };
    ca.close(); await new Promise((r) => setTimeout(r, 200));
    const again = await join(a);
    expect(again.last('welcome').you.x).toBeCloseTo(pos.x, 1);
    expect(again.last('welcome').you.z).toBeCloseTo(pos.z, 1);
    for (const c of [again, cb, cf]) c.close();
  });

  it('phone data (wallet, jobs, achievements) comes from the backend, and "home" only works for tenants', async () => {
    const p = await w.newPlayer(); const c = await join(p);
    c.send({ t: 'phone', tab: 'wallet' }); await c.until(() => c.of('phone').length > 0);
    expect(c.last('phone').data[0]).toMatchObject({ type: 'starting_grant', delta: 2000 });
    c.send({ t: 'phone', tab: 'jobs' }); await c.until(() => c.of('phone').length > 1);
    expect(c.last('phone').data.jobs.map((j: any) => j.jobId)).toContain('job_grocery_assistant');
    c.send({ t: 'phone', tab: 'achievements' }); await c.until(() => c.of('phone').length > 2);
    expect(c.last('phone').data.achievements.every((a: any) => a.earned === false)).toBe(true);
    c.send({ t: 'home' }); await c.until(() => c.of('toast').some((m) => /do not rent/.test(m.text)));
    c.close();
  });
});

describe('static pages', () => {
  it('/play without a trailing slash redirects to the game page', async () => {
    const w = await createWorld();
    try {
      const r = await w.app.inject({ method: 'GET', url: '/play' });
      expect(r.statusCode).toBe(302); expect(r.headers.location).toBe('/play/');
      expect((await w.app.inject({ method: 'GET', url: '/play/' })).statusCode).toBe(200);
    } finally { await w.close(); }
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createWorld, key, type TestWorld } from './helpers.js';
import { Gateway } from '../src/realtime/gateway.js';
import { Client } from './wsclient.js';

let w: TestWorld; let gw: Gateway; let port: number;
beforeEach(async () => {
  w = await createWorld(); gw = new Gateway(w.ctx); gw.attach(w.app.server);
  await w.app.listen({ port: 0, host: '127.0.0.1' }); port = (w.app.server.address() as AddressInfo).port;
});
afterEach(async () => { await gw.close(); await w.close(); });

type P = { token: string; characterId: string; accountId: string };
async function join(p: P): Promise<Client> {
  const t = (await w.playerReq(p.token, 'POST', `/v1/characters/${p.characterId}/join-ticket`)).body.ticket;
  const c = await Client.open(`ws://127.0.0.1:${port}/ws?ticket=${t}`);
  if (!(c instanceof Client)) throw new Error('rejected');
  await c.until(() => c.of('welcome').length > 0);
  return c;
}
const me = (p: P) => gw.players.get(p.characterId)!;
const bank = () => w.ctx.data.worlds.get('lagos')!.buildings.find((b: any) => b.kind === 'public' && b.short === 'bank')!;
const refresh = () => (gw as any).refreshVoice() as Promise<void>;
const inBank = (p: P, dx = 0) => { const b = bank(); me(p).x = b.cx + dx; me(p).z = b.cz; };
const lastVoice = (c: Client) => c.of('voice').at(-1);
const settle = () => new Promise((r) => setTimeout(r, 120));

describe('voice chat: who may talk, and the set-up relay (audio itself is browser to browser)', () => {
  it('is for adults only, and adults and teens never share a room', async () => {
    const teen = await w.newPlayer('Young Yinka', undefined, { birthDate: '2010-03-01' }); const ct = await join(teen);
    ct.send({ t: 'voice', on: true }); await ct.until(() => ct.of('voice').length > 0);
    expect(lastVoice(ct)).toMatchObject({ on: false, reason: 'adults_only' });
    const nodob = await w.newPlayer('No Date'); await w.ctx.pool.query('UPDATE accounts SET birth_date=NULL WHERE id=$1', [nodob.accountId]);
    const cn = await join(nodob); cn.send({ t: 'voice', on: true }); await cn.until(() => cn.of('voice').length > 0);
    expect(lastVoice(cn)).toMatchObject({ on: false, reason: 'adults_only' });
    ct.close(); cn.close();
  });

  it('puts people in the same building in one room, relays set-up messages between them only, and drops them when they leave', async () => {
    const a = await w.newPlayer('Ada Voice'); const b = await w.newPlayer('Bayo Voice'); const o = await w.newPlayer('Outside Ola');
    const [ca, cb, co] = [await join(a), await join(b), await join(o)];
    inBank(a, -1); inBank(b, 1); me(o).x = bank().cx; me(o).z = bank().cz + bank().sz / 2 + 4;   // outside the doorway
    for (const c of [ca, cb, co]) c.send({ t: 'voice', on: true });
    await ca.until(() => ca.of('voice').length > 0 && cb.of('voice').length > 0 && co.of('voice').length > 0); await settle(); await refresh();
    await ca.until(() => lastVoice(ca)?.peers.length === 1); await cb.until(() => lastVoice(cb)?.peers.length === 1);
    expect(lastVoice(ca).peers[0].id).toBe(b.characterId);
    expect(lastVoice(ca).room.id).toBe(bank().id);
    expect(lastVoice(co)).toMatchObject({ room: null, peers: [] });
    // set-up relay: inside the room it arrives, to an outsider it does not
    ca.send({ t: 'vsig', to: b.characterId, kind: 'offer', data: { sdp: 'v=0' } });
    await cb.until(() => cb.of('vsig').length > 0);
    expect(cb.last('vsig')).toMatchObject({ from: a.characterId, kind: 'offer' });
    ca.send({ t: 'vsig', to: o.characterId, kind: 'offer', data: { sdp: 'v=0' } }); await settle();
    expect(co.of('vsig')).toHaveLength(0);
    // walking out removes you from the room, and the other person is told
    me(b).x = bank().cx; me(b).z = bank().cz + bank().sz / 2 + 6; await refresh();
    await ca.until(() => lastVoice(ca)?.peers.length === 0);
    ca.send({ t: 'vsig', to: b.characterId, kind: 'ice', data: { c: 'x' } }); await settle();
    expect(cb.of('vsig')).toHaveLength(1);
    ca.close(); cb.close(); co.close();
  });

  it('keeps blocked pairs apart and refuses muted accounts', async () => {
    const a = await w.newPlayer('Ngozi Calm'); const b = await w.newPlayer('Bully Bob'); const c = await w.newPlayer('Third Tade');
    const [ca, cb, cc] = [await join(a), await join(b), await join(c)];
    await w.playerReq(a.token, 'POST', `/v1/characters/${a.characterId}/blocks`, { targetId: b.characterId }).catch(() => {});
    ca.send({ t: 'block', targetId: b.characterId });
    await ca.until(() => ca.of('toast').length > 0);
    inBank(a, -2); inBank(b, 0); inBank(c, 2);
    for (const x of [ca, cb, cc]) x.send({ t: 'voice', on: true });
    await ca.until(() => ca.of('voice').length > 0 && cb.of('voice').length > 0 && cc.of('voice').length > 0); await settle(); await refresh(); await settle();
    expect(lastVoice(ca).peers.map((p: any) => p.id)).toEqual([c.characterId]);
    expect(lastVoice(cb).peers.map((p: any) => p.id)).toEqual([c.characterId]);
    cb.send({ t: 'vsig', to: a.characterId, kind: 'offer', data: { sdp: 'x' } }); await settle();
    expect(ca.of('vsig')).toHaveLength(0);
    // a moderator mute turns voice off within one re-check
    await w.ctx.pool.query(`UPDATE accounts SET muted_until=now()+interval '1 hour' WHERE id=$1`, [c.accountId]);
    me(c).voice.checked = 0; await refresh();
    await cc.until(() => lastVoice(cc)?.on === false);
    expect(lastVoice(cc)).toMatchObject({ reason: 'muted' });
    ca.close(); cb.close(); cc.close();
  });

  it('caps a room at 8 speakers; the ninth is told the room is full', async () => {
    const players: P[] = []; const clients: Client[] = [];
    for (let i = 0; i < 9; i++) { const p = await w.newPlayer(`Crowd ${String.fromCharCode(65 + i)}${i}`); players.push(p); clients.push(await join(p)); (gw as any).connsByIp.clear(); }   // the per-IP connection cap is not what is under test
    players.forEach((p, i) => { inBank(p, -3 + i * 0.7); });
    for (let i = 0; i < 9; i++) { clients[i]!.send({ t: 'voice', on: true }); await clients[i]!.until(() => clients[i]!.of('voice').length > 0); await new Promise((r) => setTimeout(r, 15)); }
    await refresh(); await settle();
    expect(lastVoice(clients[0]!).peers).toHaveLength(7);
    expect(lastVoice(clients[8]!)).toMatchObject({ reason: 'room_full', room: null });
    clients.forEach((c) => c.close());
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, key, type TestWorld } from './helpers.js';
import { handleApp, phoneInfo } from '../src/modules/phone/index.js';
import { verifyLedgerIntegrity, balanceOf } from '../src/modules/economy/ledger.js';
import { withTx } from '../src/db.js';
import { transfer, playerAccount, systemAccount } from '../src/modules/economy/ledger.js';
import * as betting from '../src/modules/phone/betting.js';

let w: TestWorld;
beforeEach(async () => { w = await createWorld(); });
afterEach(async () => { await w.close(); });

type P = { characterId: string; token: string; accountId: string };
const adult = (n: string) => w.newPlayer(n);
const teen = (n: string) => w.newPlayer(n, undefined, { birthDate: '2010-03-01' });
const app = (p: P, name: string, a: string, d?: object) => handleApp(w.ctx, { id: p.characterId, name: 'x', city: 'lagos' }, name, a, d);
const bal = (p: P) => balanceOf(w.ctx.pool, p.characterId);
const code = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e: any) { return e.code ?? e.message; } };
const fund = (p: P, n: number) => withTx(w.ctx.pool, (tx) => transfer(tx, { key: key(), type: 'adjustment', amount: n, payload: {}, from: systemAccount('faucet:world'), to: playerAccount(p.characterId) }, () => ({})));
const integrity = async () => expect((await verifyLedgerIntegrity(w.ctx.pool)).ok).toBe(true);

describe('bank: send money', () => {
  it('moves money, is idempotent, and keeps the ledger balanced', async () => {
    const a = await adult('Ada'), b = await adult('Bola');
    const k = key();
    const r: any = (await app(a, 'bank', 'send', { to: 'bola', amount: 300, key: k })).data;
    expect(r.balance).toBe(w.ctx.data.economy.startingBalance - 300);
    const again: any = (await app(a, 'bank', 'send', { to: 'Bola', amount: 300, key: k })).data;
    expect(again.replayed).toBe(true);
    expect(await bal(b)).toBe(w.ctx.data.economy.startingBalance + 300);
    await integrity();
  });
  it('refuses self, unknown, overdraft, blocked, over-limit and daily cap', async () => {
    const a = await adult('Ada2'), b = await adult('Bola2'); await fund(a, 30000);
    expect(await code(() => app(a, 'bank', 'send', { to: 'Ada2', amount: 5, key: key() }))).toBe('cannot_pay_self');
    expect(await code(() => app(a, 'bank', 'send', { to: 'Nobody', amount: 5, key: key() }))).toBe('player_not_found');
    expect(await code(() => app(a, 'bank', 'send', { to: 'Bola2', amount: 99999, key: key() }))).toBe('over_transfer_limit');
    expect(await code(() => app(a, 'bank', 'send', { to: 'Bola2', amount: 5000, key: key() }))).toBe('ok');
    expect(await code(() => app(a, 'bank', 'send', { to: 'Bola2', amount: 5000, key: key() }))).toBe('ok');
    expect(await code(() => app(a, 'bank', 'send', { to: 'Bola2', amount: 5000, key: key() }))).toBe('ok');
    expect(await code(() => app(a, 'bank', 'send', { to: 'Bola2', amount: 5000, key: key() }))).toBe('ok');
    expect(await code(() => app(a, 'bank', 'send', { to: 'Bola2', amount: 10, key: key() }))).toBe('daily_send_limit');
    await w.gameReq('POST', `/v1/game/characters/${b.characterId}/blocks`, { targetCharacterId: a.characterId });
    expect(await code(() => app(a, 'bank', 'send', { to: 'Bola2', amount: 1, key: key() }))).toBe('blocked');
    await integrity();
  });
  it('never connects adults and minors, and caps minors lower', async () => {
    const a = await adult('Grownup'), t = await teen('Teeny'), t2 = await teen('Teeny2'); await fund(t, 5000);
    expect(await code(() => app(a, 'bank', 'send', { to: 'Teeny', amount: 5, key: key() }))).toBe('age_group_mismatch');
    expect(await code(() => app(t, 'bank', 'send', { to: 'Grownup', amount: 5, key: key() }))).toBe('age_group_mismatch');
    expect(await code(() => app(t, 'bank', 'send', { to: 'Teeny2', amount: 2000, key: key() }))).toBe('ok');
    expect(await code(() => app(t, 'bank', 'send', { to: 'Teeny2', amount: 1, key: key() }))).toBe('daily_send_limit');
    void t2;
  });
});

describe('bank: loans', () => {
  it('lends within the limit, one at a time, and repayment clears it', async () => {
    const a = await adult('Borrower');
    const before = await bal(a);
    expect(await code(() => app(a, 'bank', 'borrow', { amount: 100000, key: key() }))).toBe('over_loan_limit');
    const r: any = (await app(a, 'bank', 'borrow', { amount: 400, key: key() })).data;
    expect(r.owed).toBe(440);
    expect(await bal(a)).toBe(before + 400);
    expect(await code(() => app(a, 'bank', 'borrow', { amount: 50, key: key() }))).toBe('loan_active');
    const p: any = (await app(a, 'bank', 'repay', { amount: 1000, key: key() })).data;
    expect(p.paid).toBe(440); expect(p.cleared).toBe(true);
    expect(await bal(a)).toBe(before - 40);
    expect(await code(() => app(a, 'bank', 'borrow', { amount: 50, key: key() }))).toBe('ok');
    await integrity();
  });
  it('is adults-only and a replayed request does not lend twice', async () => {
    const t = await teen('Kiddo');
    expect(await code(() => app(t, 'bank', 'borrow', { amount: 50, key: key() }))).toBe('adults_only');
    const a = await adult('Once'); const k = key();
    await app(a, 'bank', 'borrow', { amount: 100, key: k });
    const again: any = (await app(a, 'bank', 'borrow', { amount: 100, key: k })).data;
    expect(again.replayed).toBe(true);
  });
  it('collects overdue loans from the wallet only, up to the garnish percent', async () => {
    const a = await adult('Late');
    await app(a, 'bank', 'borrow', { amount: 400, key: key() });
    w.clock.t = new Date(w.clock.t.getTime() + 73 * 3600_000);
    const before = await bal(a);
    const o: any = (await app(a, 'bank', 'overview')).data;
    expect(o.collected).toBe(Math.min(440, Math.floor(before * 0.3)));
    expect(await bal(a)).toBe(before - o.collected);
    const again: any = (await app(a, 'bank', 'overview')).data;
    expect(again.collected).toBe(0); // at most once per hour
    await integrity();
  });
});

describe('messages', () => {
  it('delivers, filters, respects blocks and age groups', async () => {
    const a = await adult('Msg A'), b = await adult('Msg B'), t = await teen('Msg Teen');
    const r: any = (await app(a, 'messages', 'send', { to: 'msg b', text: 'hello there' })).data;
    expect(r.body).toBe('hello there');
    const inbox: any = (await app(b, 'messages', 'inbox')).data;
    expect(inbox.chats[0].unread).toBe(1);
    const th: any = (await app(b, 'messages', 'thread', { with: a.characterId })).data;
    expect(th.messages).toHaveLength(1);
    expect(((await app(b, 'messages', 'inbox')).data as any).chats[0].unread).toBe(0);
    expect(await code(() => app(a, 'messages', 'send', { to: 'Msg Teen', text: 'hi' }))).toBe('age_group_mismatch');
    expect(await code(() => app(t, 'messages', 'send', { to: 'Msg A', text: 'hi' }))).toBe('age_group_mismatch');
    await w.gameReq('POST', `/v1/game/characters/${b.characterId}/blocks`, { targetCharacterId: a.characterId });
    expect(await code(() => app(a, 'messages', 'send', { to: 'Msg B', text: 'still there?' }))).toBe('blocked');
    expect(((await app(b, 'messages', 'inbox')).data as any).chats).toHaveLength(0);
  });
  it('rejects unknown players and bad input', async () => {
    const a = await adult('Msg C');
    expect(await code(() => app(a, 'messages', 'send', { to: 'Ghost', text: 'hi' }))).toBe('player_not_found');
    expect(await code(() => app(a, 'messages', 'send', { to: 'Msg C', text: 'hi' }))).toBe('cannot_message_self');
    expect(await code(() => app(a, 'nope', 'x'))).toBe('unknown_app_action');
  });
});

describe('dating (adults only)', () => {
  const prof = { bio: 'Love jollof and football', lookingFor: 'Friendship', interests: ['Music', 'Football'] };
  it('is closed to teens and players without a birth date', async () => {
    const t = await teen('Young One');
    expect(await code(() => app(t, 'love', 'state'))).toBe('adults_only');
    expect(await code(() => app(t, 'odds', 'state'))).toBe('adults_only');
    const u = await adult('No DOB'); await w.ctx.pool.query('UPDATE accounts SET birth_date=NULL WHERE id=$1', [u.accountId]);
    expect(await code(() => app(u, 'love', 'state'))).toBe('adults_only');
    expect((await phoneInfo(w.ctx, t.characterId)).adult).toBe(false);
  });
  it('matches only on mutual likes, never shows teens, hides blocked, and deletes cleanly', async () => {
    const a = await adult('Lover A'), b = await adult('Lover B'), c = await adult('Lover C'); const t = await teen('Teen X');
    for (const p of [a, b, c]) await app(p, 'love', 'save', prof);
    // a teen can't create a profile, even by direct insert they'd be filtered out
    await w.ctx.pool.query(`INSERT INTO dating_profiles (character_id,bio,looking_for,created_at) VALUES ($1,'sneaky','Friendship',now())`, [t.characterId]);
    await w.gameReq('POST', `/v1/game/characters/${c.characterId}/blocks`, { targetCharacterId: a.characterId });
    const seen: any = (await app(a, 'love', 'discover')).data;
    const names = seen.people.map((x: any) => x.name);
    expect(names).toContain('Lover B'); expect(names).not.toContain('Lover C'); expect(names).not.toContain('Teen X'); expect(names).not.toContain('Lover A');
    const s1: any = (await app(a, 'love', 'swipe', { id: b.characterId, like: true })).data;
    expect(s1.matched).toBe(false);
    expect(await code(() => app(a, 'love', 'swipe', { id: t.characterId, like: true }))).toBe('profile_unavailable');
    const s2: any = (await app(b, 'love', 'swipe', { id: a.characterId, like: true })).data;
    expect(s2.matched).toBe(true);
    expect(((await app(a, 'love', 'state')).data as any).matches.map((m: any) => m.name)).toEqual(['Lover B']);
    expect(((await app(a, 'love', 'discover')).data as any).people.map((x: any) => x.name)).not.toContain('Lover B');
    await app(a, 'love', 'remove');
    expect(((await app(b, 'love', 'state')).data as any).matches).toHaveLength(0);
    expect(((await app(a, 'love', 'state')).data as any).profile).toBeNull();
  });
  it('filters the bio and requires a profile first', async () => {
    const a = await adult('Lover D');
    expect(await code(() => app(a, 'love', 'discover'))).toBe('profile_required');
    w.ctx.data.chat.blockedWords.push('badword');
    expect(await code(() => app(a, 'love', 'save', { ...prof, bio: 'you badword' }))).toBe('bio_not_allowed');
    expect(await code(() => app(a, 'love', 'save', { ...prof, lookingFor: 'hax' }))).toBe('invalid_choice');
  });
});

describe('odds (play-money betting, adults only)', () => {
  it('has deterministic fixtures with a house margin and unpredictable-but-fixed results', async () => {
    const a = await adult('Punter');
    const o: any = (await app(a, 'odds', 'state')).data;
    expect(o.fixtures).toHaveLength(4);
    const f = betting.fixture(w.ctx, 7, 1), g = betting.fixture(w.ctx, 7, 1);
    expect(f).toEqual(g);
    expect(1 / f.odds.home + 1 / f.odds.draw + 1 / f.odds.away).toBeGreaterThan(1.05); // overround = house edge
    expect(betting.result(w.ctx, 7, 1)).toEqual(betting.result(w.ctx, 7, 1));
  });
  it('stakes, settles after the round ends, pays winners through the ledger, and enforces limits', async () => {
    const a = await adult('Punter2'); const start = await bal(a);
    expect(await code(() => app(a, 'odds', 'bet', { slot: 0, pick: 'home', stake: 5, key: key() }))).toBe('stake_out_of_range');
    expect(await code(() => app(a, 'odds', 'bet', { slot: 0, pick: 'home', stake: 9999, key: key() }))).toBe('stake_out_of_range');
    const k = key();
    const placed: any = (await app(a, 'odds', 'bet', { slot: 0, pick: 'home', stake: 100, key: k })).data;
    expect(await bal(a)).toBe(start - 100);
    expect(((await app(a, 'odds', 'bet', { slot: 0, pick: 'home', stake: 100, key: k })).data as any).replayed).toBe(true);
    expect(await code(() => app(a, 'odds', 'bet', { slot: 0, pick: 'away', stake: 100, key: key() }))).toBe('already_bet');
    const round = betting.currentRound(w.ctx);
    const outcome = betting.result(w.ctx, round, 0).pick;
    // not settled while the round is still running
    expect(((await app(a, 'odds', 'state')).data as any).bets[0].status).toBe('open');
    w.clock.t = new Date(w.clock.t.getTime() + 11 * 60_000);
    const after: any = (await app(a, 'odds', 'state')).data;
    if (outcome === 'home') { expect(after.bets[0].status).toBe('won'); expect(await bal(a)).toBe(start - 100 + placed.potential); }
    else { expect(after.bets[0].status).toBe('lost'); expect(await bal(a)).toBe(start - 100); }
    await app(a, 'odds', 'state'); // settling twice never pays twice
    expect(await bal(a)).toBe(outcome === 'home' ? start - 100 + placed.potential : start - 100);
    await integrity();
  });
  it('stops at the daily loss limit and honours a self-imposed break', async () => {
    const a = await adult('Punter3');
    for (let i = 0; i < 4; i++) await app(a, 'odds', 'bet', { slot: i, pick: 'draw', stake: 500, key: key() });
    expect(await code(() => app(a, 'odds', 'bet', { slot: 0, pick: 'draw', stake: 10, key: key() }))).toBe('daily_loss_limit');
    w.clock.t = new Date(w.clock.t.getTime() + 11 * 60_000);
    await app(a, 'odds', 'state');
    const lossy: any = (await app(a, 'odds', 'state')).data;
    const lossToday = lossy.limits.lossToday;
    if (lossToday + 500 > 2000) expect(await code(() => app(a, 'odds', 'bet', { slot: 0, pick: 'draw', stake: 500, key: key() }))).toBe('daily_loss_limit');
    const b = await adult('Punter4');
    const br: any = (await app(b, 'odds', 'pause', { hours: 24 })).data;
    expect(br.onBreakUntil).toBeTruthy();
    expect(await code(() => app(b, 'odds', 'bet', { slot: 0, pick: 'home', stake: 50, key: key() }))).toBe('on_break');
    expect(await code(() => app(b, 'odds', 'pause', { hours: 3 }))).toBe('invalid_break');
    w.clock.t = new Date(w.clock.t.getTime() + 25 * 3600_000);
    expect(await code(() => app(b, 'odds', 'bet', { slot: 0, pick: 'home', stake: 50, key: key() }))).toBe('ok');
    await integrity();
  });
});

describe('reports carry context for moderators', () => {
  it('snapshots the DMs, transfers and dating bio of the reported pair only', async () => {
    const a = await adult('Reporter'), b = await adult('Offender'), c = await adult('Bystander');
    await app(b, 'love', 'save', { bio: 'hello world friend', lookingFor: 'Friendship', interests: [] });
    await app(b, 'messages', 'send', { to: 'Reporter', text: 'send me money now' });
    await app(a, 'messages', 'send', { to: 'Offender', text: 'no' });
    await app(c, 'messages', 'send', { to: 'Offender', text: 'unrelated private chat' });
    const rep = (await import('../src/modules/moderation/moderation.js'));
    await rep.fileReport(w.ctx, a.characterId, b.characterId, 'scam', 'asks for money');
    const list = await rep.listReports(w.ctx, 'open');
    const ev: any = list[0]!.evidence;
    expect(ev.messages.map((m: any) => m.text)).toEqual(['send me money now', 'no']);
    expect(ev.datingBio).toBe('hello world friend');
    expect(JSON.stringify(ev)).not.toContain('unrelated');
  });
});

describe('message privacy', () => {
  it('stores messages encrypted, shows them only to the two people, and never to a third player', async () => {
    const a = await adult('Priv A'), b = await adult('Priv B'), c = await adult('Priv C');
    await app(a, 'messages', 'send', { to: 'Priv B', text: 'my secret plan 12345' });
    const raw = (await w.ctx.pool.query('SELECT body FROM direct_messages')).rows[0].body as string;
    expect(raw.startsWith('v1:')).toBe(true);
    expect(raw).not.toContain('secret');
    expect(((await app(b, 'messages', 'thread', { with: a.characterId })).data as any).messages[0].body).toBe('my secret plan 12345');
    // a third player sees nothing, whichever side of the conversation they ask about
    expect(((await app(c, 'messages', 'inbox')).data as any).chats).toHaveLength(0);
    expect(((await app(c, 'messages', 'thread', { with: a.characterId })).data as any).messages).toHaveLength(0);
    expect(((await app(c, 'messages', 'thread', { with: b.characterId })).data as any).messages).toHaveLength(0);
    // a tampered ciphertext is not shown as text
    await w.ctx.pool.query(`UPDATE direct_messages SET body = 'v1:' || 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'`);
    expect(((await app(b, 'messages', 'thread', { with: a.characterId })).data as any).messages[0].body).toContain('could not be decrypted');
  });
});

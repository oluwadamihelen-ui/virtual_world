import { createHmac } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { withTx } from '../../db.js';
import { AppError, badRequest, conflict } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { assertAmount, balanceOf, claim, finish, playerAccount, post, systemAccount } from '../economy/ledger.js';

/**
 * "Odds": play-money sports betting for adults (MVC is a game currency, not convertible to real money).
 * Fixtures and results are derived from a server-side secret + round number, so they cannot be predicted or
 * tampered with, and need no stored state. A bet on round R is settled once round R has ended.
 * House edge = marginPercent (shown to players). Limits: stake range, open bets, rolling 24h loss limit, self-exclusion breaks.
 */
type Pick = 'home' | 'draw' | 'away';
const DRAW_SHARE = 0.26;

const roundMs = (ctx: AppContext) => ctx.data.phone.betting.roundMinutes * 60_000;
export const currentRound = (ctx: AppContext) => Math.floor(ctx.now().getTime() / roundMs(ctx));
const rand = (ctx: AppContext, label: string): number => createHmac('sha256', ctx.config.JWT_SECRET).update(`odds:${label}`).digest().readUInt32BE(0) / 0x1_0000_0000;

export function fixture(ctx: AppContext, round: number, slot: number) {
  const teams = ctx.data.phone.betting.teams;
  const a = Math.floor(rand(ctx, `h:${round}:${slot}`) * teams.length);
  let b = Math.floor(rand(ctx, `a:${round}:${slot}`) * (teams.length - 1));
  if (b >= a) b++;
  const home = teams[a]!, away = teams[b]!;
  const hw = home.strength * 1.1, aw = away.strength;
  const pHome = ((1 - DRAW_SHARE) * hw) / (hw + aw), pAway = ((1 - DRAW_SHARE) * aw) / (hw + aw);
  const edge = 1 - ctx.data.phone.betting.marginPercent / 100;
  const odd = (p: number) => Math.max(1.05, Math.round((edge / p) * 100) / 100);
  return { round, slot, home: home.name, away: away.name, probs: { home: pHome, draw: DRAW_SHARE, away: pAway }, odds: { home: odd(pHome), draw: odd(DRAW_SHARE), away: odd(pAway) } };
}

export function result(ctx: AppContext, round: number, slot: number): { pick: Pick; homeGoals: number; awayGoals: number } {
  const f = fixture(ctx, round, slot);
  const u = rand(ctx, `r:${round}:${slot}`);
  const pick: Pick = u < f.probs.home ? 'home' : u < f.probs.home + f.probs.draw ? 'draw' : 'away';
  const g = (label: string, max: number) => Math.floor(rand(ctx, `g:${label}:${round}:${slot}`) * max);
  let hg: number, ag: number;
  if (pick === 'draw') { hg = ag = g('d', 4); }
  else { const w = 1 + g('w', 4), l = g('l', w); [hg, ag] = pick === 'home' ? [w, l] : [l, w]; }
  return { pick, homeGoals: hg, awayGoals: ag };
}

async function breakUntil(ctx: AppContext, me: string): Promise<Date | null> {
  const r = (await ctx.pool.query('SELECT break_until FROM bet_state WHERE character_id=$1', [me])).rows[0];
  return r?.break_until && r.break_until > ctx.now() ? r.break_until : null;
}

async function netLoss24h(ctx: AppContext, me: string): Promise<number> {
  const r = (await ctx.pool.query(
    `SELECT COALESCE(SUM(stake - payout),0)::bigint AS n FROM bets WHERE character_id=$1 AND created_at > $2`, [me, new Date(ctx.now().getTime() - 86400_000)])).rows[0];
  return Math.max(0, Number(r.n));
}

/** Settle every finished bet for this player (idempotent; payout key is derived from the bet id). */
export async function settle(ctx: AppContext, me: string): Promise<{ won: number; lost: number; paid: number }> {
  const cur = currentRound(ctx);
  const open = (await ctx.pool.query(`SELECT id FROM bets WHERE character_id=$1 AND status='open' AND round < $2`, [me, cur])).rows;
  let won = 0, lost = 0, paid = 0;
  for (const o of open) {
    await withTx(ctx.pool, async (tx) => {
      const b = (await tx.query(`SELECT * FROM bets WHERE id=$1 AND status='open' FOR UPDATE`, [o.id])).rows[0];
      if (!b) return;
      const res = result(ctx, Number(b.round), b.slot);
      if (res.pick === b.pick) {
        const payout = Math.floor(Number(b.stake) * Number(b.odds));
        const cl = await claim<any>(tx, { key: `bet-payout:${b.id}`, type: 'bet_payout', actorCharacterId: me, referenceType: 'bet', referenceId: b.id, amount: payout, payload: { id: b.id } });
        if (!cl.replay) { await post(tx, cl.txId, [{ account: systemAccount('faucet:betting_house'), delta: -payout }, { account: playerAccount(me), delta: payout }]); await finish(tx, cl.txId, { payout }); }
        await tx.query(`UPDATE bets SET status='won', payout=$2, settled_at=$3 WHERE id=$1`, [b.id, payout, ctx.now()]);
        won++; paid += payout;
      } else {
        await tx.query(`UPDATE bets SET status='lost', settled_at=$2 WHERE id=$1`, [b.id, ctx.now()]);
        lost++;
      }
    });
  }
  return { won, lost, paid };
}

export async function overview(ctx: AppContext, me: string) {
  const settled = await settle(ctx, me);
  const cfg = ctx.data.phone.betting;
  const round = currentRound(ctx);
  const closesAt = new Date((round + 1) * roundMs(ctx));
  const fixtures = Array.from({ length: cfg.fixturesPerRound }, (_, i) => { const f = fixture(ctx, round, i); return { slot: i, home: f.home, away: f.away, odds: f.odds }; });
  const prev = Array.from({ length: cfg.fixturesPerRound }, (_, i) => { const f = fixture(ctx, round - 1, i); const r = result(ctx, round - 1, i); return { home: f.home, away: f.away, homeGoals: r.homeGoals, awayGoals: r.awayGoals }; });
  const bets = (await ctx.pool.query(`SELECT * FROM bets WHERE character_id=$1 ORDER BY created_at DESC LIMIT 20`, [me])).rows.map((b) => {
    const f = fixture(ctx, Number(b.round), b.slot);
    return { id: b.id as string, match: `${f.home} v ${f.away}`, pick: b.pick as Pick, stake: Number(b.stake), odds: Number(b.odds), status: b.status as string, payout: Number(b.payout) };
  });
  const bu = await breakUntil(ctx, me);
  return {
    settled, fixtures, closesAt: closesAt.toISOString(), previousResults: prev, bets,
    limits: { minStake: cfg.minStake, maxStake: cfg.maxStake, dailyLossLimit: cfg.dailyLossLimit, maxOpenBets: cfg.maxOpenBets, marginPercent: cfg.marginPercent, lossToday: await netLoss24h(ctx, me), breakHours: cfg.breakHours },
    onBreakUntil: bu ? bu.toISOString() : null,
  };
}

export async function place(ctx: AppContext, me: string, slot: number, pick: Pick, stake: number, key: string) {
  const cfg = ctx.data.phone.betting;
  assertAmount(stake, 'stake');
  if (!['home', 'draw', 'away'].includes(pick) || !Number.isInteger(slot) || slot < 0 || slot >= cfg.fixturesPerRound) throw badRequest('invalid_bet');
  if (stake < cfg.minStake || stake > cfg.maxStake) throw badRequest('stake_out_of_range', `Stakes are between ${cfg.minStake} and ${cfg.maxStake} MVC.`);
  if (await breakUntil(ctx, me)) throw new AppError(403, 'on_break', 'You are taking a break from betting.');
  await settle(ctx, me);
  const round = currentRound(ctx);
  const f = fixture(ctx, round, slot);
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, me);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [me]);
    const cl = await claim<any>(tx, { key: `${me}:bet:${key}`, type: 'bet_stake', actorCharacterId: me, referenceType: 'bet', referenceId: `${round}:${slot}`, amount: stake, payload: { slot, pick, stake, round } });
    if (cl.replay) return { ...cl.response, replayed: true };
    const open = (await tx.query(`SELECT COUNT(*)::int AS n FROM bets WHERE character_id=$1 AND status='open'`, [me])).rows[0].n;
    if (open >= cfg.maxOpenBets) throw conflict('too_many_open_bets', 'Wait for your open bets to finish first.');
    const loss = (await tx.query(`SELECT COALESCE(SUM(stake - payout),0)::bigint AS n FROM bets WHERE character_id=$1 AND created_at > $2`, [me, new Date(ctx.now().getTime() - 86400_000)])).rows[0].n;
    if (Math.max(0, Number(loss)) + stake > cfg.dailyLossLimit) throw new AppError(403, 'daily_loss_limit', `Daily loss limit of ${cfg.dailyLossLimit} MVC reached. Take a break, it is only a game.`);
    const ins = await tx.query(`SELECT 1 FROM bets WHERE character_id=$1 AND round=$2 AND slot=$3`, [me, round, slot]);
    if (ins.rowCount) throw conflict('already_bet', 'You already have a bet on this match.');
    const odds = f.odds[pick];
    const bet = (await tx.query(`INSERT INTO bets (character_id,round,slot,pick,stake,odds,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [me, round, slot, pick, stake, odds, ctx.now()])).rows[0];
    await post(tx, cl.txId, [{ account: playerAccount(me), delta: -stake }, { account: systemAccount('faucet:betting_house'), delta: stake }]);
    const response = { betId: bet.id, match: `${f.home} v ${f.away}`, pick, stake, odds, potential: Math.floor(stake * odds), balance: await balanceOf(tx, me), replayed: false };
    await finish(tx, cl.txId, response);
    return response;
  });
}

export async function takeBreak(ctx: AppContext, me: string, hours: number) {
  if (!ctx.data.phone.betting.breakHours.includes(hours)) throw badRequest('invalid_break');
  const until = new Date(ctx.now().getTime() + hours * 3600_000);
  // A break can only be extended, never shortened, so it cannot be undone on impulse.
  await ctx.pool.query(
    `INSERT INTO bet_state (character_id, break_until) VALUES ($1,$2)
     ON CONFLICT (character_id) DO UPDATE SET break_until = GREATEST(bet_state.break_until, EXCLUDED.break_until)`, [me, until]);
  return { onBreakUntil: until.toISOString() };
}

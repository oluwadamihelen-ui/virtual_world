import type { AppContext } from '../../context.js';
import { withTx } from '../../db.js';
import { AppError, badRequest, conflict } from '../../errors.js';
import { assertCanAct, assertAdult, characterAgeBand } from '../identity/service.js';
import { isBlockedEitherWay } from '../social/social.js';
import { assertAmount, balanceOf, claim, finish, history, playerAccount, post, systemAccount, transfer } from '../economy/ledger.js';
import { assertSameAgeGroup, findByName } from './common.js';

/** Peer-to-peer transfer with per-transfer and rolling 24h caps (lower for under-18s). */
export async function send(ctx: AppContext, fromId: string, toName: string, amount: number, key: string, note?: string) {
  const cfg = ctx.data.phone.transfer;
  assertAmount(amount);
  if (amount < cfg.min) throw badRequest('amount_too_small');
  if (amount > cfg.maxPerTransfer) throw badRequest('over_transfer_limit', `The most you can send at once is ${cfg.maxPerTransfer} MVC.`);
  const to = await findByName(ctx, toName);
  if (to.id === fromId) throw badRequest('cannot_pay_self', 'You cannot send money to yourself.');
  if (await isBlockedEitherWay(ctx, fromId, to.id)) throw new AppError(403, 'blocked', 'You cannot send money to this player.');
  await assertSameAgeGroup(ctx, fromId, to.id);
  const band = await characterAgeBand(ctx, fromId);
  const dayCap = band === 'adult' ? cfg.maxPerDay : cfg.minorMaxPerDay;
  const cleanNote = (note ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60);
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, fromId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [fromId]); // serialises concurrent sends so the cap holds
    const sent = (await tx.query(
      `SELECT COALESCE(SUM(amount),0)::bigint AS s FROM ledger_transactions
        WHERE type='p2p_transfer' AND actor_character_id=$1 AND created_at > now() - interval '24 hours' AND idempotency_key <> $2`,
      [fromId, `${fromId}:send:${key}`])).rows[0].s as number;
    const r = await transfer(tx, {
      key: `${fromId}:send:${key}`, type: 'p2p_transfer', actorCharacterId: fromId, referenceType: 'character', referenceId: to.id,
      amount, payload: { to: to.id, amount, note: cleanNote }, from: playerAccount(fromId), to: playerAccount(to.id),
    }, (txId) => ({ txId, to: to.name, toId: to.id, amount, note: cleanNote }));
    if (!r.replay && sent + amount > dayCap) throw new AppError(409, 'daily_send_limit', `Daily sending limit is ${dayCap} MVC. You have ${Math.max(0, dayCap - sent)} MVC left today.`);
    return { ...r.response, replayed: r.replay, balance: await balanceOf(tx, fromId) };
  });
}

export async function activeLoan(ctx: AppContext, characterId: string) {
  const r = (await ctx.pool.query(`SELECT * FROM loans WHERE character_id=$1 AND status='active'`, [characterId])).rows[0];
  if (!r) return null;
  const owed = Number(r.principal) + Number(r.fee) - Number(r.repaid);
  return { id: r.id as string, principal: Number(r.principal), fee: Number(r.fee), repaid: Number(r.repaid), owed, dueAt: (r.due_at as Date).toISOString(), overdue: r.due_at < ctx.now() };
}

export async function loanLimit(ctx: AppContext, characterId: string): Promise<number> {
  const c = ctx.data.phone.loans;
  const rep = (await ctx.pool.query('SELECT reputation FROM characters WHERE id=$1', [characterId])).rows[0]?.reputation ?? 0;
  return Math.min(c.maxLimit, c.baseLimit + Math.max(0, rep) * c.limitPerReputation);
}

export async function takeLoan(ctx: AppContext, characterId: string, amount: number, key: string) {
  const c = ctx.data.phone.loans;
  assertAmount(amount);
  if (amount < 1) throw badRequest('amount_too_small');
  await assertAdult(ctx, characterId); // credit is adults-only
  const limit = await loanLimit(ctx, characterId);
  if (amount > limit) throw badRequest('over_loan_limit', `Your loan limit is ${limit} MVC. Build reputation to raise it.`);
  const fee = Math.ceil((amount * c.feePercent) / 100);
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const cl = await claim<any>(tx, { key: `${characterId}:loan:${key}`, type: 'loan_disbursement', actorCharacterId: characterId, referenceType: 'loan', referenceId: characterId, amount, payload: { amount } });
    if (cl.replay) return { ...cl.response, replayed: true };
    if ((await tx.query(`SELECT 1 FROM loans WHERE character_id=$1 AND status='active'`, [characterId])).rowCount) throw conflict('loan_active', 'Pay back your current loan first.');
    const now = ctx.now();
    const due = new Date(now.getTime() + c.termHours * 3600_000);
    const loan = (await tx.query(
      `INSERT INTO loans (character_id, principal, fee, created_at, due_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [characterId, amount, fee, now, due])).rows[0];
    await post(tx, cl.txId, [{ account: systemAccount('faucet:bank'), delta: -amount }, { account: playerAccount(characterId), delta: amount }]);
    const response = { loanId: loan.id, principal: amount, fee, owed: amount + fee, dueAt: due.toISOString(), balance: await balanceOf(tx, characterId), replayed: false };
    await finish(tx, cl.txId, response);
    return response;
  });
}

export async function repayLoan(ctx: AppContext, characterId: string, amount: number, key: string) {
  assertAmount(amount);
  if (amount < 1) throw badRequest('amount_too_small');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const cl = await claim<any>(tx, { key: `${characterId}:repay:${key}`, type: 'loan_repayment', actorCharacterId: characterId, referenceType: 'loan', referenceId: characterId, amount, payload: { amount } });
    if (cl.replay) return { ...cl.response, replayed: true };
    const loan = (await tx.query(`SELECT * FROM loans WHERE character_id=$1 AND status='active' FOR UPDATE`, [characterId])).rows[0];
    if (!loan) throw conflict('no_loan', 'You have no loan to repay.');
    const owed = Number(loan.principal) + Number(loan.fee) - Number(loan.repaid);
    const pay = Math.min(amount, owed);
    await tx.query('UPDATE ledger_transactions SET amount=$2 WHERE id=$1', [cl.txId, pay]);
    await post(tx, cl.txId, [{ account: playerAccount(characterId), delta: -pay }, { account: systemAccount('faucet:bank'), delta: pay }]);
    const left = owed - pay;
    await tx.query(`UPDATE loans SET repaid = repaid + $2, status = $3 WHERE id=$1`, [loan.id, pay, left === 0 ? 'paid' : 'active']);
    const response = { paid: pay, owed: left, cleared: left === 0, balance: await balanceOf(tx, characterId), replayed: false };
    await finish(tx, cl.txId, response);
    return response;
  });
}

/**
 * Overdue loans are collected from the wallet only: at most garnishPercent of the current balance, at most once an hour,
 * never below zero, and never from items or property. Called whenever the Bank app is opened.
 */
export async function collectOverdue(ctx: AppContext, characterId: string) {
  const loan = await activeLoan(ctx, characterId);
  if (!loan || !loan.overdue) return 0;
  const pct = ctx.data.phone.loans.garnishPercent;
  return withTx(ctx.pool, async (tx) => {
    const bal = await balanceOf(tx, characterId);
    const amt = Math.min(loan.owed, Math.floor((bal * pct) / 100));
    if (amt < 1) return 0;
    const hour = Math.floor(ctx.now().getTime() / 3600_000);
    const cl = await claim<any>(tx, { key: `loan-collect:${loan.id}:${hour}`, type: 'loan_collection', actorCharacterId: characterId, referenceType: 'loan', referenceId: loan.id, amount: amt, payload: { hour } });
    if (cl.replay) return 0;
    await post(tx, cl.txId, [{ account: playerAccount(characterId), delta: -amt }, { account: systemAccount('faucet:bank'), delta: amt }]);
    await tx.query(`UPDATE loans SET repaid = repaid + $2, status = CASE WHEN repaid + $2 >= principal + fee THEN 'paid' ELSE 'active' END WHERE id=$1`, [loan.id, amt]);
    await finish(tx, cl.txId, { collected: amt });
    return amt;
  });
}

export async function overview(ctx: AppContext, characterId: string) {
  const collected = await collectOverdue(ctx, characterId);
  const cfg = ctx.data.phone;
  const band = await characterAgeBand(ctx, characterId);
  const sent = (await ctx.pool.query(
    `SELECT COALESCE(SUM(amount),0)::bigint AS s FROM ledger_transactions WHERE type='p2p_transfer' AND actor_character_id=$1 AND created_at > now() - interval '24 hours'`, [characterId])).rows[0].s as number;
  const rows = await history(ctx.pool, characterId, 30);
  const loan = await activeLoan(ctx, characterId);
  return {
    collected, balance: await balanceOf(ctx.pool, characterId), loan, loanLimit: band === 'adult' ? await loanLimit(ctx, characterId) : 0, canBorrow: band === 'adult',
    loanFeePercent: cfg.loans.feePercent, loanTermHours: cfg.loans.termHours,
    dayCap: band === 'adult' ? cfg.transfer.maxPerDay : cfg.transfer.minorMaxPerDay, sentToday: sent, maxPerTransfer: cfg.transfer.maxPerTransfer,
    history: rows.map((r) => ({ type: r.type, delta: r.delta, balance: r.balance_after, at: r.created_at })),
  };
}

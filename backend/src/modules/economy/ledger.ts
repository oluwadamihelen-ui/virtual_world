import { createHash } from 'node:crypto';
import type { Tx } from '../../db.js';
import { AppError, badRequest, conflict } from '../../errors.js';

/**
 * Double-entry MVC ledger.
 *
 * Contract: every function takes the caller's open DB transaction, so a gameplay action
 * (e.g. "buy sandwich") commits the payment, the stock change and the inventory grant
 * atomically, or none of them.
 *
 * Idempotency: each money-moving action claims a unique idempotency key first. Replays with
 * the same key + same request return the original response; the same key with a different
 * request is rejected.
 */

export const MAX_AMOUNT = 1_000_000_000_000;

export type SystemAccount = 'faucet:world' | 'faucet:npc_employers' | 'faucet:npc_customers' | 'sink:landlord_npc' | 'sink:supplier_npc' | 'sink:city_fees' | 'sink:transport' | 'faucet:bank' | 'faucet:betting_house' | 'adjustments:admin' | `shop:${string}`;
// Faucets and admin adjustments may run negative (they are the source of new money); everything else may not.
const NEGATIVE_OK = (ref: string) => ref.startsWith('faucet:') || ref.startsWith('adjustments:');

export interface AccountRef { kind: 'player' | 'business' | 'system'; ownerRef: string }
export const playerAccount = (characterId: string): AccountRef => ({ kind: 'player', ownerRef: characterId });
export const businessAccount = (businessId: string): AccountRef => ({ kind: 'business', ownerRef: businessId });
export const systemAccount = (ref: SystemAccount): AccountRef => ({ kind: 'system', ownerRef: ref });

export interface Posting { account: AccountRef; delta: number }

export function assertAmount(n: unknown, field = 'amount'): asserts n is number {
  if (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > MAX_AMOUNT) {
    throw badRequest('invalid_amount', `${field} must be an integer between 0 and ${MAX_AMOUNT}`);
  }
}

export async function ensureAccount(tx: Tx, ref: AccountRef): Promise<string> {
  const allowNegative = ref.kind === 'system' && NEGATIVE_OK(ref.ownerRef);
  const r = await tx.query(
    `INSERT INTO ledger_accounts (kind, owner_ref, allow_negative) VALUES ($1,$2,$3)
     ON CONFLICT (kind, owner_ref) DO UPDATE SET kind = EXCLUDED.kind RETURNING id`,
    [ref.kind, ref.ownerRef, allowNegative],
  );
  return r.rows[0].id;
}

export function requestHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export type Claim<R> = { replay: true; response: R } | { replay: false; txId: string };

export interface ClaimInput {
  key: string;
  type: string;
  actorCharacterId?: string | null;
  referenceType?: string;
  referenceId?: string;
  amount: number;
  payload: unknown; // what the key's request means; used to detect key reuse with different content
}

/** Claim an idempotency key inside the caller's transaction. Concurrent claimers of one key serialize here. */
export async function claim<R = unknown>(tx: Tx, c: ClaimInput): Promise<Claim<R>> {
  assertAmount(c.amount);
  if (!c.key || c.key.length > 200) throw badRequest('invalid_idempotency_key');
  const hash = requestHash(c.payload);
  const ins = await tx.query(
    `INSERT INTO ledger_transactions (type, idempotency_key, request_hash, actor_character_id, reference_type, reference_id, amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [c.type, c.key, hash, c.actorCharacterId ?? null, c.referenceType ?? null, c.referenceId ?? null, c.amount],
  );
  if (ins.rowCount === 1) return { replay: false, txId: ins.rows[0].id };
  const ex = await tx.query('SELECT request_hash, response, type FROM ledger_transactions WHERE idempotency_key=$1', [c.key]);
  const row = ex.rows[0];
  if (row.request_hash !== hash || row.type !== c.type) {
    throw conflict('idempotency_key_reused', 'This idempotency key was already used for a different request');
  }
  return { replay: true, response: row.response as R };
}

/** Apply postings (must sum to zero). Locks accounts in id order to avoid deadlocks. Rejects overdrafts. */
export async function post(tx: Tx, txId: string, postings: Posting[]): Promise<void> {
  const sum = postings.reduce((a, p) => a + p.delta, 0);
  if (sum !== 0) throw new AppError(500, 'unbalanced_transaction');
  const merged = new Map<string, { ref: AccountRef; delta: number }>();
  for (const p of postings) {
    if (!Number.isSafeInteger(p.delta)) throw badRequest('invalid_amount');
    const k = `${p.account.kind}:${p.account.ownerRef}`;
    const m = merged.get(k);
    if (m) m.delta += p.delta; else merged.set(k, { ref: p.account, delta: p.delta });
  }
  const resolved: { id: string; delta: number }[] = [];
  for (const m of merged.values()) resolved.push({ id: await ensureAccount(tx, m.ref), delta: m.delta });
  resolved.sort((a, b) => (a.id < b.id ? -1 : 1));
  await tx.query('SELECT 1 FROM ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [resolved.map((r) => r.id)]);
  for (const r of resolved) {
    if (r.delta === 0) continue;
    // Guarded update: the WHERE clause is the overdraft check; the CHECK constraint is the backstop.
    const u = await tx.query(
      `UPDATE ledger_accounts SET balance = balance + $2
        WHERE id = $1 AND (allow_negative OR balance + $2 >= 0) RETURNING balance`,
      [r.id, r.delta],
    );
    if (u.rowCount === 0) throw new AppError(402, 'insufficient_funds', 'Insufficient MVC');
    await tx.query('INSERT INTO ledger_entries (tx_id, account_id, delta, balance_after) VALUES ($1,$2,$3,$4)', [txId, r.id, r.delta, u.rows[0].balance]);
  }
}

export async function finish(tx: Tx, txId: string, response: unknown): Promise<void> {
  await tx.query('UPDATE ledger_transactions SET response=$2 WHERE id=$1', [txId, JSON.stringify(response)]);
}

export async function balanceOf(tx: Pick<Tx, 'query'>, characterId: string): Promise<number> {
  const r = await tx.query(`SELECT balance FROM ledger_accounts WHERE kind='player' AND owner_ref=$1`, [characterId]);
  return r.rows[0]?.balance ?? 0;
}

/** Simple one-shot transfer helper used by wages, grants and rent. */
export async function transfer<R extends object>(
  tx: Tx,
  c: Omit<ClaimInput, 'amount'> & { from: AccountRef; to: AccountRef; amount: number },
  buildResponse: (txId: string) => R,
): Promise<{ replay: boolean; response: R }> {
  const cl = await claim<R>(tx, c);
  if (cl.replay) return { replay: true, response: cl.response };
  await post(tx, cl.txId, [{ account: c.from, delta: -c.amount }, { account: c.to, delta: c.amount }]);
  const response = buildResponse(cl.txId);
  await finish(tx, cl.txId, response);
  return { replay: false, response };
}

export async function history(tx: Pick<Tx, 'query'>, characterId: string, limit = 50) {
  const r = await tx.query(
    `SELECT t.id, t.type, t.status, t.amount, t.reference_type, t.reference_id, t.created_at, e.delta, e.balance_after
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id AND a.kind='player' AND a.owner_ref=$1
       JOIN ledger_transactions t ON t.id = e.tx_id
      ORDER BY e.id DESC LIMIT $2`,
    [characterId, Math.min(Math.max(limit, 1), 200)],
  );
  return r.rows;
}

/** Global invariant: sum of all balances is exactly zero (money is only created via faucet accounts). */
export async function verifyLedgerIntegrity(tx: Pick<Tx, 'query'>) {
  const total = (await tx.query('SELECT COALESCE(SUM(balance),0)::bigint AS s FROM ledger_accounts')).rows[0].s as number;
  const drift = (await tx.query(
    `SELECT a.id FROM ledger_accounts a
       LEFT JOIN (SELECT account_id, SUM(delta) s FROM ledger_entries GROUP BY account_id) e ON e.account_id=a.id
      WHERE a.balance <> COALESCE(e.s,0)`)).rows;
  const unbalanced = (await tx.query(`SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(delta) <> 0`)).rows;
  return { ok: total === 0 && drift.length === 0 && unbalanced.length === 0, total, driftedAccounts: drift.length, unbalancedTransactions: unbalanced.length };
}

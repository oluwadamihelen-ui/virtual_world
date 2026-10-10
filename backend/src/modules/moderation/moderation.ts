import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { badRequest, notFound } from '../../errors.js';
import { transfer, playerAccount, systemAccount, balanceOf, assertAmount } from '../economy/ledger.js';

export async function audit(tx: Pick<Tx, 'query'>, actorAccountId: string | null, action: string, targetType: string, targetId: string, detail: object) {
  await tx.query('INSERT INTO audit_log (actor_account_id,action,target_type,target_id,detail) VALUES ($1,$2,$3,$4,$5)',
    [actorAccountId, action, targetType, targetId, JSON.stringify(detail)]);
}

export async function fileReport(ctx: AppContext, reporterCharacterId: string, targetCharacterId: string, category: string, detail?: string) {
  if (reporterCharacterId === targetCharacterId) throw badRequest('cannot_report_self');
  const t = await ctx.pool.query('SELECT 1 FROM characters WHERE id=$1', [targetCharacterId]);
  if (t.rowCount === 0) throw notFound('character_not_found');
  const r = await ctx.pool.query(
    `INSERT INTO reports (reporter_character_id,target_character_id,category,detail,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [reporterCharacterId, targetCharacterId, category, detail ?? null, ctx.now()]);
  return { reportId: r.rows[0].id as string };
}

export async function listReports(ctx: AppContext, status: string) {
  const r = await ctx.pool.query(
    `SELECT r.*, rc.display_name AS reporter_name, tc.display_name AS target_name FROM reports r
       JOIN characters rc ON rc.id=r.reporter_character_id JOIN characters tc ON tc.id=r.target_character_id
      WHERE r.status=$1 ORDER BY r.created_at LIMIT 100`, [status]);
  return r.rows.map((x) => ({ reportId: x.id, reporter: x.reporter_name, target: x.target_name, targetCharacterId: x.target_character_id, category: x.category, detail: x.detail, status: x.status, createdAt: x.created_at }));
}

export type Resolution = { action: 'dismiss' } | { action: 'warn'; note: string } | { action: 'suspend'; hours: number; note: string } | { action: 'ban'; note: string };

/** Resolve a report. Every sanction is written to the audit log with the acting moderator. */
export async function resolveReport(ctx: AppContext, moderatorAccountId: string, reportId: string, res: Resolution) {
  return withTx(ctx.pool, async (tx) => {
    const rep = (await tx.query('SELECT * FROM reports WHERE id=$1 FOR UPDATE', [reportId])).rows[0];
    if (!rep) throw notFound('report_not_found');
    if (rep.status !== 'open') throw badRequest('report_already_resolved');
    const target = (await tx.query('SELECT account_id FROM characters WHERE id=$1', [rep.target_character_id])).rows[0];
    const note = 'note' in res ? res.note : null;
    if (res.action === 'suspend') {
      if (!(res.hours > 0 && res.hours <= 24 * 90)) throw badRequest('invalid_duration');
      await tx.query(`UPDATE accounts SET status='suspended', suspended_until=$2 WHERE id=$1 AND status <> 'banned'`,
        [target.account_id, new Date(ctx.now().getTime() + res.hours * 3600_000)]);
    } else if (res.action === 'ban') {
      await tx.query(`UPDATE accounts SET status='banned' WHERE id=$1`, [target.account_id]);
    }
    await tx.query(`UPDATE reports SET status=$2, resolved_by=$3, resolution=$4 WHERE id=$1`,
      [reportId, res.action === 'dismiss' ? 'dismissed' : 'actioned', moderatorAccountId, JSON.stringify(res)]);
    await audit(tx, moderatorAccountId, `report.${res.action}`, 'character', rep.target_character_id, { reportId, note });
    return { reportId, action: res.action };
  });
}

/** Lift a suspension early (appeal granted). Audited. */
export async function liftSanction(ctx: AppContext, moderatorAccountId: string, characterId: string, note: string) {
  return withTx(ctx.pool, async (tx) => {
    const t = (await tx.query('SELECT account_id FROM characters WHERE id=$1', [characterId])).rows[0];
    if (!t) throw notFound('character_not_found');
    await tx.query(`UPDATE accounts SET status='active', suspended_until=NULL WHERE id=$1`, [t.account_id]);
    await audit(tx, moderatorAccountId, 'sanction.lift', 'character', characterId, { note });
    return { characterId, status: 'active' };
  });
}

/**
 * Exceptional balance adjustment (admin only). Goes through the ledger like any other money movement,
 * against a dedicated adjustments account, with a mandatory reason and an audit entry.
 */
export async function adjustBalance(ctx: AppContext, adminAccountId: string, characterId: string, delta: number, reason: string, idempotencyKey: string) {
  if (!Number.isSafeInteger(delta) || delta === 0) throw badRequest('invalid_amount');
  assertAmount(Math.abs(delta));
  if (reason.trim().length < 10) throw badRequest('reason_required', 'A reason of at least 10 characters is required');
  return withTx(ctx.pool, async (tx) => {
    const exists = await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    if (exists.rowCount === 0) throw notFound('character_not_found');
    const adj = systemAccount('adjustments:admin');
    const out = await transfer(tx, {
      key: `admin-adjust:${idempotencyKey}`, type: 'admin_adjustment', actorCharacterId: characterId, referenceType: 'admin', referenceId: adminAccountId,
      from: delta > 0 ? adj : playerAccount(characterId), to: delta > 0 ? playerAccount(characterId) : adj,
      amount: Math.abs(delta), payload: { characterId, delta, reason },
    }, (txId) => ({ txId, delta }));
    if (!out.replay) await audit(tx, adminAccountId, 'admin.adjust_balance', 'character', characterId, { delta, reason, txId: out.response.txId });
    return { ...out.response, balance: await balanceOf(tx, characterId), replayed: out.replay };
  });
}

export async function listAudit(ctx: AppContext, limit = 100) {
  const r = await ctx.pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [Math.min(limit, 500)]);
  return r.rows;
}

import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { conflict, notFound } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { awardAchievement } from '../social/social.js';
import { transfer, playerAccount, systemAccount, balanceOf } from '../economy/ledger.js';

const HOUR = 3600_000;
const STALE_SHIFT_HOURS = 2;

export const listJobs = (ctx: AppContext) => ctx.data.jobs.map((j) => ({
  jobId: j.id, name: j.name, employer: j.employer, district: j.district, wagePerShift: j.wagePerShift,
  tasksPerShift: j.tasksPerShift, requirements: j.requirements,
}));

function jobOrThrow(ctx: AppContext, jobId: string) {
  const j = ctx.data.jobs.find((x) => x.id === jobId);
  if (!j) throw notFound('job_not_found');
  return j;
}

/** Start a shift. The server records the start time; the client cannot supply or alter it. */
export async function startShift(ctx: AppContext, characterId: string, jobId: string) {
  const job = jobOrThrow(ctx, jobId);
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const ch = (await tx.query('SELECT reputation FROM characters WHERE id=$1 FOR UPDATE', [characterId])).rows[0];
    const now = ctx.now();
    if (ch.reputation < job.requirements.minReputation) throw conflict('requirements_not_met', 'You do not meet this job\'s requirements');

    // Abandon a stale unfinished shift (player disconnected mid-shift); no wage, no penalty beyond losing progress.
    await tx.query(`UPDATE shifts SET status='abandoned' WHERE character_id=$1 AND status='in_progress' AND started_at < $2`,
      [characterId, new Date(now.getTime() - STALE_SHIFT_HOURS * HOUR)]);

    const recent = (await tx.query(
      `SELECT count(*)::int n FROM shifts WHERE character_id=$1 AND job_id=$2 AND status='completed' AND completed_at > $3`,
      [characterId, jobId, new Date(now.getTime() - 24 * HOUR)])).rows[0].n;
    if (recent >= job.maxShiftsPer24h) throw conflict('shift_limit_reached', 'You have reached the shift limit for today');

    const active = (await tx.query(`SELECT id FROM shifts WHERE character_id=$1 AND status='in_progress'`, [characterId])).rows[0];
    if (active) throw conflict('shift_in_progress', 'Finish or abandon your current shift first');

    const r = await tx.query(
      `INSERT INTO shifts (character_id,job_id,status,tasks_required,started_at) VALUES ($1,$2,'in_progress',$3,$4) RETURNING id`,
      [characterId, jobId, job.tasksPerShift, now]);
    return { shiftId: r.rows[0].id as string, jobId, tasksRequired: job.tasksPerShift, minSecondsPerTask: job.minSecondsPerTask };
  });
}

/**
 * Record one completed task. The game server calls this only after validating in-world conditions
 * (e.g. the character is at the workstation). The backend independently enforces pacing.
 */
export async function completeTask(ctx: AppContext, characterId: string, shiftId: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    const s = (await tx.query(`SELECT * FROM shifts WHERE id=$1 AND character_id=$2 FOR UPDATE`, [shiftId, characterId])).rows[0];
    if (!s) throw notFound('shift_not_found');
    if (s.status !== 'in_progress') throw conflict('shift_not_active');
    if (s.tasks_done >= s.tasks_required) throw conflict('all_tasks_done', 'All tasks already completed; complete the shift');
    const job = jobOrThrow(ctx, s.job_id);
    const now = ctx.now();
    const since = (s.last_task_at ?? s.started_at) as Date;
    const elapsed = (now.getTime() - since.getTime()) / 1000;
    if (elapsed < job.minSecondsPerTask) {
      throw conflict('task_too_fast', `Task cannot be completed yet (${Math.ceil(job.minSecondsPerTask - elapsed)}s remaining)`);
    }
    await tx.query('UPDATE shifts SET tasks_done = tasks_done + 1, last_task_at=$2 WHERE id=$1', [shiftId, now]);
    return { shiftId, tasksDone: s.tasks_done + 1, tasksRequired: s.tasks_required as number };
  });
}

/** Finish the shift and pay the wage once. Wage idempotency key is derived from the shift id, not from the client. */
export async function completeShift(ctx: AppContext, characterId: string, shiftId: string) {
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const s = (await tx.query(`SELECT * FROM shifts WHERE id=$1 AND character_id=$2 FOR UPDATE`, [shiftId, characterId])).rows[0];
    if (!s) throw notFound('shift_not_found');
    const job = jobOrThrow(ctx, s.job_id);
    if (s.status === 'completed') {
      return { shiftId, wage: s.wage_paid as number, balance: await balanceOf(tx, characterId), replayed: true };
    }
    if (s.status !== 'in_progress') throw conflict('shift_not_active');
    if (s.tasks_done < s.tasks_required) throw conflict('shift_incomplete', `${s.tasks_required - s.tasks_done} task(s) remaining`);

    const now = ctx.now();
    await transfer(tx, {
      key: `shift-wage:${shiftId}`, type: 'wage', actorCharacterId: characterId, referenceType: 'shift', referenceId: shiftId,
      from: systemAccount('faucet:npc_employers'), to: playerAccount(characterId), amount: job.wagePerShift, payload: { shiftId },
    }, (txId) => ({ txId }));
    await tx.query(`UPDATE shifts SET status='completed', completed_at=$2, wage_paid=$3 WHERE id=$1`, [shiftId, now, job.wagePerShift]);
    await tx.query(
      `INSERT INTO skills (character_id,skill_id,xp) VALUES ($1,$2,$3) ON CONFLICT (character_id,skill_id) DO UPDATE SET xp = skills.xp + EXCLUDED.xp`,
      [characterId, job.skill.id, job.skill.xpPerShift]);
    await awardAchievement(ctx, tx, characterId, 'first_shift');
    return { shiftId, wage: job.wagePerShift, balance: await balanceOf(tx, characterId), replayed: false };
  });
}

export async function abandonShift(ctx: AppContext, characterId: string, shiftId: string) {
  const r = await ctx.pool.query(`UPDATE shifts SET status='abandoned' WHERE id=$1 AND character_id=$2 AND status='in_progress' RETURNING id`, [shiftId, characterId]);
  if (r.rowCount === 0) throw notFound('shift_not_found');
  return { shiftId, status: 'abandoned' };
}

export async function employmentHistory(tx: Pick<Tx, 'query'>, characterId: string) {
  const r = await tx.query(
    `SELECT id,job_id,status,tasks_done,tasks_required,started_at,completed_at,wage_paid FROM shifts WHERE character_id=$1 ORDER BY started_at DESC LIMIT 50`, [characterId]);
  return r.rows.map((x) => ({ shiftId: x.id, jobId: x.job_id, status: x.status, tasksDone: x.tasks_done, tasksRequired: x.tasks_required, startedAt: x.started_at, completedAt: x.completed_at, wage: x.wage_paid }));
}

import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { badRequest, conflict } from '../../errors.js';
import { assertCanAct } from '../identity/service.js';
import { claim, post, finish, playerAccount, systemAccount } from '../economy/ledger.js';

/** Finish any course whose time is up: grant the credential and skill xp. Safe to call any time. */
export async function completeDue(ctx: AppContext, tx: Tx, characterId: string) {
  const now = ctx.now();
  const done = (await tx.query(`SELECT * FROM course_enrolments WHERE character_id=$1 AND status='studying' AND ready_at <= $2 FOR UPDATE`, [characterId, now])).rows;
  for (const e of done) {
    const c = ctx.data.life.courses.find((x) => x.id === e.course_id); if (!c) continue;
    await tx.query(`UPDATE course_enrolments SET status='done', completed_at=$2 WHERE id=$1`, [e.id, e.ready_at]);
    await tx.query('INSERT INTO credentials (character_id, credential_id, earned_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [characterId, c.credential, e.ready_at]);
    await tx.query(`INSERT INTO skills (character_id,skill_id,xp) VALUES ($1,$2,$3) ON CONFLICT (character_id,skill_id) DO UPDATE SET xp = skills.xp + EXCLUDED.xp`, [characterId, c.skill, c.xp]);
  }
  return done.length;
}
export async function hasCredential(ctx: AppContext, tx: Pick<Tx, 'query'>, characterId: string, credential: string) {
  return ((await tx.query('SELECT 1 FROM credentials WHERE character_id=$1 AND credential_id=$2', [characterId, credential])).rowCount ?? 0) > 0;
}

export async function overview(ctx: AppContext, characterId: string) {
  return withTx(ctx.pool, async (tx) => {
    await completeDue(ctx, tx, characterId);
    const rep = (await tx.query('SELECT reputation FROM characters WHERE id=$1', [characterId])).rows[0]?.reputation ?? 0;
    const have = new Set((await tx.query('SELECT credential_id FROM credentials WHERE character_id=$1', [characterId])).rows.map((r) => r.credential_id as string));
    const studying = (await tx.query(`SELECT course_id, ready_at FROM course_enrolments WHERE character_id=$1 AND status='studying'`, [characterId])).rows[0];
    const L = ctx.data.life;
    return {
      studying: studying ? { courseId: studying.course_id as string, readyAt: (studying.ready_at as Date).toISOString() } : null,
      credentials: [...have].map((id) => ({ id, name: L.credentials[id] ?? id })),
      courses: L.courses.map((c) => ({
        id: c.id, name: c.name, emoji: c.emoji, blurb: c.blurb, fee: c.fee, minutes: c.minutes, credential: L.credentials[c.credential],
        state: have.has(c.credential) ? 'done' : studying?.course_id === c.id ? 'studying' : rep < c.minReputation ? 'locked' : 'open', minReputation: c.minReputation,
      })),
      jobsUnlocked: ctx.data.jobs.filter((j) => j.requirements.credential).map((j) => ({ jobId: j.id, name: j.name, needs: L.credentials[j.requirements.credential!] ?? '', wage: j.wagePerShift })),
    };
  });
}

export async function enrol(ctx: AppContext, characterId: string, courseId: string, key: string) {
  const c = ctx.data.life.courses.find((x) => x.id === courseId);
  if (!c) throw badRequest('unknown_course');
  return withTx(ctx.pool, async (tx) => {
    await assertCanAct(ctx, tx, characterId);
    await tx.query('SELECT 1 FROM characters WHERE id=$1 FOR UPDATE', [characterId]);
    const k = await claim(tx, { key: `course:${key}`, type: 'tuition', actorCharacterId: characterId, referenceType: 'course', referenceId: c.id, amount: c.fee, payload: { course: c.id } });
    if (k.replay) return { courseId: c.id, replayed: true };
    await completeDue(ctx, tx, characterId);
    if (await hasCredential(ctx, tx, characterId, c.credential)) throw conflict('already_qualified', 'You already have this qualification.');
    const rep = (await tx.query('SELECT reputation FROM characters WHERE id=$1', [characterId])).rows[0].reputation as number;
    if (rep < c.minReputation) throw conflict('requirements_not_met', 'You need more reputation for this course.');
    if ((await tx.query(`SELECT 1 FROM course_enrolments WHERE character_id=$1 AND status='studying'`, [characterId])).rowCount) throw conflict('already_studying', 'Finish your current course first.');
    await post(tx, k.txId, [{ account: playerAccount(characterId), delta: -c.fee }, { account: systemAccount('sink:tuition'), delta: c.fee }]);
    await finish(tx, k.txId, { courseId: c.id });
    const now = ctx.now(), ready = new Date(now.getTime() + c.minutes * 60_000);
    await tx.query(`INSERT INTO course_enrolments (character_id, course_id, fee, started_at, ready_at) VALUES ($1,$2,$3,$4,$5)`, [characterId, c.id, c.fee, now, ready]);
    return { courseId: c.id, readyAt: ready.toISOString(), replayed: false };
  });
}

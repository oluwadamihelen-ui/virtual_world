import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { AppError } from '../../errors.js';
import { claim, post, finish, playerAccount, systemAccount, type SystemAccount } from '../economy/ledger.js';

const HOUR = 3600_000;

/** Charge premiums that have fallen due; a policy the player cannot afford lapses. Call at the start of anything that depends on cover. */
export async function settlePremiums(ctx: AppContext, tx: Tx, characterId: string) {
  const a = ctx.data.life.assurance, now = ctx.now();
  const due = (await tx.query(`SELECT * FROM policies WHERE character_id=$1 AND status='active' AND paid_until <= $2 ORDER BY paid_until FOR UPDATE`, [characterId, now])).rows;
  for (const p of due) {
    let until = new Date(p.paid_until), guard = 0;
    await tx.query('SAVEPOINT premium');          // a failed charge must not leave a half-made ledger transaction behind
    try {
      while (until <= now && guard++ < 8) {
        const next = new Date(until.getTime() + a.periodHours * HOUR);
        const c = await claim(tx, { key: `premium:${p.id}:${next.toISOString()}`, type: 'insurance_premium', actorCharacterId: characterId, referenceType: 'policy', referenceId: p.id, amount: Number(p.premium), payload: { policy: p.id, until: next.toISOString() } });
        if (!c.replay) await post(tx, c.txId, [{ account: playerAccount(characterId), delta: -Number(p.premium) }, { account: systemAccount('sink:insurance'), delta: Number(p.premium) }]);
        until = next;
      }
      await tx.query('UPDATE policies SET paid_until=$2 WHERE id=$1', [p.id, until]);
      await tx.query('RELEASE SAVEPOINT premium');
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'insufficient_funds') throw e;
      await tx.query('ROLLBACK TO SAVEPOINT premium');
      await tx.query(`UPDATE policies SET status='lapsed' WHERE id=$1`, [p.id]);
      await tx.query('RELEASE SAVEPOINT premium');     // could not pay: no cover until they buy it again
    }
  }
}

/** The share of a bill an active policy pays, 0 to 1. Cover starts after the waiting period so nobody insures after the accident. */
export async function coverShare(ctx: AppContext, tx: Tx, characterId: string, kind: 'health' | 'car', carId?: string): Promise<{ share: number; policyId: string | null }> {
  const a = ctx.data.life.assurance, now = ctx.now();
  const p = (await tx.query(`SELECT * FROM policies WHERE character_id=$1 AND kind=$2 AND status='active' AND ($3::uuid IS NULL OR car_id=$3) ORDER BY started_at LIMIT 1`, [characterId, kind, carId ?? null])).rows[0];
  if (!p || now.getTime() - new Date(p.started_at).getTime() < a.waitingHours * HOUR) return { share: 0, policyId: null };
  const plan = a.plans.find((x) => x.id === p.plan_id);
  return { share: plan ? plan.coverPercent / 100 : 0, policyId: p.id };
}

/**
 * Pay a bill (treatment, repair) to a system account. The insurer's share (if any) comes from faucet:insurer, the rest from the player,
 * in one balanced ledger transaction so the books always add up.
 */
export async function payBill(ctx: AppContext, tx: Tx, characterId: string, o: { amount: number; sink: SystemAccount; type: string; key: string; kind?: 'health' | 'car'; carId?: string; refId: string }) {
  await settlePremiums(ctx, tx, characterId);
  const { share, policyId } = o.kind ? await coverShare(ctx, tx, characterId, o.kind, o.carId) : { share: 0, policyId: null };
  const covered = Math.floor(o.amount * share), mine = o.amount - covered;
  const c = await claim(tx, { key: o.key, type: o.type, actorCharacterId: characterId, referenceType: 'bill', referenceId: o.refId, amount: o.amount, payload: { amount: o.amount, sink: o.sink, ref: o.refId } });
  if (c.replay) return { paid: mine, covered, replay: true };
  const postings = [{ account: playerAccount(characterId), delta: -mine }, { account: systemAccount(o.sink), delta: o.amount }];
  if (covered > 0) postings.push({ account: systemAccount('faucet:insurer'), delta: -covered });
  await post(tx, c.txId, postings);
  await finish(tx, c.txId, { paid: mine, covered, policyId });
  return { paid: mine, covered, replay: false };
}

export { withTx };

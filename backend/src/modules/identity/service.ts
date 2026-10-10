import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { withTx, type Tx } from '../../db.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../errors.js';
import { hashPassword, verifyPassword } from './password.js';
import { validateDisplayName } from './names.js';
import { transfer, playerAccount, systemAccount } from '../economy/ledger.js';

export const RegisterBody = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(200) });
export const CreateCharacterBody = z.object({
  displayName: z.string().max(60),
  appearance: z.object({
    bodyPreset: z.string(), skinTone: z.number().int(), hairstyle: z.string(), hairColor: z.string(), outfit: z.string(),
  }),
});

export async function register(ctx: AppContext, body: z.infer<typeof RegisterBody>) {
  const hash = await hashPassword(body.password);
  try {
    const r = await ctx.pool.query(
      'INSERT INTO accounts (email, password_hash, created_at) VALUES ($1,$2,$3) RETURNING id, role',
      [body.email, hash, ctx.now()],
    );
    return { accountId: r.rows[0].id as string, role: r.rows[0].role as 'player' };
  } catch (e: any) {
    if (e.code === '23505') throw conflict('email_taken', 'Unable to register with those details');
    throw e;
  }
}

export async function login(ctx: AppContext, email: string, password: string) {
  const r = await ctx.pool.query('SELECT id, password_hash, role, status, suspended_until FROM accounts WHERE lower(email)=lower($1)', [email]);
  const a = r.rows[0];
  // Verify even when the account is missing so timing does not reveal which emails exist.
  const ok = await verifyPassword(password, a?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
  if (!a || !ok) throw unauthorized('invalid_credentials');
  if (a.status === 'banned') throw forbidden('account_banned');
  return { accountId: a.id as string, role: a.role as 'player' | 'moderator' | 'admin' };
}

export async function createCharacter(ctx: AppContext, accountId: string, body: z.infer<typeof CreateCharacterBody>) {
  const ap = ctx.data.appearance;
  const a = body.appearance;
  if (!ap.bodyPresets.includes(a.bodyPreset) || !ap.skinTones.includes(a.skinTone) || !ap.hairstyles.includes(a.hairstyle)
    || !ap.hairColors.includes(a.hairColor) || !ap.outfits.includes(a.outfit)) {
    throw badRequest('invalid_appearance', 'Appearance option is not available');
  }
  const { name, key } = validateDisplayName(body.displayName, ctx.data.economy.displayName);
  return withTx(ctx.pool, async (tx) => {
    let id: string;
    try {
      const r = await tx.query(
        `INSERT INTO characters (account_id, display_name, display_name_key, appearance, created_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [accountId, name, key, JSON.stringify(a), ctx.now()],
      );
      id = r.rows[0].id;
    } catch (e: any) {
      if (e.code === '23505') throw conflict('display_name_taken', 'That display name is not available');
      throw e;
    }
    // Starting balance is a ledger transaction like any other: faucet:world -> player.
    await transfer(tx, {
      key: `starting-grant:${id}`, type: 'starting_grant', actorCharacterId: id, referenceType: 'character', referenceId: id,
      from: systemAccount('faucet:world'), to: playerAccount(id), amount: ctx.data.economy.startingBalance,
      payload: { id },
    }, (txId) => ({ txId, amount: ctx.data.economy.startingBalance }));
    return { characterId: id, displayName: name };
  });
}

export async function listCharacters(ctx: AppContext, accountId: string) {
  const r = await ctx.pool.query('SELECT id, display_name, appearance, created_at FROM characters WHERE account_id=$1 ORDER BY created_at', [accountId]);
  return r.rows.map((x) => ({ characterId: x.id, displayName: x.display_name, appearance: x.appearance, createdAt: x.created_at }));
}

export async function assertOwnsCharacter(ctx: AppContext, accountId: string, characterId: string) {
  const r = await ctx.pool.query('SELECT 1 FROM characters WHERE id=$1 AND account_id=$2', [characterId, accountId]);
  if (r.rowCount === 0) throw notFound('character_not_found');
}

/** Gate for every consequential gameplay action: character must exist and its account must be in good standing. */
export async function assertCanAct(ctx: AppContext, tx: Pick<Tx, 'query'>, characterId: string) {
  const r = await tx.query(
    `SELECT a.status, a.suspended_until FROM characters c JOIN accounts a ON a.id=c.account_id WHERE c.id=$1`,
    [characterId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('character_not_found');
  if (row.status === 'banned') throw forbidden('account_banned');
  if (row.status === 'suspended' && (!row.suspended_until || row.suspended_until > ctx.now())) throw forbidden('account_suspended');
}

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ZodError, z } from 'zod';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { authenticate, requireGameServer, requireRole, signToken } from './modules/identity/auth.js';
import * as identity from './modules/identity/service.js';
import * as shop from './modules/commerce/shop.js';
import * as housing from './modules/housing/housing.js';
import * as jobs from './modules/employment/jobs.js';
import * as mod from './modules/moderation/moderation.js';
import * as ledger from './modules/economy/ledger.js';
import { characterSummary } from './modules/summary.js';
import { withTx } from './db.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const uuid = z.string().uuid();
const Idem = z.object({ idempotencyKey: z.string().min(8).max(100) });

export async function buildApp(ctx: AppContext, opts: { rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: ctx.config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.authorization', 'req.headers["x-server-key"]'] }, bodyLimit: 64 * 1024 });

  if (opts.rateLimit !== false) {
    await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  }

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation_error', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error' }); // never leak internals
  });

  const player = (req: any) => authenticate(ctx.config, req);
  const gs = (req: any) => requireGameServer(ctx.config, req);

  app.get('/healthz', async () => {
    await ctx.pool.query('SELECT 1');
    return { status: 'ok' };
  });

  // Developer test console (browser buttons for the API). Never registered in production.
  if (ctx.config.NODE_ENV !== 'production') {
    const html = readFileSync(fileURLToPath(new URL('../public/dev.html', import.meta.url)), 'utf8');
    app.get('/dev', async (_req, reply) => reply.type('text/html; charset=utf-8').send(html));
  }

  // ---------- Account & character (player JWT) ----------
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post('/v1/auth/register', authLimit, async (req, reply) => {
    const r = await identity.register(ctx, identity.RegisterBody.parse(req.body));
    reply.status(201);
    return { accountId: r.accountId };
  });
  app.post('/v1/auth/login', authLimit, async (req) => {
    const b = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const u = await identity.login(ctx, b.email, b.password);
    return { token: await signToken(ctx.config, u), accountId: u.accountId, role: u.role };
  });
  app.post('/v1/characters', async (req, reply) => {
    const u = await player(req);
    const r = await identity.createCharacter(ctx, u.accountId, identity.CreateCharacterBody.parse(req.body));
    reply.status(201);
    return r;
  });
  app.get('/v1/characters', async (req) => ({ characters: await identity.listCharacters(ctx, (await player(req)).accountId) }));
  app.get('/v1/characters/:id/summary', async (req) => {
    const u = await player(req);
    const id = uuid.parse((req.params as any).id);
    await identity.assertOwnsCharacter(ctx, u.accountId, id);
    return characterSummary(ctx, id);
  });
  app.post('/v1/reports', async (req, reply) => {
    const u = await player(req);
    const b = z.object({ reporterCharacterId: uuid, targetCharacterId: uuid, category: z.enum(['harassment', 'cheating', 'scam', 'inappropriate_name', 'other']), detail: z.string().max(1000).optional() }).parse(req.body);
    await identity.assertOwnsCharacter(ctx, u.accountId, b.reporterCharacterId);
    reply.status(201);
    return mod.fileReport(ctx, b.reporterCharacterId, b.targetCharacterId, b.category, b.detail);
  });

  // ---------- Moderator / admin ----------
  app.get('/v1/mod/reports', async (req) => {
    requireRole(await player(req), 'moderator', 'admin');
    const status = z.enum(['open', 'actioned', 'dismissed']).default('open').parse((req.query as any).status);
    return { reports: await mod.listReports(ctx, status) };
  });
  app.post('/v1/mod/reports/:id/resolve', async (req) => {
    const u = await player(req);
    requireRole(u, 'moderator', 'admin');
    const res = z.discriminatedUnion('action', [
      z.object({ action: z.literal('dismiss') }),
      z.object({ action: z.literal('warn'), note: z.string().min(3).max(500) }),
      z.object({ action: z.literal('suspend'), hours: z.number().positive().max(24 * 90), note: z.string().min(3).max(500) }),
      z.object({ action: z.literal('ban'), note: z.string().min(3).max(500) }),
    ]).parse(req.body);
    if (res.action === 'ban') requireRole(u, 'admin');
    return mod.resolveReport(ctx, u.accountId, uuid.parse((req.params as any).id), res);
  });
  app.post('/v1/mod/characters/:id/lift-sanction', async (req) => {
    const u = await player(req);
    requireRole(u, 'moderator', 'admin');
    const b = z.object({ note: z.string().min(3).max(500) }).parse(req.body);
    return mod.liftSanction(ctx, u.accountId, uuid.parse((req.params as any).id), b.note);
  });
  app.post('/v1/admin/adjustments', async (req) => {
    const u = await player(req);
    requireRole(u, 'admin');
    const b = z.object({ characterId: uuid, delta: z.number().int(), reason: z.string(), idempotencyKey: z.string().min(8).max(100) }).parse(req.body);
    return mod.adjustBalance(ctx, u.accountId, b.characterId, b.delta, b.reason, b.idempotencyKey);
  });
  app.get('/v1/admin/audit', async (req) => {
    requireRole(await player(req), 'admin');
    return { entries: await mod.listAudit(ctx) };
  });
  app.get('/v1/admin/ledger-integrity', async (req) => {
    requireRole(await player(req), 'admin');
    return ledger.verifyLedgerIntegrity(ctx.pool);
  });

  // ---------- Game server API (x-server-key) ----------
  // Only the authoritative dedicated server calls these. Clients never do, so a modified client cannot mint MVC.
  const G = '/v1/game';
  app.get(`${G}/world/properties`, async (req) => { gs(req); return { properties: await housing.listProperties(ctx) }; });
  app.get(`${G}/world/jobs`, async (req) => { gs(req); return { jobs: jobs.listJobs(ctx) }; });
  app.get(`${G}/world/shops/:shopId`, async (req) => { gs(req); return shop.listShop(ctx, (req.params as any).shopId); });

  app.post(`${G}/characters/:id/join`, async (req) => {
    gs(req);
    const id = uuid.parse((req.params as any).id);
    await withTx(ctx.pool, (tx) => identity.assertCanAct(ctx, tx, id));
    await housing.sweepTenancies(ctx, id); // bring rent state up to date on (re)connect
    return characterSummary(ctx, id);
  });
  app.get(`${G}/characters/:id/summary`, async (req) => { gs(req); return characterSummary(ctx, uuid.parse((req.params as any).id)); });
  app.put(`${G}/characters/:id/position`, async (req) => {
    gs(req);
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ district: z.string().max(40), x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).parse(req.body);
    await ctx.pool.query('UPDATE characters SET district=$2,pos_x=$3,pos_y=$4,pos_z=$5 WHERE id=$1', [id, b.district, b.x, b.y, b.z]);
    return { ok: true };
  });
  app.get(`${G}/characters/:id/ledger`, async (req) => {
    gs(req);
    return { entries: await ledger.history(ctx.pool, uuid.parse((req.params as any).id), Number((req.query as any).limit) || 50) };
  });

  app.post(`${G}/characters/:id/shops/:shopId/purchase`, async (req) => {
    gs(req);
    const p = req.params as any;
    const b = Idem.extend({ itemId: z.string(), quantity: z.number().int() }).parse(req.body);
    return shop.purchase(ctx, uuid.parse(p.id), { shopId: p.shopId, ...b });
  });

  app.post(`${G}/characters/:id/rent`, async (req) => {
    gs(req);
    const b = Idem.extend({ propertyId: z.string() }).parse(req.body);
    return housing.rent(ctx, uuid.parse((req.params as any).id), b.propertyId, b.idempotencyKey);
  });
  app.get(`${G}/characters/:id/rent-history`, async (req) => { gs(req); return { payments: await housing.rentHistory(ctx, uuid.parse((req.params as any).id)) }; });
  app.get(`${G}/properties/:propertyId/access/:id`, async (req) => {
    gs(req);
    const p = req.params as any;
    return housing.checkAccess(ctx, p.propertyId, uuid.parse(p.id));
  });
  app.post(`${G}/characters/:id/furniture`, async (req) => {
    gs(req);
    const b = z.object({ itemId: z.string(), x: z.number(), y: z.number(), z: z.number(), yaw: z.number().optional() }).parse(req.body);
    return housing.placeFurniture(ctx, uuid.parse((req.params as any).id), b.itemId, b);
  });
  app.delete(`${G}/characters/:id/furniture/:furnitureId`, async (req) => {
    gs(req);
    const p = req.params as any;
    return housing.removeFurniture(ctx, uuid.parse(p.id), uuid.parse(p.furnitureId));
  });

  app.post(`${G}/characters/:id/shifts`, async (req) => {
    gs(req);
    const b = z.object({ jobId: z.string() }).parse(req.body);
    return jobs.startShift(ctx, uuid.parse((req.params as any).id), b.jobId);
  });
  app.post(`${G}/characters/:id/shifts/:shiftId/task`, async (req) => {
    gs(req);
    const p = req.params as any;
    return jobs.completeTask(ctx, uuid.parse(p.id), uuid.parse(p.shiftId));
  });
  app.post(`${G}/characters/:id/shifts/:shiftId/complete`, async (req) => {
    gs(req);
    const p = req.params as any;
    return jobs.completeShift(ctx, uuid.parse(p.id), uuid.parse(p.shiftId));
  });
  app.post(`${G}/characters/:id/shifts/:shiftId/abandon`, async (req) => {
    gs(req);
    const p = req.params as any;
    return jobs.abandonShift(ctx, uuid.parse(p.id), uuid.parse(p.shiftId));
  });
  app.get(`${G}/characters/:id/employment-history`, async (req) => { gs(req); return { shifts: await jobs.employmentHistory(ctx.pool, uuid.parse((req.params as any).id)) }; });

  return app;
}

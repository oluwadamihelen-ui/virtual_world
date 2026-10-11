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
import * as biz from './modules/commerce/business.js';
import * as trade from './modules/commerce/trade.js';
import * as social from './modules/social/social.js';
import * as tickets from './modules/identity/tickets.js';
import { withTx } from './db.js';
import { readFileSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';

const uuid = z.string().uuid();
const Idem = z.object({ idempotencyKey: z.string().min(8).max(100) });

export async function buildApp(ctx: AppContext, opts: { rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: ctx.config.NODE_ENV === 'test' ? false : { level: ctx.config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers["x-server-key"]'] }, bodyLimit: 64 * 1024 });

  if (opts.rateLimit !== false) {
    // The dedicated game server calls from ONE address at high volume, so requests carrying the correct server key are exempt.
    // Everyone else (players, attackers, wrong-key guessers) is limited per IP.
    await app.register(rateLimit, {
      global: true, max: 300, timeWindow: '1 minute',
      allowList: (req) => {
        if (req.method === 'GET' && /^\/(play|vendor|shared|mod)(\/|$)/.test(req.url)) return true; // static game files
        try { requireGameServer(ctx.config, req); return true; } catch { return false; }
      },
    });
  }

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'validation_error', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error' }); // never leak internals
  });

  // ---------- Browser game client (static files) ----------
  const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
  const staticOpts = { maxAge: ctx.config.NODE_ENV === 'production' ? '5m' : 0, index: ['index.html'] };
  await app.register(fastifyStatic, { root: here('../public/play'), prefix: '/play/', ...staticOpts });
  await app.register(fastifyStatic, { root: here('../shared'), prefix: '/shared/', decorateReply: false, maxAge: 0 });
  await app.register(fastifyStatic, { root: here('../node_modules/three/build'), prefix: '/vendor/three/', decorateReply: false, maxAge: '1d' });
  await app.register(fastifyStatic, { root: here('../node_modules/three/examples/jsm'), prefix: '/vendor/three-addons/', decorateReply: false, maxAge: '1d' });
  app.get('/', async (_req, reply) => reply.redirect('/play/'));
  app.get('/play', async (_req, reply) => reply.redirect('/play/')); // people type it without the final slash
  app.get('/v1/world', async () => ctx.data.world); // static scenery + zones; contains no secrets

  const player = (req: any) => authenticate(ctx.config, req);
  const gs = (req: any) => requireGameServer(ctx.config, req);

  app.get('/healthz', async () => {
    await ctx.pool.query('SELECT 1');
    return { status: 'ok' };
  });

  // Moderator console: static page, no secrets; every action is authenticated with the moderator's own login token.
  const modHtml = readFileSync(fileURLToPath(new URL('../public/mod.html', import.meta.url)), 'utf8');
  app.get('/mod', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(modHtml));

  // Developer test console (browser buttons for the API). Never registered in production.
  if (ctx.config.NODE_ENV !== 'production') {
    const html = readFileSync(fileURLToPath(new URL('../public/dev.html', import.meta.url)), 'utf8');
    app.get('/dev', async (_req, reply) => reply.type('text/html; charset=utf-8').send(html));

    // Dev-only cheats so a tester can reach business features quickly. Not registered when NODE_ENV=production.
    app.post('/v1/dev/grant', async (req) => {
      gs(req);
      const b = z.object({ characterId: uuid, amount: z.number().int().min(1).max(10_000) }).parse(req.body);
      return withTx(ctx.pool, async (tx) => {
        const out = await ledger.transfer(tx, {
          key: `dev-grant:${crypto.randomUUID()}`, type: 'dev_grant', actorCharacterId: b.characterId,
          from: ledger.systemAccount('faucet:world'), to: ledger.playerAccount(b.characterId), amount: b.amount, payload: b,
        }, (txId) => ({ txId }));
        await mod.audit(tx, null, 'dev.grant', 'character', b.characterId, { amount: b.amount });
        return { ...out.response, balance: await ledger.balanceOf(tx, b.characterId) };
      });
    });
    app.post('/v1/dev/run-customers', async (req) => {
      gs(req);
      return biz.simulateNpcCustomers(ctx, 'dev-' + crypto.randomUUID());
    });
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
  app.get('/v1/me', async (req) => identity.accountInfo(ctx, (await player(req)).accountId));
  app.post('/v1/me/birthdate', async (req) => {
    const u = await player(req);
    return identity.setBirthDate(ctx, u.accountId, z.object({ birthDate: identity.BirthDate }).parse(req.body).birthDate);
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
      z.object({ action: z.literal('mute'), hours: z.number().positive().max(24 * 30), note: z.string().min(3).max(500) }),
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

  const joinCharacter = async (id: string) => {
    await withTx(ctx.pool, (tx) => identity.assertCanAct(ctx, tx, id));
    await housing.sweepTenancies(ctx, id); // bring rent state up to date on (re)connect
    return characterSummary(ctx, id);
  };
  // Join by bare character id: convenience for dev/test only. In production the ONLY way in is a redeemed ticket (below),
  // so a compromised or buggy game-server path cannot be tricked into trusting a client-supplied characterId.
  if (ctx.config.NODE_ENV !== 'production') {
    app.post(`${G}/characters/:id/join`, async (req) => { gs(req); return joinCharacter(uuid.parse((req.params as any).id)); });
  }
  // Ticket flow: the client proves character ownership; the server redeems the single-use ticket.
  app.post('/v1/characters/:id/join-ticket', async (req) => {
    const u = await player(req);
    const id = uuid.parse((req.params as any).id);
    await identity.assertOwnsCharacter(ctx, u.accountId, id);
    await withTx(ctx.pool, (tx) => identity.assertCanAct(ctx, tx, id));
    return tickets.issueTicket(ctx, u.accountId, id);
  });
  app.post(`${G}/tickets/redeem`, async (req) => {
    gs(req);
    const b = z.object({ ticket: z.string().min(20).max(2000) }).parse(req.body);
    const t = await tickets.redeemTicket(ctx, b.ticket);
    return joinCharacter(t.characterId);
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

  // ---------- Businesses ----------
  const bid = (req: any) => uuid.parse(req.params.bid);
  app.get(`${G}/world/premises`, async (req) => { gs(req); return { premises: await biz.listPremises(ctx) }; });
  app.get(`${G}/world/businesses`, async (req) => { gs(req); return { businesses: await biz.listBusinesses(ctx, (req.query as any).district) }; });
  app.get(`${G}/world/businesses/:bid`, async (req) => { gs(req); return biz.viewBusiness(ctx, bid(req)); });
  app.post(`${G}/characters/:id/businesses`, async (req) => {
    gs(req);
    const b = Idem.extend({ premisesId: z.string(), type: z.string(), name: z.string().max(60) }).parse(req.body);
    return biz.openBusiness(ctx, uuid.parse((req.params as any).id), b);
  });
  app.post(`${G}/characters/:id/businesses/:bid/fund`, async (req) => {
    gs(req);
    const b = Idem.extend({ direction: z.enum(['deposit', 'withdraw']), amount: z.number().int() }).parse(req.body);
    return biz.fundBusiness(ctx, uuid.parse((req.params as any).id), bid(req), b.direction, b.amount, b.idempotencyKey);
  });
  app.post(`${G}/characters/:id/businesses/:bid/restock`, async (req) => {
    gs(req);
    const b = Idem.extend({ itemId: z.string(), quantity: z.number().int() }).parse(req.body);
    return biz.restock(ctx, uuid.parse((req.params as any).id), bid(req), b.itemId, b.quantity, b.idempotencyKey);
  });
  app.put(`${G}/characters/:id/businesses/:bid/prices`, async (req) => {
    gs(req);
    const b = z.object({ itemId: z.string(), price: z.number().int() }).parse(req.body);
    return biz.setPrice(ctx, uuid.parse((req.params as any).id), bid(req), b.itemId, b.price);
  });
  app.get(`${G}/characters/:id/businesses/:bid/report`, async (req) => { gs(req); return biz.report(ctx, uuid.parse((req.params as any).id), bid(req)); });
  app.post(`${G}/characters/:id/businesses/:bid/close`, async (req) => {
    gs(req);
    const b = Idem.parse(req.body);
    return biz.closeBusiness(ctx, uuid.parse((req.params as any).id), bid(req), b.idempotencyKey);
  });
  app.post(`${G}/characters/:id/business-purchase/:bid`, async (req) => {
    gs(req);
    const b = Idem.extend({ itemId: z.string(), quantity: z.number().int() }).parse(req.body);
    return biz.purchaseFromBusiness(ctx, uuid.parse((req.params as any).id), bid(req), b);
  });

  // ---------- Player-to-player trading ----------
  const tid = (req: any) => uuid.parse(req.params.tid);
  app.post(`${G}/characters/:id/trades`, async (req) => {
    gs(req);
    const b = z.object({ partnerId: uuid }).parse(req.body);
    return trade.openTrade(ctx, uuid.parse((req.params as any).id), b.partnerId);
  });
  app.get(`${G}/characters/:id/trades/:tid`, async (req) => { gs(req); return trade.viewTrade(ctx, uuid.parse((req.params as any).id), tid(req)); });
  app.put(`${G}/characters/:id/trades/:tid/offer`, async (req) => {
    gs(req);
    const b = z.object({ mvc: z.number().int(), items: z.array(z.object({ itemId: z.string(), quantity: z.number().int() })).max(20) }).parse(req.body);
    return trade.setOffer(ctx, uuid.parse((req.params as any).id), tid(req), b);
  });
  app.post(`${G}/characters/:id/trades/:tid/confirm`, async (req) => {
    gs(req);
    const b = z.object({ version: z.number().int() }).parse(req.body);
    return trade.confirmTrade(ctx, uuid.parse((req.params as any).id), tid(req), b.version);
  });
  app.post(`${G}/characters/:id/trades/:tid/cancel`, async (req) => { gs(req); return trade.cancelTrade(ctx, uuid.parse((req.params as any).id), tid(req)); });

  // ---------- Social safety (block / chat check) ----------
  app.get(`${G}/characters/:id/blocks`, async (req) => { gs(req); return { blocked: await social.listBlocks(ctx, uuid.parse((req.params as any).id)) }; });
  app.post(`${G}/characters/:id/blocks`, async (req) => {
    gs(req);
    const b = z.object({ targetCharacterId: uuid }).parse(req.body);
    return social.block(ctx, uuid.parse((req.params as any).id), b.targetCharacterId);
  });
  app.delete(`${G}/characters/:id/blocks/:targetId`, async (req) => {
    gs(req);
    const p = req.params as any;
    return social.unblock(ctx, uuid.parse(p.id), uuid.parse(p.targetId));
  });
  app.get(`${G}/social/blocked/:a/:b`, async (req) => {
    gs(req);
    const p = req.params as any;
    return { blocked: await social.isBlockedEitherWay(ctx, uuid.parse(p.a), uuid.parse(p.b)) };
  });
  app.post(`${G}/chat/check`, async (req) => {
    gs(req);
    const b = z.object({ characterId: uuid, text: z.string().max(2000) }).parse(req.body);
    return social.checkChat(ctx, b.characterId, b.text);
  });

  return app;
}

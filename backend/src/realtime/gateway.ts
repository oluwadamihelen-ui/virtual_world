import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { redeemTicket } from '../modules/identity/tickets.js';
import { characterSummary } from '../modules/summary.js';
import * as housing from '../modules/housing/housing.js';
import * as jobs from '../modules/employment/jobs.js';
import * as shop from '../modules/commerce/shop.js';
import * as social from '../modules/social/social.js';
import * as moderation from '../modules/moderation/moderation.js';
import * as ledger from '../modules/economy/ledger.js';
import { buildColliders, stepPlayer, dist2, isBlocked, type Colliders } from '../../shared/sim.mjs';

/**
 * The game server: authoritative real-time layer between browsers and the backend services.
 *
 *  - Browsers never hold the server key and never send positions: they send a movement DIRECTION; this server runs the
 *    shared physics (walls, speed cap, tenant-only door) and tells everyone where everybody is.
 *  - Every consequential action (rent, buy, work) is validated for proximity here, then executed through the same
 *    transactional services as the REST API. The client only ever receives confirmed results.
 *  - Identity comes from a single-use join ticket (see tickets.ts), never from a client-supplied id.
 */

const TICK_HZ = 20;
const SNAPSHOT_EVERY = 2;                 // ticks -> 10 Hz
const INTEREST_RADIUS = 80;               // metres
const CHAT_RADIUS = 25;
const INTERACT_SLACK = 1.2;               // metres of latency tolerance on top of a zone's radius
const INPUT_STALE_MS = 700;               // no input for this long -> stop (prevents runaway on dropped packets)
const SAVE_EVERY_MS = 15_000;
const MAX_CONN_PER_IP = 8;
const EMOTES = new Set(['wave', 'dance', 'laugh', 'heart', 'thumbs']);

const Msg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), seq: z.number().int().min(0), dx: z.number().min(-1).max(1), dz: z.number().min(-1).max(1), run: z.boolean().optional() }),
  z.object({ t: z.literal('chat'), text: z.string().max(400) }),
  z.object({ t: z.literal('emote'), e: z.string().max(20) }),
  z.object({ t: z.literal('interact'), zone: z.string().max(60), item: z.string().max(60).optional() }),
  z.object({ t: z.literal('shopinfo'), zone: z.string().max(60) }),
  z.object({ t: z.literal('phone'), tab: z.enum(['wallet', 'jobs', 'achievements']) }),
  z.object({ t: z.literal('home') }),
  z.object({ t: z.literal('report'), targetId: z.string().uuid(), category: z.enum(['harassment', 'cheating', 'scam', 'inappropriate_name', 'other']), detail: z.string().max(500).optional() }),
  z.object({ t: z.literal('block'), targetId: z.string().uuid() }),
  z.object({ t: z.literal('unblock'), targetId: z.string().uuid() }),
  z.object({ t: z.literal('ping'), c: z.number().optional() }),
]);

interface Body { x: number; z: number; ry: number; moving: boolean }
interface Player extends Body {
  id: string; name: string; appearance: unknown; ws: WebSocket; ip: string;
  input: { dx: number; dz: number; run: boolean }; seq: number; lastInputAt: number;
  access: Set<string>; busy: boolean; lastActAt: number; lastEmoteAt: number;
  known: Set<string>; budget: number; budgetAt: number; strikes: number; dirty: boolean; lastSave: number;
  emote: string | null; emoteUntil: number;
}
interface Npc extends Body { id: string; name: string; appearance: unknown; route: { x: number; z: number }[]; leg: number; dir: 1 | -1; loop: boolean }

const NPC_APPEARANCES = [
  { bodyPreset: 'body_a', skinTone: 1, hairstyle: 'short', hairColor: 'black', outfit: 'casual_1' },
  { bodyPreset: 'body_b', skinTone: 4, hairstyle: 'long', hairColor: 'brown', outfit: 'casual_2' },
  { bodyPreset: 'body_c', skinTone: 6, hairstyle: 'curly', hairColor: 'black', outfit: 'work_1' },
  { bodyPreset: 'body_d', skinTone: 3, hairstyle: 'bun', hairColor: 'blonde', outfit: 'smart_1' },
  { bodyPreset: 'body_a', skinTone: 5, hairstyle: 'braids', hairColor: 'black', outfit: 'casual_1' },
  { bodyPreset: 'body_b', skinTone: 2, hairstyle: 'buzz', hairColor: 'grey', outfit: 'casual_2' },
];

const FRIENDLY: Record<string, string> = {
  insufficient_funds: 'Not enough MVC.', out_of_stock: 'Sold out.', property_unavailable: 'Someone else already rents that room.',
  tenancy_limit: 'You already rent a home.', shift_limit_reached: 'You have worked enough shifts for today.',
  shift_in_progress: 'Finish your current shift first.', requirements_not_met: 'You do not meet this job\'s requirements yet.',
};

export class Gateway {
  readonly players = new Map<string, Player>();
  readonly npcs: Npc[] = [];
  private wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private colliders: Colliders;
  private timer?: NodeJS.Timeout;
  private tick = 0;
  private connsByIp = new Map<string, number>();
  private world: any;

  constructor(private ctx: AppContext) {
    this.world = ctx.data.world;
    this.colliders = buildColliders(this.world);
    this.world.npcRoutes.forEach((route: { x: number; z: number }[], i: number) => {
      const a = route[0]!;
      this.npcs.push({
        id: `npc-${i + 1}`, name: 'Resident', appearance: NPC_APPEARANCES[i % NPC_APPEARANCES.length],
        x: a.x, z: a.z, ry: 0, moving: true, route, leg: 1 % route.length, dir: 1, loop: route.length > 2,
      });
    });
  }

  // ------------------------------------------------------------------ lifecycle
  attach(server: HttpServer) {
    server.on('upgrade', (req, socket, head) => { void this.onUpgrade(req, socket, head); });
  }
  start() { this.timer = setInterval(() => this.step(1 / TICK_HZ), 1000 / TICK_HZ); this.timer.unref?.(); }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.players.values()].map((p) => this.save(p).catch(() => {})));
    for (const p of this.players.values()) p.ws.close(1001, 'server shutting down');
    this.wss.close();
  }

  private reject(socket: Duplex, status: number, text: string) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private async onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws') { socket.destroy(); return; }
      // Same-origin check (blocks cross-site WebSocket hijacking from other web pages).
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return this.reject(socket, 403, 'Forbidden');
      const ip = req.socket.remoteAddress ?? '?';
      if ((this.connsByIp.get(ip) ?? 0) >= MAX_CONN_PER_IP) return this.reject(socket, 429, 'Too Many Connections');
      const ticket = url.searchParams.get('ticket') ?? '';
      let id: string;
      try { id = (await redeemTicket(this.ctx, ticket)).characterId; } catch { return this.reject(socket, 401, 'Unauthorized'); }
      this.wss.handleUpgrade(req, socket, head, (ws) => { void this.onConnection(ws, id, ip); });
    } catch { socket.destroy(); }
  }

  // ------------------------------------------------------------------ connection
  private async onConnection(ws: WebSocket, id: string, ip: string) {
    try {
      const prev = this.players.get(id);
      if (prev) { this.players.delete(id); prev.ws.close(4000, 'logged in elsewhere'); }

      await housing.sweepTenancies(this.ctx, id);
      const summary = await characterSummary(this.ctx, id);
      const spawnX = summary.location.x, spawnZ = summary.location.z;
      const hasHome = !!summary.tenancy;
      const access = new Set<string>(hasHome ? ['apartment'] : []);
      const bounds = this.world.bounds;
      const saved = summary.location.district === this.world.district.id && !(spawnX === 0 && spawnZ === 0)
        && !isBlocked(spawnX, spawnZ, this.colliders, (g) => access.has(g), bounds);
      const p: Player = {
        id, name: summary.displayName, appearance: summary.appearance, ws, ip,
        x: saved ? spawnX : this.world.spawn.x, z: saved ? spawnZ : this.world.spawn.z, ry: 0, moving: false,
        input: { dx: 0, dz: 0, run: false }, seq: 0, lastInputAt: Date.now(), access, busy: false, lastActAt: 0, lastEmoteAt: 0,
        known: new Set(), budget: 120, budgetAt: Date.now(), strikes: 0, dirty: false, lastSave: Date.now(), emote: null, emoteUntil: 0,
      };
      this.players.set(id, p);
      this.connsByIp.set(ip, (this.connsByIp.get(ip) ?? 0) + 1);

      ws.on('message', (data) => { void this.onMessage(p, data.toString()); });
      ws.on('close', () => { void this.onClose(p); });
      ws.on('error', () => {});

      this.send(p, {
        t: 'welcome', you: { id, name: p.name, appearance: p.appearance, x: p.x, z: p.z }, world: this.world,
        summary, door: await this.doorInfo(p, summary), serverNow: Date.now(), tickHz: TICK_HZ,
        achievements: this.ctx.data.achievements, jobs: jobs.listJobs(this.ctx),
      });
      this.sendSnapshot(p);
    } catch (err) {
      ws.close(1011, 'join failed');
    }
  }

  private async onClose(p: Player) {
    this.connsByIp.set(p.ip, Math.max(0, (this.connsByIp.get(p.ip) ?? 1) - 1));
    if (this.players.get(p.id) === p) {
      this.players.delete(p.id);
      await this.save(p).catch(() => {});
    }
  }

  private async save(p: Player) {
    p.dirty = false; p.lastSave = Date.now();
    await this.ctx.pool.query('UPDATE characters SET district=$2,pos_x=$3,pos_y=0,pos_z=$4 WHERE id=$1', [p.id, this.world.district.id, p.x, p.z]);
  }

  // ------------------------------------------------------------------ messages
  private send(p: Player, msg: unknown) { if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg)); }
  private toast(p: Player, kind: 'ok' | 'error' | 'info', text: string) { this.send(p, { t: 'toast', kind, text }); }

  private async onMessage(p: Player, raw: string) {
    // token bucket: ~60 msgs/s sustained, bursts to 120
    const now = Date.now();
    p.budget = Math.min(120, p.budget + ((now - p.budgetAt) / 1000) * 60); p.budgetAt = now;
    if (--p.budget < 0) { p.ws.close(4008, 'rate limit'); return; }

    let m: z.infer<typeof Msg>;
    try { m = Msg.parse(JSON.parse(raw)); } catch { if (++p.strikes > 20) p.ws.close(4009, 'bad messages'); return; }
    try {
      switch (m.t) {
        case 'input': {
          if (m.seq < p.seq) return; // stale
          p.seq = m.seq; p.input = { dx: m.dx, dz: m.dz, run: !!m.run }; p.lastInputAt = now; return;
        }
        case 'ping': this.send(p, { t: 'pong', c: m.c ?? 0, serverNow: now }); return;
        case 'chat': return await this.onChat(p, m.text);
        case 'emote': return this.onEmote(p, m.e);
        case 'interact': return await this.onInteract(p, m.zone, m.item);
        case 'shopinfo': return await this.onShopInfo(p, m.zone);
        case 'phone': return await this.onPhone(p, m.tab);
        case 'home': return await this.onHome(p);
        case 'report': {
          const r = await moderation.fileReport(this.ctx, p.id, m.targetId, m.category, m.detail);
          this.toast(p, 'ok', 'Report sent. Thank you, a moderator will review it.'); void r; return;
        }
        case 'block': await social.block(this.ctx, p.id, m.targetId); this.toast(p, 'ok', 'Player blocked.'); return;
        case 'unblock': await social.unblock(this.ctx, p.id, m.targetId); this.toast(p, 'ok', 'Player unblocked.'); return;
      }
    } catch (err) {
      this.toast(p, 'error', this.friendly(err));
    }
  }

  private friendly(err: unknown): string {
    if (err instanceof AppError) return FRIENDLY[err.code] ?? (err.message && err.message !== err.code ? err.message : err.code.replace(/_/g, ' '));
    return 'Something went wrong. Please try again.';
  }

  private nearby(p: Body, radius: number): Player[] {
    return [...this.players.values()].filter((o) => dist2(p.x, p.z, o.x, o.z) <= radius);
  }

  private async onChat(p: Player, text: string) {
    const r = await social.checkChat(this.ctx, p.id, text);
    if (!r.allowed) {
      const why: Record<string, string> = { muted: 'You are muted right now.', too_long: 'That message is too long.', empty: '', rate_limited: 'Slow down a little.' };
      if (why[r.reason]) this.toast(p, 'info', why[r.reason]!);
      return;
    }
    const msg = { t: 'chat', id: p.id, name: p.name, text: r.text, ts: Date.now() };
    for (const o of this.nearby(p, CHAT_RADIUS)) {
      if (o.id !== p.id && await social.isBlockedEitherWay(this.ctx, p.id, o.id)) continue;
      this.send(o, msg);
    }
  }

  private onEmote(p: Player, e: string) {
    const now = Date.now();
    if (!EMOTES.has(e) || now - p.lastEmoteAt < 800) return;
    p.lastEmoteAt = now; p.emote = e; p.emoteUntil = now + 3000;
    for (const o of this.nearby(p, CHAT_RADIUS)) this.send(o, { t: 'emote', id: p.id, e });
  }

  // ------------------------------------------------------------------ interactions (server-validated)
  private zoneFor(p: Player, zoneId: string) {
    const zone = this.world.zones.find((z: any) => z.id === zoneId);
    if (!zone) throw new AppError(404, 'unknown_zone');
    if (dist2(p.x, p.z, zone.x, zone.z) > zone.radius + INTERACT_SLACK) throw new AppError(409, 'too_far', 'You are too far away.');
    return zone;
  }

  private async refresh(p: Player) {
    const summary = await characterSummary(this.ctx, p.id);
    p.access = new Set(summary.tenancy ? ['apartment'] : []);
    this.send(p, { t: 'summary', summary, door: await this.doorInfo(p, summary) });
    return summary;
  }

  private async doorInfo(_p: Player, summary: { tenancy: { propertyName: string } | null }) {
    if (summary.tenancy) return { state: 'tenant', name: summary.tenancy.propertyName };
    const free = (await housing.listProperties(this.ctx)).find((x) => x.available && x.type === 'room');
    return free ? { state: 'free', propertyId: free.propertyId, name: free.name, rent: free.rentPerPeriod } : { state: 'full' };
  }

  private async onInteract(p: Player, zoneId: string, item?: string) {
    const now = Date.now();
    if (p.busy || now - p.lastActAt < 250) return;
    p.busy = true; p.lastActAt = now;
    try {
      const zone = this.zoneFor(p, zoneId);
      if (zone.kind === 'door') {
        const summary = await characterSummary(this.ctx, p.id);
        if (summary.tenancy) { p.access.add('apartment'); this.toast(p, 'ok', `Welcome home! ${summary.tenancy.propertyName} is unlocked for you.`); }
        else {
          const info = await this.doorInfo(p, summary);
          if (info.state !== 'free') throw new AppError(409, 'no_rooms', 'No rooms are free right now.');
          const r = await housing.rent(this.ctx, p.id, info.propertyId!, randomUUID());
          p.access.add('apartment');
          this.toast(p, 'ok', `You rented ${info.name} for ${r.rentPaid} MVC. The door is unlocked.`);
        }
      } else if (zone.kind === 'shop') {
        const choice = zone.items.find((i: any) => i.itemId === item);
        if (!choice) throw new AppError(400, 'unknown_item', 'They do not sell that here.');
        const r = await shop.purchase(this.ctx, p.id, { shopId: zone.shopId, itemId: choice.itemId, quantity: 1, idempotencyKey: randomUUID() });
        this.toast(p, 'ok', `Bought ${choice.label} for ${r.totalPrice} MVC.`);
      } else if (zone.kind === 'work') {
        const summary = await characterSummary(this.ctx, p.id);
        if (!summary.activeShift) {
          const s = await jobs.startShift(this.ctx, p.id, zone.jobId);
          this.toast(p, 'ok', `Shift started: ${s.tasksRequired} tasks, about ${s.minSecondsPerTask}s apart.`);
        } else {
          const t = await jobs.completeTask(this.ctx, p.id, summary.activeShift.shiftId);
          if (t.tasksDone >= t.tasksRequired) {
            const c = await jobs.completeShift(this.ctx, p.id, summary.activeShift.shiftId);
            this.toast(p, 'ok', `Shift complete! You earned ${c.wage} MVC.`);
          } else this.toast(p, 'ok', `Task ${t.tasksDone} of ${t.tasksRequired} done.`);
        }
      }
      await this.refresh(p);
    } catch (err) {
      this.toast(p, 'error', this.friendly(err));
    } finally { p.busy = false; }
  }

  private async onShopInfo(p: Player, zoneId: string) {
    const zone = this.zoneFor(p, zoneId);
    if (zone.kind !== 'shop') return;
    const s = await shop.listShop(this.ctx, zone.shopId);
    this.send(p, { t: 'shopinfo', zone: zoneId, items: zone.items.map((i: any) => ({ ...i, price: s.stock.find((x) => x.itemId === i.itemId)?.price ?? null })) });
  }

  private async onHome(p: Player) {
    const summary = await characterSummary(this.ctx, p.id);
    if (!summary.tenancy) throw new AppError(409, 'no_home', 'You do not rent a home yet. Visit Maple Court Apartments.');
    const apt = this.world.buildings.find((b: any) => b.id === 'apt');
    p.access.add('apartment');
    p.x = apt.cx; p.z = apt.cz + 1.5; p.moving = false; p.dirty = true;
    this.toast(p, 'ok', 'Welcome home.');
  }

  private async onPhone(p: Player, tab: 'wallet' | 'jobs' | 'achievements') {
    if (tab === 'wallet') {
      const rows = await ledger.history(this.ctx.pool, p.id, 30);
      this.send(p, { t: 'phone', tab, data: rows.map((r) => ({ type: r.type, delta: r.delta, balance: r.balance_after, at: r.created_at })) });
    } else if (tab === 'jobs') {
      const hist = await jobs.employmentHistory(this.ctx.pool, p.id);
      this.send(p, { t: 'phone', tab, data: { jobs: jobs.listJobs(this.ctx), history: hist.slice(0, 10) } });
    } else {
      const s = await characterSummary(this.ctx, p.id);
      this.send(p, { t: 'phone', tab, data: { reputation: s.reputation, achievements: this.ctx.data.achievements.map((a) => ({ ...a, earned: s.achievements.some((x) => x.achievementId === a.id) })), skills: s.skills } });
    }
  }

  // ------------------------------------------------------------------ simulation
  /** One simulation tick. Public so tests can drive time deterministically. */
  step(dt: number) {
    const now = Date.now();
    this.tick++;
    for (const p of this.players.values()) {
      const input = now - p.lastInputAt > INPUT_STALE_MS ? { dx: 0, dz: 0, run: false } : p.input;
      const before = p.x * 1e3 + p.z;
      stepPlayer(p, input, dt, this.colliders, (g) => p.access.has(g), this.world.bounds);
      if (p.x * 1e3 + p.z !== before) p.dirty = true;
      if (p.emote && now > p.emoteUntil) p.emote = null;
      if (p.dirty && now - p.lastSave > SAVE_EVERY_MS) void this.save(p).catch(() => {});
    }
    for (const n of this.npcs) this.stepNpc(n, dt);
    if (this.tick % SNAPSHOT_EVERY === 0) for (const p of this.players.values()) this.sendSnapshot(p);
  }

  private stepNpc(n: Npc, dt: number) {
    const target = n.route[n.leg]!;
    const dx = target.x - n.x, dz = target.z - n.z, d = Math.hypot(dx, dz);
    const step = 1.5 * dt;
    if (d <= step) {
      n.x = target.x; n.z = target.z;
      if (n.loop) n.leg = (n.leg + 1) % n.route.length;
      else { if (n.leg + n.dir < 0 || n.leg + n.dir >= n.route.length) n.dir = n.dir === 1 ? -1 : 1; n.leg += n.dir; }
    } else { n.x += (dx / d) * step; n.z += (dz / d) * step; n.ry = Math.atan2(dx, dz); }
    n.moving = true;
  }

  private sendSnapshot(p: Player) {
    const ps: unknown[] = [];
    const spawns: unknown[] = [];
    const seen = new Set<string>();
    const consider = (o: Body & { id: string; name: string; appearance: unknown }, npc: boolean, emote: string | null) => {
      if (o.id === p.id || dist2(p.x, p.z, o.x, o.z) > INTEREST_RADIUS) return;
      seen.add(o.id);
      if (!p.known.has(o.id)) { p.known.add(o.id); spawns.push({ id: o.id, name: npc ? null : o.name, appearance: o.appearance, npc }); }
      ps.push([o.id, +o.x.toFixed(2), +o.z.toFixed(2), +o.ry.toFixed(2), o.moving ? 1 : 0, emote ?? 0]);
    };
    for (const o of this.players.values()) consider(o, false, o.emote);
    for (const n of this.npcs) consider(n, true, null);
    const gone: string[] = [];
    for (const id of p.known) if (!seen.has(id)) { gone.push(id); p.known.delete(id); }
    this.send(p, { t: 'snap', tick: this.tick, ack: p.seq, you: [+p.x.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2)], ps, spawns, gone, online: this.players.size });
  }
}

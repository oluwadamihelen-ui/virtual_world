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
import * as travel from '../modules/travel/travel.js';
import { handleApp, phoneInfo } from '../modules/phone/index.js';
import { currencyOfCity, formatMoney } from '../modules/economy/currency.js';
import { builtHouseSpec } from '../world/cities.js';
import { districtAt } from '../world/metro.js';
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
  z.object({ t: z.literal('quote'), to: z.string().max(40) }),
  z.object({ t: z.literal('travel'), to: z.string().max(40), mode: z.string().max(20) }),
  z.object({ t: z.literal('app'), rid: z.string().max(40), app: z.string().max(20), a: z.string().max(30), d: z.record(z.string(), z.unknown()).optional() }),
  z.object({ t: z.literal('ping'), c: z.number().optional() }),
]);

interface Body { x: number; z: number; ry: number; moving: boolean }
interface Player extends Body {
  id: string; city: string; metro: string; travel: { to: string; until: number; mode: string } | null; name: string; appearance: unknown; ws: WebSocket; ip: string;
  input: { dx: number; dz: number; run: boolean }; seq: number; lastInputAt: number;
  access: Set<string>; busy: boolean; lastActAt: number; lastEmoteAt: number;
  known: Set<string>; budget: number; budgetAt: number; strikes: number; dirty: boolean; lastSave: number;
  emote: string | null; emoteUntil: number;
}
interface CityRuntime { id: string; world: any; colliders: Colliders; npcs: Npc[]; builtLoaded: boolean }
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
  insufficient_funds: 'Not enough money for that.', out_of_stock: 'Sold out.', property_unavailable: 'Someone else already rents that room.',
  tenancy_limit: 'You already rent a home.', shift_limit_reached: 'You have worked enough shifts for today.',
  shift_in_progress: 'Finish your current shift first.', requirements_not_met: 'You do not meet this job\'s requirements yet.',
};

export class Gateway {
  readonly players = new Map<string, Player>();
  private cities = new Map<string, CityRuntime>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private timer?: NodeJS.Timeout;
  private tick = 0;
  private connsByIp = new Map<string, number>();

  constructor(private ctx: AppContext) {
    for (const [id, world] of ctx.data.metroWorlds) {
      const rt: CityRuntime = { id, world, colliders: buildColliders(world), npcs: [], builtLoaded: false };
      world.npcRoutes.forEach((route: { x: number; z: number }[], i: number) => {
        const a = route[0]!;
        rt.npcs.push({
          id: `npc-${id}-${i + 1}`, name: 'Resident', appearance: NPC_APPEARANCES[(i + id.length) % NPC_APPEARANCES.length],
          x: a.x, z: a.z, ry: 0, moving: true, route, leg: 1 % route.length, dir: 1, loop: route.length > 2,
        });
      });
      this.cities.set(id, rt);
    }
  }
  /** Back-compat for tests: the start city's NPC list. */
  get npcs(): Npc[] { return this.rt(this.ctx.data.geo.startCity).npcs; }
  private metroOf(cityId: string) { return this.ctx.data.cityById.get(cityId)?.metro ?? cityId; }
  /** Runtime (continuous world) for an area id or a metro id. */
  private rt(cityOrMetro: string): CityRuntime { return this.cities.get(this.metroOf(cityOrMetro)) ?? this.cities.get(this.metroOf(this.ctx.data.geo.startCity))!; }
  private worldOf(p: { city: string }) { return this.rt(p.city).world; }
  private spawnOf(cityId: string) { const w = this.rt(cityId).world; return (w.districts.find((d: any) => d.id === cityId) ?? w.districts[0]).spawn as { x: number; z: number }; }

  /** Homes that players built on land appear as real buildings (with walls, a door and a gate) for everyone in that city. */
  private addBuilt(cityId: string, lotShort: string): boolean {
    const rt = this.rt(cityId); const lotId = `${cityId}:${lotShort}`; const lot = (rt.world.lots ?? []).find((l: any) => l.id === lotId && l.kind === 'land');
    if (!lot || rt.world.buildings.some((b: any) => b.builtOn === lotId)) return false;
    const { building, zone } = builtHouseSpec(lot);
    rt.world = { ...rt.world, buildings: [...rt.world.buildings, building], zones: [...rt.world.zones, zone] };   // copy: never mutate the shared template
    rt.colliders = buildColliders(rt.world);
    return true;
  }
  private async ensureBuilt(cityId: string) {
    const rt = this.rt(cityId); if (rt.builtLoaded) return; rt.builtLoaded = true;
    const rows = await this.ctx.pool.query(`SELECT district, lot_id FROM properties WHERE built AND district = ANY($1)`, [rt.world.districts.map((d: any) => d.id)]);
    for (const r of rows.rows) this.addBuilt(r.district, r.lot_id);
  }
  private broadcastWorld(cityId: string) {
    const rt = this.rt(cityId);
    for (const o of this.players.values()) if (o.metro === this.metroOf(cityId) && !o.travel) this.send(o, { t: 'world', world: rt.world });
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
  private publicGeo() {
    const g = this.ctx.data.geo;
    return {
      countries: g.countries.map((c) => ({ ...c, currency: { code: c.currency, ...g.currencies[c.currency]! } })),
      cities: g.cities.map((c) => ({ id: c.id, country: c.country, name: c.name, lat: c.lat, lon: c.lon, blurb: c.blurb, priceIndex: c.priceIndex, metro: c.metro, hub: c.hub })),
      transport: g.transport.map((m) => ({ id: m.id, name: m.name, icon: m.icon })),
    };
  }

  /** Door gate that opens for this tenant/owner: the apartment block shares one gate, every house has its own. */
  private gateOf(area: string, lotId: string | null | undefined) { return `${area}:${!lotId || lotId === 'apt' ? 'apartment' : lotId}`; }
  private accessFor(summary: { tenancy: { district: string; lotId?: string | null } | null }, metroOrCity: string) {
    const m = this.metroOf(metroOrCity);
    return new Set<string>(summary.tenancy && this.metroOf(summary.tenancy.district) === m ? [this.gateOf(summary.tenancy.district, summary.tenancy.lotId)] : []);
  }

  private async onConnection(ws: WebSocket, id: string, ip: string) {
    try {
      const prev = this.players.get(id);
      if (prev) { this.players.delete(id); prev.ws.close(4000, 'logged in elsewhere'); }

      await housing.sweepTenancies(this.ctx, id);
      let summary = await characterSummary(this.ctx, id);
      // A journey that finished while the player was offline completes now.
      if (summary.travel && new Date(summary.travel.arrivesAt).getTime() <= this.ctx.now().getTime()) {
        await travel.completeArrival(this.ctx, id);
        summary = await characterSummary(this.ctx, id);
      }
      const city = this.ctx.data.cityById.has(summary.city) ? summary.city : this.ctx.data.geo.startCity;
      const metro = this.metroOf(city);
      await this.ensureBuilt(city);
      const world = this.rt(city).world;
      const access = this.accessFor(summary, city);
      const spawn = this.spawnOf(city);
      const saved = summary.location.posRev >= 2 && !(summary.location.x === 0 && summary.location.z === 0)
        && !isBlocked(summary.location.x, summary.location.z, this.rt(city).colliders, (g) => access.has(g), world.bounds);
      const p: Player = {
        id, city, metro, travel: summary.travel ? { to: summary.travel.to, until: new Date(summary.travel.arrivesAt).getTime(), mode: 'flight' } : null,
        name: summary.displayName, appearance: summary.appearance, ws, ip,
        x: saved ? summary.location.x : spawn.x, z: saved ? summary.location.z : spawn.z, ry: 0, moving: false,
        input: { dx: 0, dz: 0, run: false }, seq: 0, lastInputAt: Date.now(), access, busy: false, lastActAt: 0, lastEmoteAt: 0,
        known: new Set(), budget: 120, budgetAt: Date.now(), strikes: 0, dirty: false, lastSave: Date.now(), emote: null, emoteUntil: 0,
      };
      { const d = districtAt(world, p.x, p.z); if (d) p.city = d; }
      this.players.set(id, p);
      this.connsByIp.set(ip, (this.connsByIp.get(ip) ?? 0) + 1);

      ws.on('message', (data) => { void this.onMessage(p, data.toString()); });
      ws.on('close', () => { void this.onClose(p); });
      ws.on('error', () => {});

      await this.sendWelcome(p, summary);
      if (p.travel) this.send(p, { t: 'travel', to: p.travel.to, toName: this.ctx.data.cityById.get(p.travel.to)?.name, arrivesAt: p.travel.until, mode: p.travel.mode });
      this.sendSnapshot(p);
    } catch (err) {
      ws.close(1011, 'join failed');
    }
  }

  private async sendWelcome(p: Player, summary: Awaited<ReturnType<typeof characterSummary>>, extra: object = {}) {
    await this.ensureBuilt(p.city);
    const city = this.ctx.data.cityById.get(p.city)!;
    this.send(p, {
      t: 'welcome', you: { id: p.id, name: p.name, appearance: p.appearance, x: p.x, z: p.z }, world: this.worldOf(p),
      city: { id: city.id, name: city.name, country: city.country, blurb: city.blurb, metro: city.metro }, currency: currencyOfCity(this.ctx.data, p.city),
      geo: this.publicGeo(), summary, door: await this.doorInfo(p, summary), serverNow: Date.now(), tickHz: TICK_HZ,
      achievements: this.ctx.data.achievements, jobs: jobs.listJobs(this.ctx), furnitureCatalog: this.ctx.data.items.filter((i) => i.furniture).map((i) => ({ id: i.id, name: i.name, ...i.furniture })), phone: await phoneInfo(this.ctx, p.id), ...extra,
    });
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
    if (p.travel) return; // position is meaningless mid-journey
    await this.ctx.pool.query('UPDATE characters SET district=$2,city=$2,pos_x=$3,pos_y=0,pos_z=$4,pos_rev=2 WHERE id=$1 AND travel_to IS NULL', [p.id, p.city, p.x, p.z]);
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
        case 'quote': this.send(p, { t: 'quote', to: m.to, options: travel.quote(this.ctx, p.city, m.to) }); return;
        case 'travel': return await this.onTravel(p, m.to, m.mode);
        case 'chat': if (p.travel) return; return await this.onChat(p, m.text);
        case 'emote': return this.onEmote(p, m.e);
        case 'interact': if (p.travel) throw new AppError(409, 'travelling', 'You are on a journey.'); return await this.onInteract(p, m.zone, m.item);
        case 'shopinfo': return await this.onShopInfo(p, m.zone);
        case 'phone': return await this.onPhone(p, m.tab);
        case 'app': return await this.onApp(p, m);
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

  private money(p: { city: string }, mvc: number) { return formatMoney(this.ctx.data, mvc, p.city); }

  private friendly(err: unknown): string {
    if (err instanceof AppError) return FRIENDLY[err.code] ?? (err.message && err.message !== err.code ? err.message : err.code.replace(/_/g, ' '));
    return 'Something went wrong. Please try again.';
  }

  private nearby(p: Player, radius: number): Player[] {
    return [...this.players.values()].filter((o) => o.metro === p.metro && !o.travel && dist2(p.x, p.z, o.x, o.z) <= radius);
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
    const zone = this.worldOf(p).zones.find((z: any) => z.id === zoneId);
    if (!zone) throw new AppError(404, 'unknown_zone');
    if (dist2(p.x, p.z, zone.x, zone.z) > zone.radius + INTERACT_SLACK) throw new AppError(409, 'too_far', 'You are too far away.');
    return zone;
  }

  private async refresh(p: Player) {
    const summary = await characterSummary(this.ctx, p.id);
    p.access = this.accessFor(summary, p.metro);
    this.send(p, { t: 'summary', summary, door: await this.doorInfo(p, summary) });
    return summary;
  }

  private async doorInfo(p: Pick<Player, 'city' | 'metro'>, summary: { tenancy: { propertyName: string; district: string; lotId?: string | null } | null }, area = p.city) {
    if (summary.tenancy) {
      if (this.metroOf(summary.tenancy.district) === p.metro) return summary.tenancy.lotId && summary.tenancy.lotId !== 'apt' ? { state: 'house', name: summary.tenancy.propertyName } : { state: 'tenant', name: summary.tenancy.propertyName };
      return { state: 'away', name: summary.tenancy.propertyName, city: this.ctx.data.cityById.get(summary.tenancy.district)?.name ?? '' };
    }
    const free = (await housing.listProperties(this.ctx)).find((x) => x.available && x.type === 'room' && x.district === area);
    return free ? { state: 'free', propertyId: free.propertyId, name: free.name, rent: free.rentPerPeriod } : { state: 'full' };
  }

  private async onInteract(p: Player, zoneId: string, item?: string) {
    const now = Date.now();
    if (p.busy || now - p.lastActAt < 250) return;
    p.busy = true; p.lastActAt = now;
    try {
      const zone = this.zoneFor(p, zoneId);
      if (zone.kind === 'door' && zone.lot && zone.lot !== 'apt') {
        const summary = await characterSummary(this.ctx, p.id);
        if (summary.tenancy && summary.tenancy.lotId === zone.lot && summary.tenancy.district === zone.area) { p.access.add(this.gateOf(zone.area, zone.lot)); this.toast(p, 'ok', `Welcome home! ${summary.tenancy.propertyName} is unlocked for you.`); }
        else throw new AppError(409, 'locked', 'This house is locked. Tap it to see if it is for sale or rent.');
      } else if (zone.kind === 'door') {
        const summary = await characterSummary(this.ctx, p.id);
        if (summary.tenancy && summary.tenancy.lotId && summary.tenancy.lotId !== 'apt') throw new AppError(409, 'wrong_door', 'Your home is a house, not this building.');
        if (summary.tenancy && summary.tenancy.district === zone.area) { p.access.add(this.gateOf(zone.area, 'apt')); this.toast(p, 'ok', `Welcome home! ${summary.tenancy.propertyName} is unlocked for you.`); }
        else {
          if (summary.tenancy) throw new AppError(409, 'tenancy_limit', 'You already have a home. Move out first.');
          const info = await this.doorInfo(p, summary, zone.area);
          if (info.state !== 'free') throw new AppError(409, 'no_rooms', 'No rooms are free right now.');
          const r = await housing.rent(this.ctx, p.id, info.propertyId!, randomUUID());
          p.access.add(this.gateOf(zone.area, 'apt'));
          this.toast(p, 'ok', `You rented ${info.name} for ${this.money(p, r.rentPaid)}. The door is unlocked.`);
        }
      } else if (zone.kind === 'shop') {
        const choice = zone.items.find((i: any) => i.itemId === item);
        if (!choice) throw new AppError(400, 'unknown_item', 'They do not sell that here.');
        const r = await shop.purchase(this.ctx, p.id, { shopId: zone.shopId, itemId: choice.itemId, quantity: 1, idempotencyKey: randomUUID() });
        this.toast(p, 'ok', `Bought ${choice.label} for ${this.money(p, r.totalPrice)}.`);
      } else if (zone.kind === 'work') {
        const summary = await characterSummary(this.ctx, p.id);
        if (!summary.activeShift) {
          const s = await jobs.startShift(this.ctx, p.id, zone.jobId);
          this.toast(p, 'ok', `Shift started: ${s.tasksRequired} tasks, about ${s.minSecondsPerTask}s apart.`);
        } else {
          const t = await jobs.completeTask(this.ctx, p.id, summary.activeShift.shiftId);
          if (t.tasksDone >= t.tasksRequired) {
            const c = await jobs.completeShift(this.ctx, p.id, summary.activeShift.shiftId);
            this.toast(p, 'ok', `Shift complete! You earned ${this.money(p, c.wage)}.`);
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
    if (!summary.tenancy) throw new AppError(409, 'no_home', 'You do not rent a home yet. Visit the apartments.');
    const area = summary.tenancy.district;
    if (this.metroOf(area) !== p.metro) {
      throw new AppError(409, 'home_elsewhere', `Your home is in ${this.ctx.data.cityById.get(area)?.name}. Open the map to travel there.`);
    }
    await this.ensureBuilt(area);
    const world = this.worldOf({ city: area });
    const lotShort = summary.tenancy.lotId ?? 'apt';
    const lot = (world.lots ?? []).find((l: any) => l.id === `${area}:${lotShort}`);
    const b = world.buildings.find((x: any) => x.id === (lot?.kind === 'land' ? `home_${lot.id}` : lot?.building ?? `${area}:apt`));
    if (!b) throw new AppError(409, 'no_interior', 'Your home is not ready yet.');
    p.access.add(this.gateOf(area, lotShort));
    p.x = b.cx; p.z = b.cz + (b.doorSide === '+z' ? 1 : -1) * Math.max(0.8, b.sz / 2 - 1.8); p.moving = false; p.dirty = true;
    this.setArea(p, area);
    this.toast(p, 'ok', `Welcome home to ${summary.tenancy.propertyName}.`);
  }

  /** The player crossed into (or was moved to) another area of the same metro: tell the client so the place name and prices follow. */
  private setArea(p: Player, area: string) {
    if (p.city === area) return;
    p.city = area; p.dirty = true;
    const c = this.ctx.data.cityById.get(area)!;
    this.send(p, { t: 'area', city: { id: c.id, name: c.name, country: c.country, blurb: c.blurb, metro: c.metro }, currency: currencyOfCity(this.ctx.data, area) });
    void this.refresh(p).catch(() => {});
  }

  // ------------------------------------------------------------------ travel
  private async onTravel(p: Player, to: string, mode: string) {
    if (p.travel) throw new AppError(409, 'already_travelling', 'You are already on a journey.');
    const t = await travel.startTrip(this.ctx, p.id, to, mode, randomUUID());
    p.travel = { to, until: new Date(t.arrivesAt).getTime(), mode };
    p.input = { dx: 0, dz: 0, run: false }; p.moving = false;
    const name = this.ctx.data.cityById.get(to)?.name;
    this.send(p, { t: 'travel', to, toName: name, mode, arrivesAt: p.travel.until, seconds: t.seconds });
    this.toast(p, 'ok', `${this.money(p, t.fare)} paid. Heading to ${name}.`);
    await this.refresh(p);
  }

  private async arrive(p: Player) {
    const t = p.travel; if (!t) return;
    p.travel = null; // clear first so the tick doesn't fire this twice
    try {
      const city = await travel.completeArrival(this.ctx, p.id);
      if (!city || this.players.get(p.id) !== p) return;
      const dest = this.ctx.data.cityById.has(city) ? city : this.ctx.data.geo.startCity;
      const sp = this.spawnOf(dest);
      if (this.metroOf(dest) === p.metro) {
        // Same metro (state): the world is already loaded, we just move to the other area.
        p.x = sp.x; p.z = sp.z; p.moving = false; p.dirty = true;
        const before = p.city; p.city = before;
        this.setArea(p, dest);
        this.toast(p, 'ok', `You arrived in ${this.ctx.data.cityById.get(dest)?.name}.`);
        await this.refresh(p);
        this.send(p, { t: 'arrived', city: dest });
        return;
      }
      p.city = dest; p.metro = this.metroOf(dest);
      p.x = sp.x; p.z = sp.z; p.known.clear(); p.moving = false; p.dirty = false;
      const summary = await characterSummary(this.ctx, p.id);
      p.access = this.accessFor(summary, p.metro);
      await this.sendWelcome(p, summary, { arrived: true });
      this.toast(p, 'ok', `Welcome to ${this.ctx.data.cityById.get(p.city)?.name}! Prices here are in ${currencyOfCity(this.ctx.data, p.city).name}.`);
    } catch { p.travel = t; /* retry next tick */ }
  }

  /** Generic phone-app request/response. Replies carry the client's rid; errors are returned, not toasted. */
  private async onApp(p: Player, m: { rid: string; app: string; a: string; d?: Record<string, unknown> }) {
    if (p.travel) throw new AppError(409, 'travelling', 'You are on a journey.');
    try {
      const r = await handleApp(this.ctx, { id: p.id, name: p.name, city: p.city }, m.app, m.a, m.d);
      this.send(p, { t: 'app', rid: m.rid, ok: true, data: r.data });
      for (const n of r.notify ?? []) {
        const o = this.players.get(n.to);
        if (!o) continue;
        const msg: any = { ...n.msg };
        if (msg.kind === 'money') { msg.text = `${msg.from} sent you ${this.money(o, msg.amount)}`; delete msg.amount; }
        this.send(o, msg);
        if (msg.kind === 'money') void this.refresh(o).catch(() => {});
      }
      if (m.app === 'estate') {
        if (m.a === 'build' && (r.data as any)?.builtOn && !(r.data as any).replayed && this.addBuilt((r.data as any).area ?? p.city, (r.data as any).builtOn)) this.broadcastWorld(p.city);
        await this.refresh(p);
        if (r.goHome) await this.onHome(p).catch(() => {});   // move in immediately: walk straight into the new home
      } else if (m.app === 'store' || m.app === 'home') {
        await this.refresh(p);
      } else if (m.app === 'bank' || m.app === 'odds') void this.refresh(p).catch(() => {});
    } catch (err) {
      this.send(p, { t: 'app', rid: m.rid, ok: false, code: err instanceof AppError ? err.code : 'error', message: this.friendly(err) });
    }
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
      if (p.travel) { if (this.ctx.now().getTime() >= p.travel.until) void this.arrive(p); continue; }
      const rt = this.rt(p.city);
      const input = now - p.lastInputAt > INPUT_STALE_MS ? { dx: 0, dz: 0, run: false } : p.input;
      const before = p.x * 1e3 + p.z;
      stepPlayer(p, input, dt, rt.colliders, (g) => p.access.has(g), rt.world.bounds);
      if (p.x * 1e3 + p.z !== before) p.dirty = true;
      const d = districtAt(rt.world, p.x, p.z); if (d && d !== p.city) this.setArea(p, d);   // walking across a district border changes the area
      if (p.emote && now > p.emoteUntil) p.emote = null;
      if (p.dirty && now - p.lastSave > SAVE_EVERY_MS) void this.save(p).catch(() => {});
    }
    for (const rt of this.cities.values()) for (const n of rt.npcs) this.stepNpc(n, dt);
    if (this.tick % SNAPSHOT_EVERY === 0) for (const p of this.players.values()) if (!p.travel) this.sendSnapshot(p);
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
    let online = 0;
    for (const o of this.players.values()) {
      if (o.metro !== p.metro || o.travel) continue;
      online++; consider(o, false, o.emote);
    }
    for (const n of this.rt(p.city).npcs) consider(n, true, null);
    const gone: string[] = [];
    for (const id of p.known) if (!seen.has(id)) { gone.push(id); p.known.delete(id); }
    this.send(p, { t: 'snap', tick: this.tick, ack: p.seq, you: [+p.x.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2)], ps, spawns, gone, online, city: p.city });
  }
}

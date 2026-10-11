import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError, badRequest } from '../../errors.js';
import { assertAdult, characterAgeBand } from '../identity/service.js';
import * as bank from './bank.js';
import * as messages from './messages.js';
import * as dating from './dating.js';
import * as betting from './betting.js';
import * as estate from '../housing/estate.js';
import * as housing from '../housing/housing.js';
import * as furnish from '../housing/furnish.js';
import * as health from '../life/health.js';
import * as courses from '../life/courses.js';
import * as cars from '../life/cars.js';
import * as assurance from '../life/assurance.js';
import * as topup from '../topup/topup.js';
import * as social from '../social/social.js';
import { updateAreaValues } from '../housing/values.js';

/** at: the type of public building the player is standing in ('hospital', 'garage'...), or null outdoors. */
export interface AppCaller { id: string; name: string; city: string; at?: string | null }
export interface Notify { to: string; msg: Record<string, unknown> }
/** goHome: the action changed where the player lives and they should be taken inside their new home. */
export interface AppReply { data: unknown; notify?: Notify[]; goHome?: boolean }

const Key = z.string().min(8).max(64);
const Body = {
  bank: {
    overview: z.object({}),
    send: z.object({ to: z.string().min(1).max(60), amount: z.number(), note: z.string().max(60).optional(), key: Key }),
    borrow: z.object({ amount: z.number(), key: Key }),
    repay: z.object({ amount: z.number(), key: Key }),
  },
  messages: {
    inbox: z.object({}),
    thread: z.object({ with: z.string().uuid() }),
    send: z.object({ to: z.string().max(60).optional(), toId: z.string().uuid().optional(), text: z.string().max(1000) }),
  },
  love: {
    state: z.object({}),
    save: z.object({ bio: z.string().max(400), lookingFor: z.string().max(60), interests: z.array(z.string().max(30)).max(10) }),
    pause: z.object({ active: z.boolean() }),
    remove: z.object({}),
    discover: z.object({}),
    swipe: z.object({ id: z.string().uuid(), like: z.boolean() }),
    unmatch: z.object({ id: z.string().uuid() }),
  },
  estate: {
    list: z.object({ city: z.string().max(40).optional() }),
    metro: z.object({}),
    overview: z.object({}),
    rent: z.object({ id: z.string().max(80), key: Key }),
    buy: z.object({ id: z.string().max(80), key: Key }),
    build: z.object({ id: z.string().max(80), key: Key }),
    sell: z.object({ id: z.string().max(80), key: Key }),
    movein: z.object({ id: z.string().max(80) }),
    leave: z.object({}),
  },
  home: {
    info: z.object({}),
    place: z.object({ itemId: z.string().max(60), x: z.number(), z: z.number(), yaw: z.number() }),
    pickup: z.object({ id: z.string().uuid() }),
  },
  store: {
    list: z.object({}),
    buy: z.object({ itemId: z.string().max(60), key: Key }),
  },
  topup: {
    info: z.object({}),
    start: z.object({ provider: z.enum(['manual', 'paystack', 'flutterwave', 'korapay']), pack: z.string().max(40), currency: z.enum(['NGN', 'USD']) }),
    check: z.object({ id: z.string().uuid() }),
    submit: z.object({ id: z.string().uuid(), senderName: z.string().min(2).max(80), note: z.string().max(200).optional() }),
    ref: z.object({ ref: z.string().max(40) }),
  },
  health: { info: z.object({}), treat: z.object({ id: z.string().max(40), key: Key }) },
  courses: { info: z.object({}), enrol: z.object({ id: z.string().max(40), key: Key }) },
  cars: {
    info: z.object({}),
    buy: z.object({ model: z.string().max(40), key: Key }),
    sell: z.object({ id: z.string().uuid(), key: Key }),
    activate: z.object({ id: z.string().uuid() }),
    refuel: z.object({ id: z.string().uuid(), litres: z.union([z.literal('full'), z.number().positive().max(200)]), key: Key }),
    repair: z.object({ id: z.string().uuid(), key: Key }),
  },
  assurance: {
    info: z.object({}),
    buy: z.object({ plan: z.string().max(40), car: z.string().uuid().optional(), key: Key }),
    cancel: z.object({ id: z.string().uuid() }),
  },
  contacts: {
    list: z.object({}),
    unblock: z.object({ id: z.string().uuid() }),
  },
  odds: {
    state: z.object({}),
    bet: z.object({ slot: z.number().int(), pick: z.enum(['home', 'draw', 'away']), stake: z.number(), key: Key }),
    pause: z.object({ hours: z.number() }),
  },
} as const;

export const ADULT_APPS = new Set(['love', 'odds']);

/** What the phone shows on its home screen: which apps exist for this player (age gating is enforced again server-side). */
export async function phoneInfo(ctx: AppContext, characterId: string) {
  const band = await characterAgeBand(ctx, characterId);
  return { adult: band === 'adult', unread: await messages.unreadCount(ctx, characterId) };
}

export async function handleApp(ctx: AppContext, who: AppCaller, app: string, action: string, raw: unknown): Promise<AppReply> {
  const schemas = (Body as any)[app] as Record<string, z.ZodTypeAny> | undefined;
  const schema = schemas?.[action];
  if (!schema) throw badRequest('unknown_app_action');
  if (ADULT_APPS.has(app)) await assertAdult(ctx, who.id);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw badRequest('invalid_request', parsed.error.issues[0]?.message);
  const b: any = parsed.data;
  const key = `${app}.${action}`;
  switch (key) {
    case 'bank.overview': return { data: await bank.overview(ctx, who.id) };
    case 'bank.send': {
      const r = await bank.send(ctx, who.id, b.to, b.amount, b.key, b.note);
      return { data: r, notify: r.replayed ? [] : [{ to: r.toId, msg: { t: 'notify', kind: 'money', from: who.name, amount: r.amount, city: who.city } }] };
    }
    case 'bank.borrow': return { data: await bank.takeLoan(ctx, who.id, b.amount, b.key) };
    case 'bank.repay': return { data: await bank.repayLoan(ctx, who.id, b.amount, b.key) };
    case 'messages.inbox': return { data: { chats: await messages.inbox(ctx, who.id) } };
    case 'messages.thread': return { data: await messages.thread(ctx, who.id, b.with) };
    case 'messages.send': {
      const r = await messages.send(ctx, who.id, b.to, b.toId, b.text);
      return { data: r, notify: [{ to: r.toId, msg: { t: 'notify', kind: 'message', from: who.name, fromId: who.id } }] };
    }
    case 'love.state': return { data: { profile: await dating.myProfile(ctx, who.id), matches: await dating.matches(ctx, who.id), options: ctx.data.phone.dating } };
    case 'love.save': return { data: await dating.saveProfile(ctx, who.id, b) };
    case 'love.pause': await dating.setActive(ctx, who.id, b.active); return { data: { active: b.active } };
    case 'love.remove': await dating.deleteProfile(ctx, who.id); return { data: { removed: true } };
    case 'love.discover': {
      if (!(await dating.myProfile(ctx, who.id))) throw badRequest('profile_required', 'Create your profile first.');
      return { data: { people: await dating.discover(ctx, who.id) } };
    }
    case 'love.swipe': {
      if (!(await dating.myProfile(ctx, who.id))) throw badRequest('profile_required', 'Create your profile first.');
      const r = await dating.swipe(ctx, who.id, b.id, b.like);
      return { data: r, notify: r.matched ? [{ to: b.id, msg: { t: 'notify', kind: 'match', from: who.name } }] : [] };
    }
    case 'love.unmatch': await dating.unmatch(ctx, who.id, b.id); return { data: { ok: true } };
    case 'estate.list': {
      const area = b.city ?? who.city;
      if (ctx.data.cityById.get(area)?.metro !== ctx.data.cityById.get(who.city)?.metro) throw badRequest('wrong_city', 'That area is in another city.');
      return { data: await estate.listCity(ctx, who.id, area) };
    }
    case 'estate.metro': return { data: await estate.listMetro(ctx, who.id, who.city) };
    case 'estate.overview': return { data: { areas: await estate.overview(ctx) } };
    case 'estate.rent': {
      const p = (await ctx.pool.query('SELECT district FROM properties WHERE id=$1', [b.id])).rows[0];
      if (!p) throw badRequest('property_not_found');
      if (ctx.data.cityById.get(p.district)?.metro !== ctx.data.cityById.get(who.city)?.metro) throw badRequest('wrong_city', 'That property is in another city.');
      await updateAreaValues(ctx);
      const r = await housing.rent(ctx, who.id, b.id, b.key);
      return { data: r, goHome: !r.replayed };
    }
    case 'estate.buy': { const r = await estate.buy(ctx, who.id, who.city, b.id, b.key); return { data: r, goHome: !!r.movedIn && !r.replayed }; }
    case 'estate.build': { const r = await estate.build(ctx, who.id, who.city, b.id, b.key); return { data: r, goHome: !!r.movedIn && !r.replayed }; }
    case 'estate.sell': return { data: await estate.sell(ctx, who.id, who.city, b.id, b.key) };
    case 'estate.movein': { const r = await estate.moveIn(ctx, who.id, who.city, b.id); return { data: r, goHome: true }; }
    case 'estate.leave': return { data: await estate.leave(ctx, who.id) };
    case 'home.info': return { data: await furnish.homeInfo(ctx, who.id) };
    case 'home.place': return { data: await furnish.place(ctx, who.id, who.city, b.itemId, b.x, b.z, b.yaw) };
    case 'home.pickup': return { data: await furnish.pickUp(ctx, who.id, b.id) };
    case 'store.list': return { data: await furnish.storeList(ctx, who.city) };
    case 'store.buy': return { data: await furnish.storeBuy(ctx, who.id, who.city, b.itemId, b.key) };
    case 'topup.info': return { data: { ...topup.catalogue(ctx), orders: await topup.listOrders(ctx, who.id) } };
    case 'topup.start': return { data: await topup.start(ctx, who.id, b.provider, b.pack, b.currency) };
    case 'topup.check': return { data: await topup.check(ctx, who.id, b.id) };
    case 'topup.submit': return { data: await topup.submitManual(ctx, who.id, b.id, b.senderName, b.note) };
    case 'topup.ref': {   // coming back from a provider's page: find the order by its reference and check it
      const o = (await ctx.pool.query('SELECT id FROM topup_orders WHERE reference=$1 AND character_id=$2', [b.ref, who.id])).rows[0];
      if (!o) throw badRequest('order_not_found');
      return { data: await topup.check(ctx, who.id, o.id) };
    }
    case 'health.info': return { data: await health.overview(ctx, who.id, who.at ?? null) };
    case 'health.treat': return { data: await health.treat(ctx, who.id, b.id, b.key, who.at ?? null) };
    case 'courses.info': return { data: await courses.overview(ctx, who.id) };
    case 'courses.enrol': return { data: await courses.enrol(ctx, who.id, b.id, b.key) };
    case 'cars.info': return { data: await cars.garage(ctx, who.id, who.at ?? null) };
    case 'cars.buy': return { data: await cars.buy(ctx, who.id, b.model, b.key) };
    case 'cars.sell': return { data: await cars.sell(ctx, who.id, b.id, b.key) };
    case 'cars.activate': return { data: await cars.activate(ctx, who.id, b.id) };
    case 'cars.refuel': return { data: await cars.refuel(ctx, who.id, b.id, b.litres, b.key, who.at ?? null) };
    case 'cars.repair': return { data: await cars.repair(ctx, who.id, b.id, b.key, who.at ?? null) };
    case 'assurance.info': return { data: await assurance.overview(ctx, who.id) };
    case 'assurance.buy': return { data: await assurance.buy(ctx, who.id, b.plan, b.car, b.key) };
    case 'assurance.cancel': return { data: await assurance.cancel(ctx, who.id, b.id) };
    case 'contacts.list': return { data: { blocked: await social.listBlocks(ctx, who.id), chats: await messages.inbox(ctx, who.id) } };
    case 'contacts.unblock': await social.unblock(ctx, who.id, b.id); return { data: { ok: true } };
    case 'odds.state': return { data: await betting.overview(ctx, who.id) };
    case 'odds.bet': return { data: await betting.place(ctx, who.id, b.slot, b.pick, b.stake, b.key) };
    case 'odds.pause': return { data: await betting.takeBreak(ctx, who.id, b.hours) };
  }
  throw new AppError(400, 'unknown_app_action');
}

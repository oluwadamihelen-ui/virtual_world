import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError, badRequest } from '../../errors.js';
import { assertAdult, characterAgeBand } from '../identity/service.js';
import * as bank from './bank.js';
import * as messages from './messages.js';
import * as dating from './dating.js';
import * as betting from './betting.js';

export interface AppCaller { id: string; name: string; city: string }
export interface Notify { to: string; msg: Record<string, unknown> }
export interface AppReply { data: unknown; notify?: Notify[] }

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
    case 'odds.state': return { data: await betting.overview(ctx, who.id) };
    case 'odds.bet': return { data: await betting.place(ctx, who.id, b.slot, b.pick, b.stake, b.key) };
    case 'odds.pause': return { data: await betting.takeBreak(ctx, who.id, b.hours) };
  }
  throw new AppError(400, 'unknown_app_action');
}

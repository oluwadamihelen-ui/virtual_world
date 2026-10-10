import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const Economy = z.object({
  currency: z.object({ code: z.string(), name: z.string() }),
  startingBalance: z.number().int().nonnegative(),
  rentPeriodHours: z.number().positive(),
  rentGraceHours: z.number().nonnegative(),
  maxActiveTenanciesPerCharacter: z.number().int().positive(),
  displayName: z.object({
    minLength: z.number().int(), maxLength: z.number().int(),
    reserved: z.array(z.string()),
    blockedSubstrings: z.array(z.string()).default([]),
  }),
}).passthrough();

const Item = z.object({
  id: z.string(), name: z.string(), category: z.string(),
  basePrice: z.number().int().positive().optional(), wholesalePrice: z.number().int().positive().optional(), npcDemand: z.number().positive().optional(),
});
const Businesses = z.object({
  maxOpenPerOwner: z.number().int().positive(), maxStockPerItem: z.number().int().positive(), maxRestockPerOrder: z.number().int().positive(),
  priceMinMultiplier: z.number().positive(), priceMaxMultiplier: z.number().positive(),
  types: z.record(z.string(), z.object({ name: z.string(), categories: z.array(z.string()) })),
  premises: z.array(z.object({ id: z.string(), district: z.string(), name: z.string(), setupCost: z.number().int().nonnegative() })),
  npcDemand: z.object({ customersPerTick: z.number().int().nonnegative(), tickSeconds: z.number().positive(), maxPriceMultiplier: z.number().positive(), priceSensitivity: z.number().nonnegative() }),
}).passthrough();
const Chat = z.object({ maxLength: z.number().int().positive(), messagesPerWindow: z.number().int().positive(), windowSeconds: z.number().positive(), blockedWords: z.array(z.string()) }).passthrough();
const World = z.object({
  name: z.string(), district: z.object({ id: z.string(), name: z.string(), place: z.string() }),
  bounds: z.object({ minX: z.number(), maxX: z.number(), minZ: z.number(), maxZ: z.number() }),
  spawn: z.object({ x: z.number(), z: z.number() }),
  buildings: z.array(z.object({ id: z.string(), cx: z.number(), cz: z.number(), sx: z.number(), sz: z.number() }).passthrough()),
  furniture: z.array(z.object({ x: z.number(), z: z.number(), sx: z.number(), sz: z.number() }).passthrough()),
  props: z.array(z.object({ type: z.string(), x: z.number(), z: z.number() }).passthrough()),
  zones: z.array(z.object({ id: z.string(), kind: z.enum(['door', 'shop', 'work']), x: z.number(), z: z.number(), radius: z.number() }).passthrough()),
  npcRoutes: z.array(z.array(z.object({ x: z.number(), z: z.number() }))),
}).passthrough();
const Achievement = z.object({ id: z.string(), name: z.string(), reputation: z.number().int() });
const Shop = z.object({
  id: z.string(), name: z.string(), district: z.string(),
  stock: z.array(z.object({ itemId: z.string(), price: z.number().int().nonnegative(), quantity: z.number().int().nonnegative().nullable() })),
});
const Property = z.object({
  id: z.string(), type: z.string(), district: z.string(), name: z.string(),
  rentPerPeriod: z.number().int().nonnegative(), capacity: z.number().int().positive(), furnitureSlots: z.number().int().nonnegative(),
});
const Job = z.object({
  id: z.string(), name: z.string(), employer: z.string(), district: z.string(),
  wagePerShift: z.number().int().positive(), tasksPerShift: z.number().int().positive(),
  minSecondsPerTask: z.number().nonnegative(), maxShiftsPer24h: z.number().int().positive(),
  requirements: z.object({ minReputation: z.number().int() }),
  skill: z.object({ id: z.string(), xpPerShift: z.number().int().nonnegative() }),
});
const Appearance = z.object({
  bodyPresets: z.array(z.string()), skinTones: z.array(z.number()), hairstyles: z.array(z.string()),
  hairColors: z.array(z.string()), outfits: z.array(z.string()),
});

export type GameData = ReturnType<typeof parseAll>;

function parseAll(read: (f: string) => unknown) {
  const economy = Economy.parse(read('economy.json'));
  const items = z.array(Item).parse(read('items.json'));
  const shops = z.array(Shop).parse(read('shops.json'));
  const properties = z.array(Property).parse(read('properties.json'));
  const jobs = z.array(Job).parse(read('jobs.json'));
  const appearance = Appearance.parse(read('appearance.json'));
  const businesses = Businesses.parse(read('businesses.json'));
  const chat = Chat.parse(read('chat.json'));
  const achievements = z.array(Achievement).parse(read('achievements.json'));
  const world = World.parse(read('world.json'));
  // Cross-reference validation: catch typos in data at boot rather than at purchase time.
  const itemIds = new Set(items.map((i) => i.id));
  for (const s of shops) for (const st of s.stock) {
    if (!itemIds.has(st.itemId)) throw new Error(`shops.json: unknown item ${st.itemId} in ${s.id}`);
  }
  for (const [t, def] of Object.entries(businesses.types)) {
    if (!items.some((i) => def.categories.includes(i.category) && i.wholesalePrice)) throw new Error(`businesses.json: type ${t} has no sellable items`);
  }
  return { economy, items, shops, properties, jobs, appearance, businesses, chat, achievements, world, itemIds };
}

export function loadGameData(dir: string): GameData {
  return parseAll((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

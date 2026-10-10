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

const Item = z.object({ id: z.string(), name: z.string(), category: z.string() });
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
  // Cross-reference validation: catch typos in data at boot rather than at purchase time.
  const itemIds = new Set(items.map((i) => i.id));
  for (const s of shops) for (const st of s.stock) {
    if (!itemIds.has(st.itemId)) throw new Error(`shops.json: unknown item ${st.itemId} in ${s.id}`);
  }
  return { economy, items, shops, properties, jobs, appearance, itemIds };
}

export function loadGameData(dir: string): GameData {
  return parseAll((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

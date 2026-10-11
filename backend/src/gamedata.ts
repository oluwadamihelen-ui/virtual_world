import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { generateWorld, cityShopId } from './world/cities.js';
import { buildMetroWorld, type MetroFile } from './world/metro.js';

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
  furniture: z.object({ sx: z.number(), sz: z.number(), h: z.number(), parts: z.array(z.object({ w: z.number(), h: z.number(), d: z.number(), x: z.number(), y: z.number(), z: z.number(), c: z.string() })) }).optional(),
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
const Geo = z.object({
  startCity: z.string(),
  currencies: z.record(z.string(), z.object({ symbol: z.string(), name: z.string(), perMVC: z.number().positive(), decimals: z.number().int().min(0).max(4) })),
  countries: z.array(z.object({ id: z.string(), name: z.string(), flag: z.string(), currency: z.string() })),
  cities: z.array(z.object({
    id: z.string(), country: z.string(), name: z.string(), lat: z.number(), lon: z.number(), priceIndex: z.number().positive(), blurb: z.string(),
    mirror: z.enum(['none', 'x', 'z', 'xz']).optional(),
    metro: z.string(), hub: z.boolean().default(false),
    landmark: z.enum(['sea', 'rock', 'harbour', 'walls', 'jungle', 'hills', 'tower']).optional(),
    theme: z.object({ ground: z.string(), road: z.string(), buildings: z.array(z.string()), roofs: z.array(z.string()) }).optional(),
    names: z.record(z.string(), z.string()).optional(),
  })),
  transport: z.array(z.object({
    id: z.string(), name: z.string(), icon: z.string(), intercity: z.boolean(), domesticOnly: z.boolean().optional(),
    minKm: z.number().optional(), maxKm: z.number().optional(), base: z.number().optional(), perKm: z.number().optional(),
    secPerKm: z.number().optional(), internationalFee: z.number().optional(),
  })),
  minTravelSeconds: z.number().positive(),
  walkMaxKm: z.number().positive().default(4),
  localTransport: z.object({
    walk: z.object({ name: z.string(), icon: z.string(), metersPerSecond: z.number().positive() }),
    bike: z.object({ name: z.string(), icon: z.string(), fee: z.number().int().nonnegative(), speedMult: z.number().min(1).max(3), seconds: z.number().positive(), minMeters: z.number() }),
    bus: z.object({ name: z.string(), icon: z.string(), base: z.number(), perMeter: z.number(), secPerMeter: z.number(), minSeconds: z.number(), maxSeconds: z.number(), minMeters: z.number() }),
    car: z.object({ name: z.string(), icon: z.string(), base: z.number(), perMeter: z.number(), secPerMeter: z.number(), minSeconds: z.number(), maxSeconds: z.number(), minMeters: z.number() }),
  }),
});
const Phone = z.object({
  minAgeToMessage: z.number().int(),
  transfer: z.object({ min: z.number().int().positive(), maxPerTransfer: z.number().int().positive(), maxPerDay: z.number().int().positive(), minorMaxPerDay: z.number().int().positive() }),
  loans: z.object({ baseLimit: z.number().int().nonnegative(), limitPerReputation: z.number().int().nonnegative(), maxLimit: z.number().int().positive(), feePercent: z.number().nonnegative(), termHours: z.number().positive(), garnishPercent: z.number().min(0).max(100), minAge: z.number().int() }),
  messages: z.object({ maxLength: z.number().int().positive(), perMinute: z.number().int().positive() }),
  dating: z.object({ bioMaxLength: z.number().int().positive(), discoverBatch: z.number().int().positive(), likesPerDay: z.number().int().positive(), lookingFor: z.array(z.string()), interests: z.array(z.string()) }),
  betting: z.object({
    roundMinutes: z.number().positive(), fixturesPerRound: z.number().int().positive(), marginPercent: z.number().min(0), minStake: z.number().int().positive(), maxStake: z.number().int().positive(),
    dailyLossLimit: z.number().int().positive(), maxOpenBets: z.number().int().positive(), breakHours: z.array(z.number().positive()),
    teams: z.array(z.object({ name: z.string(), strength: z.number().positive() })),
  }),
});
const Achievement = z.object({ id: z.string(), name: z.string(), reputation: z.number().int() });
const Shop = z.object({
  id: z.string(), name: z.string(), district: z.string(),
  stock: z.array(z.object({ itemId: z.string(), price: z.number().int().nonnegative(), quantity: z.number().int().nonnegative().nullable() })),
});
const Property = z.object({
  id: z.string(), type: z.string(), district: z.string(), name: z.string(),
  rentPerPeriod: z.number().int().nonnegative(), capacity: z.number().int().positive(), furnitureSlots: z.number().int().nonnegative(),
  lot: z.string().optional(), salePrice: z.number().int().positive().nullable().optional(), beds: z.number().int().optional(), sizeSqm: z.number().int().optional(),
  blurb: z.string().optional(), buildCost: z.number().int().positive().nullable().optional(),
});
const Unit = z.object({ name: z.string(), beds: z.number().int(), sizeSqm: z.number().int(), rent: z.number().int().positive(), price: z.number().int().positive(), furnitureSlots: z.number().int(), capacity: z.number().int().positive(), blurb: z.string() });
const Estate = z.object({
  rooms: z.object({ beds: z.number().int(), sizeSqm: z.number().int(), furnitureSlots: z.number().int(), rent: z.number().int().positive(), count: z.number().int(), blurb: z.string() }).passthrough(),
  apartments: z.array(Unit), houses: z.record(z.string(), Unit),
  land: z.record(z.string(), z.object({ sizeSqm: z.number().int(), price: z.number().int().positive() })),
  build: z.object({ cost: z.number().int().positive(), name: z.string(), beds: z.number().int(), sizeSqm: z.number().int(), furnitureSlots: z.number().int(), capacity: z.number().int(), rentRatio: z.number().positive() }),
  sellFeePercent: z.number().min(0).max(50), maxLandPlots: z.number().int().positive(),
  values: z.object({ startSettlers: z.number(), valuePerResident: z.number().positive(), floor: z.number().positive(), ceiling: z.number().positive(), stepPerUpdate: z.number().positive(), updateMinutes: z.number().positive(), historyKeep: z.number().int().positive() }),
  settlersPerDay: z.record(z.string(), z.number()), maxSettlers: z.number(),
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
  const properties = z.array(Property).parse(read('properties.json')).map((p) => ({ lot: 'apt', beds: p.type === 'apartment' ? 2 : 1, sizeSqm: p.type === 'apartment' ? 68 : 28, salePrice: p.type === 'apartment' ? 16000 : null, blurb: p.type === 'apartment' ? 'Two bedrooms with a balcony.' : 'A compact furnished room. Cheap, close to everything.', ...p }));
  const jobs = z.array(Job).parse(read('jobs.json'));
  const appearance = Appearance.parse(read('appearance.json'));
  const businesses = Businesses.parse(read('businesses.json'));
  const chat = Chat.parse(read('chat.json'));
  const achievements = z.array(Achievement).parse(read('achievements.json'));
  const world = World.parse(read('world.json'));
  const geo = Geo.parse(read('geo.json'));
  const phone = Phone.parse(read('phone.json'));
  const metroFile = read('metros.json') as MetroFile;
  const estate = Estate.parse(read('estate.json'));
  // Cross-reference validation: catch typos in data at boot rather than at purchase time.
  const itemIds = new Set(items.map((i) => i.id));
  for (const s of shops) for (const st of s.stock) {
    if (!itemIds.has(st.itemId)) throw new Error(`shops.json: unknown item ${st.itemId} in ${s.id}`);
  }
  for (const [t, def] of Object.entries(businesses.types)) {
    if (!items.some((i) => def.categories.includes(i.category) && i.wholesalePrice)) throw new Error(`businesses.json: type ${t} has no sellable items`);
  }
  // ---- geography: validate references, derive per-city worlds, shops and rooms ----
  const countryIds = new Set(geo.countries.map((c) => c.id));
  for (const c of geo.countries) if (!geo.currencies[c.currency]) throw new Error(`geo.json: unknown currency ${c.currency}`);
  for (const c of geo.cities) if (!countryIds.has(c.country)) throw new Error(`geo.json: city ${c.id} has unknown country ${c.country}`);
  if (!geo.cities.some((c) => c.id === geo.startCity)) throw new Error('geo.json: startCity not found');
  const price = (n: number, idx: number) => Math.max(50, Math.round((n * idx) / 50) * 50);
  const metroWorlds = new Map<string, any>();   // one continuous world per metro (state)
  const worlds = new Map<string, any>();        // lookup by any area id -> its metro's world
  for (const metro of new Set(geo.cities.map((c) => c.metro))) {
    const mw = buildMetroWorld(world, geo.cities as any, metro, metroFile);
    metroWorlds.set(metro, mw);
    for (const c of geo.cities) if (c.metro === metro) worlds.set(c.id, mw);
  }
  const baseShop = shops.find((s) => s.id === 'shop_corner_grocery')!;
  const homeShop = shops.find((s) => s.id === 'shop_home_store')!;
  const allShops = [...shops];
  const allProps = [...properties];
  for (const city of geo.cities) {
    if (city.id !== 'lagos') allShops.push({ ...homeShop, id: `shop_${city.id}_home`, name: 'Home Store', district: city.id, stock: homeShop.stock.map((st) => ({ ...st, price: Math.max(1, Math.round(st.price * city.priceIndex)) })) });
    if (city.id === 'lagos') continue;
    allShops.push({ ...baseShop, id: cityShopId(city.id), name: `${city.names?.grocery ?? 'Corner Grocery'}`, district: city.id,
      stock: baseShop.stock.map((st) => ({ ...st, price: Math.max(1, Math.round(st.price * city.priceIndex)) })) });
    for (let n = 1; n <= estate.rooms.count; n++) {
      allProps.push({ id: `prop_${city.id}_room_${n}`, type: 'room', district: city.id, name: `Room ${n}, ${city.names?.apt ?? 'Apartments'}`,
        rentPerPeriod: price(estate.rooms.rent, city.priceIndex), capacity: 1, furnitureSlots: estate.rooms.furnitureSlots, lot: 'apt', beds: estate.rooms.beds, sizeSqm: estate.rooms.sizeSqm, blurb: estate.rooms.blurb, salePrice: null });
    }
  }
  // Apartments, houses and land are generated for every city from game-data/estate.json, scaled by the city's price index.
  for (const city of geo.cities) {
    const idx = city.priceIndex, base = city.names?.apt ?? 'Maple Court';
    estate.apartments.forEach((u, i) => allProps.push({ id: `prop_${city.id}_apt_${i + 1}`, type: 'apartment', district: city.id, name: `${u.name}, ${base}`, rentPerPeriod: price(u.rent, idx),
      capacity: u.capacity, furnitureSlots: u.furnitureSlots, lot: 'apt', beds: u.beds, sizeSqm: u.sizeSqm, blurb: u.blurb, salePrice: price(u.price, idx) }));
    for (const [lot, u] of Object.entries(estate.houses)) allProps.push({ id: `prop_${city.id}_${lot}`, type: 'house', district: city.id, name: `${u.name}, ${city.name}`, rentPerPeriod: price(u.rent, idx),
      capacity: u.capacity, furnitureSlots: u.furnitureSlots, lot, beds: u.beds, sizeSqm: u.sizeSqm, blurb: u.blurb, salePrice: price(u.price, idx) });
    for (const [lot, u] of Object.entries(estate.land)) allProps.push({ id: `prop_${city.id}_${lot}`, type: 'land', district: city.id, name: `Plot ${lot.slice(-1).toUpperCase()}, ${city.name}`, rentPerPeriod: 0,
      capacity: 1, furnitureSlots: 0, lot, beds: 0, sizeSqm: u.sizeSqm, blurb: `${u.sizeSqm} sqm of empty land. Build your own home on it.`, salePrice: price(u.price, idx), buildCost: price(estate.build.cost, idx) });
  }
  // Landmark businesses (cafes, restaurants, markets, malls) sell food and drink: one shop per area and type, priced by the area.
  const itemById = new Map(items.map((i) => [i.id, i]));
  for (const mw of metroWorlds.values()) for (const z of mw.zones) {
    if (!z.itemIds) continue;
    const city = geo.cities.find((c) => c.id === z.area)!;
    z.items = z.itemIds.map((id: string) => ({ itemId: id, label: itemById.get(id)?.name ?? id }));
    if (!allShops.some((sh) => sh.id === z.shopId)) {
      allShops.push({ id: z.shopId, name: z.label, district: z.area, stock: z.itemIds.map((id: string) => ({ itemId: id, price: Math.max(1, Math.round((itemById.get(id)?.basePrice ?? 10) * city.priceIndex)), quantity: null })) });
    }
    delete z.itemIds;
  }
  const cityById = new Map(geo.cities.map((c) => [c.id, c]));
  const countryById = new Map(geo.countries.map((c) => [c.id, c]));
  return { economy, items, shops: allShops, properties: allProps, jobs, appearance, businesses, chat, achievements, world, geo, phone, estate, worlds, metroWorlds, cityById, countryById, itemIds };
}

export function loadGameData(dir: string): GameData {
  return parseAll((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

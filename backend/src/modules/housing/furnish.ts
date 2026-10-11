import type { AppContext } from '../../context.js';
import { badRequest, conflict } from '../../errors.js';
import { listInventory } from '../inventory/inventory.js';
import * as shop from '../commerce/shop.js';
import { builtHouseSpec } from '../../world/cities.js';
import { currentTenancy, listFurniture, placeFurniture, removeFurniture } from './housing.js';

/**
 * Homes start empty. Furniture is bought from the Home Store (delivered to the inventory) and placed inside the player's own
 * home. Only the owner/tenant sees and can touch their furniture. Placement is validated on the server: inside the walls,
 * clear of the doorway, not on top of other furniture (rugs excepted), and within the property's furniture-slot limit.
 */
const WALL_INSET = 0.45;
export const homeShopId = (cityId: string) => (cityId === 'lagos' ? 'shop_home_store' : `shop_${cityId}_home`);

/** Interior rectangle (world coordinates) of the building that belongs to a lot, plus its door. */
export function interiorOf(ctx: AppContext, cityId: string, lotId: string) {
  const world = ctx.data.worlds.get(cityId);
  const lot = world?.lots?.find((l: any) => l.id === `${cityId}:${lotId}`);
  if (!world || !lot) return null;
  const b = lot.kind === 'land' ? builtHouseSpec(lot).building : world.buildings.find((x: any) => x.id === lot.building);
  if (!b) return null;
  const rect = { minX: b.cx - b.sx / 2 + WALL_INSET, maxX: b.cx + b.sx / 2 - WALL_INSET, minZ: b.cz - b.sz / 2 + WALL_INSET, maxZ: b.cz + b.sz / 2 - WALL_INSET };
  const front = b.doorSide === '+z' ? rect.maxZ : rect.minZ;
  const doorKeepOut = { minX: b.cx - b.doorWidth / 2 - 0.4, maxX: b.cx + b.doorWidth / 2 + 0.4, minZ: b.doorSide === '+z' ? front - 1.3 : front, maxZ: b.doorSide === '+z' ? front : front + 1.3 };
  return { rect, doorKeepOut, building: b };
}

const itemDef = (ctx: AppContext, itemId: string) => {
  const it = ctx.data.items.find((i) => i.id === itemId);
  if (!it || it.category !== 'furniture' || !it.furniture) throw badRequest('not_furniture', 'That is not a piece of furniture.');
  return it as typeof it & { furniture: NonNullable<typeof it.furniture> };
};
const footprint = (def: { sx: number; sz: number }, yaw: number) => (Math.abs(Math.round(Math.sin(yaw))) === 1 ? { w: def.sz, d: def.sx } : { w: def.sx, d: def.sz });
const overlaps = (a: { x: number; z: number; w: number; d: number }, b: { x: number; z: number; w: number; d: number }) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 0.02 && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - 0.02;

/** Everything the "furnish" screen needs. */
export async function homeInfo(ctx: AppContext, characterId: string) {
  const t = await currentTenancy(ctx.pool, characterId);
  if (!t) return { home: null };
  const interior = t.lotId ? interiorOf(ctx, t.district, t.lotId) : null;
  const inv = await listInventory(ctx.pool, characterId);
  return {
    home: { propertyId: t.propertyId, name: t.propertyName, cityId: t.district, lotId: t.lotId, kind: t.kind, slots: t.furnitureSlots },
    rect: interior?.rect ?? null, doorKeepOut: interior?.doorKeepOut ?? null,
    placed: await listFurniture(ctx.pool, characterId),
    owned: inv.filter((i) => ctx.data.items.find((x) => x.id === i.itemId)?.category === 'furniture'),
  };
}

export async function place(ctx: AppContext, characterId: string, cityId: string, itemId: string, x: number, z: number, yaw: number) {
  const def = itemDef(ctx, itemId);
  if (![x, z, yaw].every(Number.isFinite)) throw badRequest('invalid_position');
  const t = await currentTenancy(ctx.pool, characterId);
  if (!t) throw conflict('no_home', 'You do not live anywhere yet.');
  if (ctx.data.cityById.get(t.district)?.metro !== ctx.data.cityById.get(cityId)?.metro) throw conflict('home_elsewhere', 'Your home is in another city.');
  const interior = t.lotId ? interiorOf(ctx, t.district, t.lotId) : null;
  if (!interior) throw conflict('no_interior', 'This home cannot be furnished.');
  const f = footprint(def.furniture, yaw), me = { x, z, w: f.w, d: f.d };
  const r = interior.rect;
  if (x - f.w / 2 < r.minX || x + f.w / 2 > r.maxX || z - f.d / 2 < r.minZ || z + f.d / 2 > r.maxZ) throw conflict('outside_room', 'That does not fit inside your home.');
  const k = interior.doorKeepOut;
  if (def.furniture.h > 0.1 && x + f.w / 2 > k.minX && x - f.w / 2 < k.maxX && z + f.d / 2 > k.minZ && z - f.d / 2 < k.maxZ) throw conflict('blocks_door', 'Keep the doorway clear.');
  if (def.furniture.h > 0.1) {
    for (const p of await listFurniture(ctx.pool, characterId)) {
      const od = ctx.data.items.find((i) => i.id === p.itemId)?.furniture; if (!od || od.h <= 0.1) continue;
      const of = footprint(od, p.yaw);
      if (overlaps(me, { x: p.x, z: p.z, w: of.w, d: of.d })) throw conflict('overlap', 'Something is already standing there.');
    }
  }
  return placeFurniture(ctx, characterId, itemId, { x, y: 0, z, yaw });
}

export async function pickUp(ctx: AppContext, characterId: string, furnitureId: string) {
  return removeFurniture(ctx, characterId, furnitureId);
}

/** The Home Store of the city the player is in (delivery to the inventory). */
export async function storeList(ctx: AppContext, cityId: string) {
  const s = await shop.listShop(ctx, homeShopId(cityId));
  return { shopId: s.shopId, items: s.stock.map((x) => { const d = ctx.data.items.find((i) => i.id === x.itemId)!; return { itemId: x.itemId, name: x.name as string, price: x.price, size: d.furniture ? { sx: d.furniture.sx, sz: d.furniture.sz, h: d.furniture.h } : null }; }) };
}
export async function storeBuy(ctx: AppContext, characterId: string, cityId: string, itemId: string, key: string) {
  itemDef(ctx, itemId);
  const r = await shop.purchase(ctx, characterId, { shopId: homeShopId(cityId), itemId, quantity: 1, idempotencyKey: `${characterId}:store:${key}` });
  return { itemId, paid: r.totalPrice };
}

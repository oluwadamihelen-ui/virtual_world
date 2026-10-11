/**
 * Every city's neighbourhood is generated from the hand-built Maple Court template (game-data/world.json):
 * same rules and layout vocabulary, but mirrored, re-coloured and renamed per city so each place looks and feels
 * different. Server collision and client rendering both consume the generated result, so they always agree.
 */
export interface GeoCity {
  id: string; country: string; name: string; lat: number; lon: number; priceIndex: number; blurb: string;
  mirror?: 'none' | 'x' | 'z' | 'xz';
  theme?: { ground: string; road: string; buildings: string[]; roofs: string[] };
  names?: Record<string, string>;
}

const ORDER = ['apt', 'grocery', 'cafe', 'jobs', 'bank'];

export const cityShopId = (cityId: string) => (cityId === 'lagos' ? 'shop_corner_grocery' : `shop_${cityId}_grocery`);

export function generateWorld(base: any, city: GeoCity): any {
  const w: any = structuredClone(base);
  w.cityId = city.id;
  const names = { ...w.names, ...(city.names ?? {}) };
  w.names = names;
  if (city.theme) {
    w.theme = { ...w.theme, ground: city.theme.ground, road: city.theme.road };
    for (const b of w.buildings) {
      const i = ORDER.indexOf(b.id);
      if (i >= 0) { b.wall = city.theme.buildings[i % city.theme.buildings.length]; b.roof = city.theme.roofs[i % city.theme.roofs.length]; }
    }
  }
  for (const b of w.buildings) {
    if (names[b.id]) b.name = names[b.id];
    if (b.sign) b.sign = `${b.name} - coming soon`;
  }
  for (const z of w.zones) {
    if (z.kind === 'door') z.label = names.apt;
    if (z.kind === 'shop') { z.label = `${names.grocery} counter`; z.shopId = cityShopId(city.id); }
  }
  w.district = { id: city.id, name: city.name, place: names.apt.replace(/ (Apartments|Flats|Residences|Court)$/, '') };

  const mx = city.mirror === 'x' || city.mirror === 'xz', mz = city.mirror === 'z' || city.mirror === 'xz';
  if (mx || mz) {
    const fx = (x: number) => (mx ? -x : x), fz = (z: number) => (mz ? -z : z);
    for (const b of w.buildings) { b.cx = fx(b.cx); b.cz = fz(b.cz); if (mz && b.doorSide) b.doorSide = b.doorSide === '+z' ? '-z' : '+z'; }
    for (const f of w.furniture) { f.x = fx(f.x); f.z = fz(f.z); }
    for (const p of w.props) {
      p.x = fx(p.x); p.z = fz(p.z);
      if (p.type === 'bench' && p.ry != null) { if (mz) p.ry = Math.PI - p.ry; if (mx) p.ry = -p.ry; }
    }
    for (const z of w.zones) { z.x = fx(z.x); z.z = fz(z.z); }
    w.spawn = { x: fx(w.spawn.x), z: fz(w.spawn.z) };
    w.park = { ...w.park, cx: fx(w.park.cx), cz: fz(w.park.cz) };
    w.npcRoutes = w.npcRoutes.map((r: { x: number; z: number }[]) => r.map((pt) => ({ x: fx(pt.x), z: fz(pt.z) })));
  }
  return w;
}

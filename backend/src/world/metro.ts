import { generateWorld, type GeoCity } from './cities.js';
import { ENTERABLE, layoutInterior } from './interiors.js';

/**
 * A metro (Lagos, Abuja, ...) is ONE continuous world made of its districts (areas) laid out on a grid with avenues between them,
 * a lagoon with bridges where the data says so, and landmark/business buildings (POIs) along the avenues and the outskirts.
 * Everything uses the same coordinate system, so a player can simply walk from one area to the next. The hub district sits at
 * the origin. Element ids are prefixed with their district id ("ikeja:grocery") so they are unique in the metro.
 */
export interface MetroDef { cols: number; order: string[]; water?: boolean; pois: { type: string; name: string; district?: string }[] }
export interface MetroFile { gap: number; margin: number; metros: Record<string, MetroDef> }

/** Which landmark types are open for business (you can buy things there) and what they sell. */
export const POI_SHOPS: Record<string, string[]> = {
  cafe: ['coffee', 'croissant', 'snack_bar'], restaurant: ['sandwich', 'bottled_water', 'snack_bar'], pub: ['sandwich', 'bottled_water', 'snack_bar'],
  market: ['bottled_water', 'sandwich', 'snack_bar'], mall: ['bottled_water', 'coffee', 'snack_bar'],
};

/** Footprint and look of each point-of-interest type. `walk` types are open ground you can walk on (no wall collider). */
export const POI_TYPES: Record<string, { sx: number; sz: number; h: number; walk?: boolean; business?: boolean; emoji: string }> = {
  church: { sx: 9, sz: 12, h: 5, emoji: '⛪' }, mosque: { sx: 11, sz: 11, h: 5, emoji: '🕌' }, market: { sx: 14, sz: 10, h: 3, walk: true, business: true, emoji: '🛍️' },
  hospital: { sx: 13, sz: 9, h: 7, emoji: '🏥' }, clinic: { sx: 8, sz: 7, h: 4, emoji: '🩺' }, police: { sx: 9, sz: 8, h: 4, emoji: '🚓' }, school: { sx: 12, sz: 8, h: 4, emoji: '🏫' },
  university: { sx: 14, sz: 10, h: 6, emoji: '🎓' }, stadium: { sx: 20, sz: 15, h: 6, emoji: '🏟️' }, park: { sx: 12, sz: 12, h: 0, walk: true, emoji: '🌳' },
  beach: { sx: 14, sz: 10, h: 0, walk: true, emoji: '🏖️' }, golf: { sx: 16, sz: 12, h: 0, walk: true, emoji: '⛳' }, hotel: { sx: 9, sz: 9, h: 14, business: true, emoji: '🏨' },
  restaurant: { sx: 8, sz: 7, h: 3.4, business: true, emoji: '🍽️' }, cafe: { sx: 7, sz: 6, h: 3.2, business: true, emoji: '☕' }, salon: { sx: 6, sz: 6, h: 3.2, business: true, emoji: '💇' },
  gym: { sx: 9, sz: 7, h: 4, business: true, emoji: '🏋️' }, cinema: { sx: 11, sz: 8, h: 6, business: true, emoji: '🎬' }, library: { sx: 9, sz: 8, h: 4.4, emoji: '📚' },
  bank: { sx: 8, sz: 8, h: 5, business: true, emoji: '🏦' }, mall: { sx: 16, sz: 11, h: 5, business: true, emoji: '🏬' }, garage: { sx: 9, sz: 7, h: 3.4, business: true, emoji: '🔧' },
  office: { sx: 8, sz: 8, h: 16, business: true, emoji: '🏢' }, studio: { sx: 7, sz: 7, h: 4, business: true, emoji: '📻' }, dock: { sx: 12, sz: 8, h: 0, walk: true, emoji: '⛴️' },
  museum: { sx: 11, sz: 8, h: 5, emoji: '🏛️' }, gov: { sx: 13, sz: 9, h: 6, emoji: '🏛️' }, tech: { sx: 8, sz: 8, h: 9, business: true, emoji: '💡' }, pub: { sx: 8, sz: 7, h: 3.6, business: true, emoji: '🍺' },
};

const HASH = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const COLORS = ['#e9c46a', '#9bc1bc', '#e29578', '#b8c0ff', '#a8dadc', '#f4a261', '#cdb4db', '#90be6d', '#f28482', '#84a59d'];
const ROOFS = ['#b5833a', '#5d8a85', '#b45f45', '#7a7fc0', '#6b9ea3', '#c0783a', '#9b7fb0', '#5f9a49', '#c25a58', '#587a70'];

export function buildMetroWorld(base: any, cities: GeoCity[], metroId: string, file: MetroFile): any {
  const def = file.metros[metroId] ?? { cols: 1, order: [], pois: [] };
  const areas = cities.filter((c) => c.metro === metroId);
  const hub = areas.find((c) => (c as any).hub) ?? areas[0]!;
  const order = [...def.order.filter((id) => areas.some((a) => a.id === id)), ...areas.map((a) => a.id).filter((id) => !def.order.includes(id))];
  const cols = Math.max(1, Math.min(def.cols || order.length, order.length)), rows = Math.ceil(order.length / cols);
  const Wd = base.bounds.maxX - base.bounds.minX, Hd = base.bounds.maxZ - base.bounds.minZ;
  const pitchX = Wd + file.gap, pitchZ = Hd + file.gap;
  const cell = (i: number) => ({ c: i % cols, r: Math.floor(i / cols) });
  const hubCell = cell(order.indexOf(hub.id));
  const center = (c: number, r: number) => ({ x: (c - hubCell.c) * pitchX, z: (r - hubCell.r) * pitchZ });

  const w: any = { name: hub.name, metro: metroId, cityId: hub.id, districts: [], buildings: [], furniture: [], props: [], zones: [], lots: [], npcRoutes: [], npcSpecs: [], roads: [], water: [], bridges: [], blockers: [], pois: [] };
  for (let i = 0; i < order.length; i++) {
    const city = areas.find((a) => a.id === order[i])!, { c, r } = cell(i), o = center(c, r), dw = generateWorld(base, city), a = city.id;
    const P = (id: string) => `${a}:${id}`;
    for (const b of dw.buildings) w.buildings.push({ ...b, id: P(b.id), cx: b.cx + o.x, cz: b.cz + o.z, gate: b.gate ? P(b.gate) : undefined, area: a, short: b.id });
    // the template's cafe, bank and job centre were scenery with a sign; make them real walk-in public buildings facing the street
    for (const b of w.buildings) {
      const type = b.area === a ? ({ cafe: 'cafe', bank: 'bank', jobs: 'gov' } as Record<string, string>)[b.short] : undefined;
      if (!type || b.enterable) continue;
      const front: 1 | -1 = b.cz - o.z > 0 ? -1 : 1;
      Object.assign(b, { enterable: true, kind: 'public', poi: true, sign: undefined, doorSide: front === 1 ? '+z' : '-z', doorWidth: 2.4, height: Math.max(3.2, b.height ?? 3.2) });
      const lay = layoutInterior({ id: b.id, type, x: b.cx, z: b.cz, sx: b.sx, sz: b.sz }, b.id, front);
      if (!lay) continue;
      b.floor = lay.plan.floor; w.furniture.push(...lay.furniture);
      for (const sp of lay.npcs) w.npcSpecs.push({ ...sp, poi: b.id, area: a });
      const zp = lay.counterZone ?? { x: b.cx, z: b.cz + front * (b.sz / 2 - 1.7) };
      const svc = lay.plan.service ?? { label: 'Counter', text: 'Welcome in. Table service is coming soon.' };
      w.zones.push({ id: `${b.id}_svc`, kind: 'service', poi: b.id, building: b.id, area: a, x: zp.x, z: zp.z, radius: 2.4, label: svc.label, title: b.name, text: svc.text, bank: !!svc.bank });
    }
    for (const f of dw.furniture) w.furniture.push({ ...f, id: P(f.id), building: P(f.building), x: f.x + o.x, z: f.z + o.z });
    for (const p of dw.props) w.props.push({ ...p, x: p.x + o.x, z: p.z + o.z });
    for (const z of dw.zones) w.zones.push({ ...z, id: P(z.id), building: z.building ? P(z.building) : undefined, area: a, x: z.x + o.x, z: z.z + o.z });
    for (const l of dw.lots ?? []) w.lots.push({ ...l, id: P(l.id), key: l.id, area: a, cx: l.cx + o.x, cz: l.cz + o.z, building: l.building ? P(l.building) : undefined });
    for (const rt of dw.npcRoutes) w.npcRoutes.push(rt.map((pt: any) => ({ x: pt.x + o.x, z: pt.z + o.z })));
    const bd = dw.bounds;
    w.districts.push({
      id: a, name: city.name, names: dw.names, theme: dw.theme, country: city.country, cell: { c, r }, center: o,
      bounds: { minX: bd.minX + o.x, maxX: bd.maxX + o.x, minZ: bd.minZ + o.z, maxZ: bd.maxZ + o.z },
      park: { ...dw.park, cx: dw.park.cx + o.x, cz: dw.park.cz + o.z }, road: { minZ: dw.road.minZ + o.z, maxZ: dw.road.maxZ + o.z }, spawn: { x: dw.spawn.x + o.x, z: dw.spawn.z + o.z },
    });
  }
  const hubD = w.districts.find((d: any) => d.id === hub.id);
  w.district = dw0(hubD); w.names = hubD.names; w.theme = hubD.theme; w.spawn = hubD.spawn; w.landmark = (hub as any).landmark;
  function dw0(d: any) { return { id: d.id, name: d.name, place: d.names.apt }; }

  // overall bounds
  const bx = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const d of w.districts) { bx.minX = Math.min(bx.minX, d.bounds.minX); bx.maxX = Math.max(bx.maxX, d.bounds.maxX); bx.minZ = Math.min(bx.minZ, d.bounds.minZ); bx.maxZ = Math.max(bx.maxZ, d.bounds.maxZ); }
  const M = file.margin;
  w.bounds = { minX: bx.minX - M, maxX: bx.maxX + M, minZ: bx.minZ - M, maxZ: bx.maxZ + M };
  w.core = bx;

  // roads: a street through every row across the whole metro, and an avenue in every gap between columns
  const rowZ = (r: number) => center(0, r).z;
  for (let r = 0; r < rows; r++) w.roads.push({ minX: w.bounds.minX, maxX: w.bounds.maxX, minZ: rowZ(r) - 4, maxZ: rowZ(r) + 4, kind: 'street' });
  const avenueX: number[] = [];
  for (let c = 0; c < cols - 1; c++) { const x = (c + 0.5 - hubCell.c) * pitchX; avenueX.push(x); w.roads.push({ minX: x - 4, maxX: x + 4, minZ: w.bounds.minZ, maxZ: w.bounds.maxZ, kind: 'avenue' }); }
  w.avenueX = avenueX; w.rowZ = Array.from({ length: rows }, (_, r) => rowZ(r));

  // lagoon between rows, crossed by bridges where the avenues are (players can only cross there)
  if (def.water && rows >= 2) {
    for (let r = 0; r < rows - 1; r++) {
      const zc = (rowZ(r) + rowZ(r + 1)) / 2, half = 11;
      const water = { minX: w.bounds.minX, maxX: w.bounds.maxX, minZ: zc - half, maxZ: zc + half };
      w.water.push(water);
      const gaps = avenueX.length ? avenueX : [0];
      let x0 = water.minX;
      for (const x of [...gaps].sort((p, q) => p - q)) { if (x - 7 > x0) w.blockers.push({ minX: x0, maxX: x - 7, minZ: water.minZ, maxZ: water.maxZ }); x0 = x + 7; }
      if (water.maxX > x0) w.blockers.push({ minX: x0, maxX: water.maxX, minZ: water.minZ, maxZ: water.maxZ });
      for (const x of gaps) w.bridges.push({ x, z: zc, w: 14, d: half * 2 });
    }
  }

  // points of interest along the avenues, the street gaps and the outskirts
  const forbidden: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [
    ...w.districts.map((d: any) => ({ minX: d.bounds.minX - 1, maxX: d.bounds.maxX + 1, minZ: d.bounds.minZ - 1, maxZ: d.bounds.maxZ + 1 })),
    ...w.water.map((x: any) => ({ ...x, minZ: x.minZ - 2, maxZ: x.maxZ + 2 })),
    ...w.roads.map((x: any) => ({ minX: x.minX - 1, maxX: x.maxX + 1, minZ: x.minZ - 1, maxZ: x.maxZ + 1 })),
  ];
  const slots: { x: number; z: number }[] = [];
  const STEP = 11;
  for (const x of avenueX) for (const side of [-1, 1]) for (let z = w.bounds.minZ + 8; z <= w.bounds.maxZ - 8; z += STEP) slots.push({ x: x + side * 14, z });
  for (let r = 0; r < rows; r++) for (const side of [-1, 1]) for (let x = w.bounds.minX + 10; x <= w.bounds.maxX - 10; x += STEP) slots.push({ x, z: rowZ(r) + side * 12 });
  for (const side of [-1, 1]) for (let z = w.bounds.minZ + 8; z <= w.bounds.maxZ - 8; z += STEP) { slots.push({ x: (side < 0 ? w.bounds.minX : w.bounds.maxX) - side * 13, z }); }
  for (const side of [-1, 1]) for (let x = w.bounds.minX + 10; x <= w.bounds.maxX - 10; x += STEP) slots.push({ x, z: (side < 0 ? w.bounds.minZ : w.bounds.maxZ) - side * 13 });
  const hit = (a: any, b: any, m = 0) => a.minX < b.maxX + m && a.maxX > b.minX - m && a.minZ < b.maxZ + m && a.maxZ > b.minZ - m;
  const placed: any[] = [];
  const dist = (p: { x: number; z: number }, q: { x: number; z: number }) => Math.hypot(p.x - q.x, p.z - q.z);
  def.pois.forEach((p, i) => {
    const t = POI_TYPES[p.type]; if (!t) return;
    const target = p.district ? w.districts.find((d: any) => d.id === p.district)?.center ?? { x: 0, z: 0 } : { x: 0, z: 0 };
    const ranked = [...slots].sort((a, b) => dist(a, target) - dist(b, target) + ((HASH(`${metroId}${i}`) % 7) - 3) * 0.5);
    for (const s of ranked) {
      const box = { minX: s.x - t.sx / 2, maxX: s.x + t.sx / 2, minZ: s.z - t.sz / 2, maxZ: s.z + t.sz / 2 };
      if (box.minX < w.bounds.minX + 1 || box.maxX > w.bounds.maxX - 1 || box.minZ < w.bounds.minZ + 1 || box.maxZ > w.bounds.maxZ - 1) continue;
      if (forbidden.some((f) => hit(box, f)) || placed.some((q) => hit(box, q, 2.5))) continue;
      placed.push(box);
      const nearRow = w.rowZ.reduce((best: number, z: number) => (Math.abs(z - s.z) < Math.abs(best - s.z) ? z : best), w.rowZ[0]);
      const h = HASH(`${metroId}:${p.name}`);
      const district = w.districts.reduce((best: any, d: any) => (dist(d.center, s) < dist(best.center, s) ? d : best), w.districts[0]);
      const poiObj = ({ id: `poi_${i}`, type: p.type, name: p.name, x: s.x, z: s.z, sx: t.sx, sz: t.sz, h: t.h, walk: !!t.walk, business: !!t.business, emoji: t.emoji,
        face: nearRow > s.z ? '+z' : '-z', wall: COLORS[h % COLORS.length], roof: ROOFS[h % ROOFS.length], district: district.id });
      const f: 1 | -1 = poiObj.face === '+z' ? 1 : -1;
      const enterable = ENTERABLE.has(p.type) && !t.walk;
      (poiObj as any).enterable = enterable;
      w.pois.push(poiObj);
      if (enterable) {
        // a real building you can walk into: open doorway, furnished inside, with staff and customers
        const b = { id: poiObj.id, name: p.name, cx: s.x, cz: s.z, sx: t.sx, sz: t.sz, height: Math.max(3.2, t.h), doorSide: poiObj.face, doorWidth: 2.4, wall: poiObj.wall, roof: poiObj.roof,
          floor: '#d9d2c0', enterable: true, kind: 'public', poi: true, area: district.id, short: p.type };
        const lay = layoutInterior({ id: poiObj.id, type: p.type, x: s.x, z: s.z, sx: t.sx, sz: t.sz }, b.id, f);
        if (lay) {
          b.floor = lay.plan.floor; w.buildings.push(b); w.furniture.push(...lay.furniture);
          for (const sp of lay.npcs) w.npcSpecs.push({ ...sp, poi: poiObj.id, area: district.id });
          const zp = lay.counterZone ?? { x: s.x, z: s.z + f * (t.sz / 2 - 1.7) };
          if (POI_SHOPS[p.type]) w.zones.push({ id: `${poiObj.id}_shop`, kind: 'shop', poi: poiObj.id, building: b.id, area: district.id, x: zp.x, z: zp.z, radius: 2.4, label: p.name, shopId: `shop_${district.id}_${p.type}`, shopType: p.type, itemIds: POI_SHOPS[p.type] });
          else if (lay.plan.service) w.zones.push({ id: `${poiObj.id}_svc`, kind: 'service', poi: poiObj.id, building: b.id, area: district.id, x: zp.x, z: zp.z, radius: 2.4, label: lay.plan.service.label, title: p.name, text: lay.plan.service.text, bank: !!lay.plan.service.bank });
        }
      } else {
        // open-air places (parks, beaches, markets, the dock...): people strolling about
        const strollers = p.type === 'market' ? 7 : p.type === 'park' ? 5 : p.type === 'beach' ? 5 : 3;
        w.npcSpecs.push({ kind: 'wander', role: p.type === 'market' ? 'Shopper' : 'Visitor', poi: poiObj.id, area: district.id, count: strollers, rect: { minX: s.x - t.sx / 2 + 1.5, maxX: s.x + t.sx / 2 - 1.5, minZ: s.z - t.sz / 2 + 1.5, maxZ: s.z + t.sz / 2 - 1.5 } });
        if (POI_SHOPS[p.type]) w.zones.push({ id: `${poiObj.id}_shop`, kind: 'shop', poi: poiObj.id, area: district.id, x: s.x, z: s.z + f * (t.sz / 2 + 1.6), radius: 2.6, label: p.name, shopId: `shop_${district.id}_${p.type}`, shopType: p.type, itemIds: POI_SHOPS[p.type] });
      }
      break;
    }
  });

  // streetlamps along the avenues and the streets between districts
  const inDistrict = (x: number, z: number) => w.districts.some((d: any) => x > d.bounds.minX - 2 && x < d.bounds.maxX + 2 && z > d.bounds.minZ - 2 && z < d.bounds.maxZ + 2);
  const inWater = (x: number, z: number) => w.water.some((q: any) => x > q.minX && x < q.maxX && z > q.minZ - 1 && z < q.maxZ + 1);
  for (const x of avenueX) for (let z = w.bounds.minZ + 10; z < w.bounds.maxZ - 6; z += 18) for (const s of [-5.5, 5.5]) if (!inDistrict(x + s, z) && !inWater(x + s, z)) w.props.push({ type: 'lamp', x: x + s, z });
  for (let r = 0; r < rows; r++) for (let x = w.bounds.minX + 10; x < w.bounds.maxX - 6; x += 18) for (const s of [-5.5, 5.5]) if (!inDistrict(x, rowZ(r) + s)) w.props.push({ type: 'lamp', x, z: rowZ(r) + s });
  // townspeople walking the long streets and avenues
  for (let r = 0; r < rows; r++) w.npcRoutes.push([{ x: w.bounds.minX + 6, z: rowZ(r) + 6.8 }, { x: w.bounds.maxX - 6, z: rowZ(r) + 6.8 }]);
  for (const x of avenueX) w.npcRoutes.push([{ x: x + 6.8, z: w.bounds.minZ + 8 }, { x: x + 6.8, z: w.bounds.maxZ - 8 }]);
  return w;
}

/** Which district contains a point? (null in the gaps between districts) */
export function districtAt(world: any, x: number, z: number): string | null {
  for (const d of world.districts) if (x >= d.bounds.minX && x <= d.bounds.maxX && z >= d.bounds.minZ && z <= d.bounds.maxZ) return d.id;
  return null;
}

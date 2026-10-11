/**
 * Public buildings (banks, cafes, hospitals, churches...) are real, walk-in places: a hollow building with an open doorway, a service
 * counter with staff behind it, furniture along the walls, a clear walkway down the middle and customers going about their business.
 * This file lays out one interior from a few numbers per building type. Coordinates are world coordinates.
 */
export interface Plan {
  counter?: { len: number; h: number; color: string }; side: 'table' | 'bench' | 'shelf' | 'seats' | 'desk' | 'gym' | 'cars' | 'plinth' | 'plain';
  staff: number; visitors: number; floor: string;
  service?: { label: string; text: string; bank?: boolean };
}

export const PLANS: Record<string, Plan> = {
  bank: { counter: { len: 7, h: 1.1, color: '#6b7a8f' }, side: 'bench', staff: 2, visitors: 4, floor: '#d7d3c8', service: { label: 'Teller', text: 'Use the Vault app for your account, transfers and loans.', bank: true } },
  cafe: { counter: { len: 5, h: 1.1, color: '#8a5a2b' }, side: 'table', staff: 1, visitors: 4, floor: '#e0cfae' },
  restaurant: { counter: { len: 5, h: 1.1, color: '#8a5a2b' }, side: 'table', staff: 2, visitors: 5, floor: '#e0cfae' },
  pub: { counter: { len: 6, h: 1.1, color: '#5b3a1e' }, side: 'table', staff: 1, visitors: 5, floor: '#c9b48a' },
  salon: { counter: { len: 3, h: 1.0, color: '#d98aa9' }, side: 'seats', staff: 2, visitors: 3, floor: '#efe3ea', service: { label: 'Reception', text: 'The salon is busy. Booking a style is not in the game yet.' } },
  gym: { counter: { len: 3, h: 1.0, color: '#3f6fa3' }, side: 'gym', staff: 1, visitors: 5, floor: '#c9ccd2', service: { label: 'Reception', text: 'Everyone here is training. Memberships are not in the game yet.' } },
  cinema: { counter: { len: 4, h: 1.1, color: '#8c2f2f' }, side: 'seats', staff: 1, visitors: 5, floor: '#4a3a52', service: { label: 'Box office', text: 'Now showing: nothing yet. Films are not in the game yet.' } },
  library: { counter: { len: 3, h: 1.1, color: '#8a5a2b' }, side: 'shelf', staff: 1, visitors: 4, floor: '#d9cfb8', service: { label: 'Library desk', text: 'Quiet, please. Borrowing books is not in the game yet.' } },
  hospital: { counter: { len: 5, h: 1.1, color: '#e8eef2' }, side: 'bench', staff: 2, visitors: 5, floor: '#e9eef0', service: { label: 'Reception', text: 'Nurses and patients everywhere. Treatment is not in the game yet.' } },
  clinic: { counter: { len: 3.5, h: 1.1, color: '#e8eef2' }, side: 'bench', staff: 1, visitors: 3, floor: '#e9eef0', service: { label: 'Reception', text: 'A busy family clinic. Treatment is not in the game yet.' } },
  police: { counter: { len: 4, h: 1.1, color: '#34496e' }, side: 'bench', staff: 2, visitors: 3, floor: '#cfd3da', service: { label: 'Front desk', text: 'Officers are on duty. Reporting crimes is done with the Report option on a player.' } },
  school: { counter: { len: 3, h: 1.1, color: '#8a5a2b' }, side: 'desk', staff: 2, visitors: 6, floor: '#d9d2bd', service: { label: 'School office', text: 'Lessons are in session. Courses are not in the game yet.' } },
  university: { counter: { len: 4, h: 1.1, color: '#8a5a2b' }, side: 'desk', staff: 2, visitors: 7, floor: '#d9d2bd', service: { label: 'Registry', text: 'Students are hurrying to class. Courses are not in the game yet.' } },
  hotel: { counter: { len: 4, h: 1.1, color: '#7a5a2e' }, side: 'bench', staff: 2, visitors: 4, floor: '#e6dcc4', service: { label: 'Reception', text: 'Welcome. Overnight stays are not in the game yet.' } },
  office: { counter: { len: 3.5, h: 1.1, color: '#4a5568' }, side: 'desk', staff: 2, visitors: 4, floor: '#d4d8de', service: { label: 'Reception', text: 'Offices upstairs. Office jobs are not in the game yet.' } },
  tech: { counter: { len: 3.5, h: 1.1, color: '#4a5568' }, side: 'desk', staff: 1, visitors: 5, floor: '#d4d8de', service: { label: 'Reception', text: 'Start-ups hot-desking. Not in the game yet.' } },
  studio: { counter: { len: 3, h: 1.1, color: '#2d3340' }, side: 'desk', staff: 2, visitors: 2, floor: '#2f3340', service: { label: 'Studio desk', text: 'On air. Radio shows are not in the game yet.' } },
  garage: { counter: { len: 3, h: 1.1, color: '#c0783a' }, side: 'cars', staff: 2, visitors: 2, floor: '#aeb2b8', service: { label: 'Service desk', text: 'Mechanics at work. Buying and repairing cars is not in the game yet.' } },
  museum: { counter: { len: 3, h: 1.1, color: '#7a6a4e' }, side: 'plinth', staff: 1, visitors: 5, floor: '#e3dccb', service: { label: 'Ticket desk', text: 'Visitors admire the exhibits. Tickets are not in the game yet.' } },
  gov: { counter: { len: 6, h: 1.1, color: '#6b7a8f' }, side: 'bench', staff: 3, visitors: 5, floor: '#dad6cc', service: { label: 'Service window', text: 'Queues for permits. Government services are not in the game yet.' } },
  church: { counter: { len: 2.5, h: 1.0, color: '#e8e2d0' }, side: 'seats', staff: 1, visitors: 6, floor: '#d9cfb8', service: { label: 'Welcome', text: 'A quiet moment. Visitors are welcome.' } },
  mosque: { side: 'plain', staff: 1, visitors: 6, floor: '#7fb1a2', service: undefined },
  mall: { counter: { len: 5, h: 1.1, color: '#e07a5f' }, side: 'table', staff: 3, visitors: 8, floor: '#e4dfd3', service: { label: 'Information', text: 'Shops are busy. Mall shops are not in the game yet.' } },
  stadium: { side: 'plain', staff: 0, visitors: 9, floor: '#4fa14b', service: undefined },
};
export const ENTERABLE = new Set(Object.keys(PLANS));

export interface NpcSpec { kind: 'stand' | 'wander'; role: string; x?: number; z?: number; ry?: number; rect?: { minX: number; maxX: number; minZ: number; maxZ: number }; count?: number }
export interface InteriorOut { furniture: any[]; npcs: NpcSpec[]; counterZone: { x: number; z: number } | null; plan: Plan }

const WALL = 0.3;
export function layoutInterior(p: { id: string; type: string; x: number; z: number; sx: number; sz: number }, buildingId: string, front: 1 | -1): InteriorOut | null {
  const plan = PLANS[p.type]; if (!plan) return null;
  const iX = p.sx / 2 - WALL - 0.2, iV = p.sz / 2 - WALL - 0.2;           // half-extents of the usable floor
  const Z = (dv: number) => p.z + front * dv;                            // dv: depth from the middle, positive toward the door
  const furniture: any[] = []; let n = 0;
  const add = (x: number, dv: number, sx: number, sz: number, h: number, color: string) => furniture.push({ id: `${buildingId}_f${n++}`, building: buildingId, x, z: Z(dv), sx, sz, h, color });
  const npcs: NpcSpec[] = [];
  let counterZone: { x: number; z: number } | null = null;

  const backV = -(iV - 1.5);
  if (plan.counter) {
    const len = Math.min(plan.counter.len, p.sx - 2.2);
    add(p.x, backV, len, 0.9, plan.counter.h, plan.counter.color);
    for (let i = 0; i < plan.staff; i++) { const off = plan.staff === 1 ? 0 : ((i / (plan.staff - 1)) - 0.5) * (len - 1.4); npcs.push({ kind: 'stand', role: 'Staff', x: p.x + off, z: Z(-(iV - 0.55)), ry: front > 0 ? 0 : Math.PI }); }
    counterZone = { x: p.x, z: Z(backV + 1.65) };
  } else {
    for (let i = 0; i < plan.staff; i++) npcs.push({ kind: 'stand', role: 'Staff', x: p.x + (i - (plan.staff - 1) / 2) * 1.6, z: Z(-(iV - 1)), ry: front > 0 ? 0 : Math.PI });
  }
  // side furniture on both walls, leaving a clear walkway down the middle and a clear doorway
  const sideX = Math.max(1.2, iX * 0.74), vFrom = backV + 2.6, vTo = iV - 2.2;
  for (const s of [-1, 1]) {
    const x = p.x + s * sideX;
    switch (plan.side) {
      case 'table': for (let v = vFrom; v <= vTo; v += 2.4) { add(x, v, 1.0, 1.0, 0.75, '#a77a4a'); add(x - s * 0.8, v, 0.4, 0.4, 0.45, '#5b3a1e'); } break;
      case 'bench': for (let v = vFrom; v <= vTo; v += 2.2) add(x, v, 0.55, 1.8, 0.5, '#7a5a2e'); break;
      case 'shelf': add(p.x + s * (iX - 0.3), (vFrom + vTo) / 2, 0.55, Math.max(2, vTo - vFrom), 2.0, '#9c6a3a'); break;
      case 'seats': for (let v = vFrom; v <= vTo; v += 1.4) add(x, v, 2.0, 0.6, 0.55, plan.counter?.color ?? '#8c2f2f'); break;
      case 'desk': for (let v = vFrom; v <= vTo; v += 2.2) add(x, v, 1.5, 0.75, 0.75, '#b9a07a'); break;
      case 'gym': for (let v = vFrom; v <= vTo; v += 2.2) add(x, v, 0.9, 1.7, 1.1, '#3b4252'); break;
      case 'cars': add(x, (vFrom + vTo) / 2, 1.9, Math.min(4.2, vTo - vFrom), 1.3, s < 0 ? '#c0392b' : '#2980b9'); break;
      case 'plinth': for (let v = vFrom; v <= vTo; v += 2.4) add(x, v, 0.8, 0.8, 1.1, '#cfc8b7'); break;
      default: break;
    }
  }
  // customers wander the walkway (never the doorway), pausing now and then
  const rect = { minX: p.x - Math.max(1.0, iX * 0.45), maxX: p.x + Math.max(1.0, iX * 0.45), minZ: 0, maxZ: 0 };
  const v0 = counterZone ? backV + 2.4 : -(iV - 1.2), v1 = iV - 1.7;
  const za = Z(v0), zb = Z(Math.max(v0 + 1.2, v1));
  rect.minZ = Math.min(za, zb); rect.maxZ = Math.max(za, zb);
  if (p.type === 'stadium') { rect.minX = p.x - iX + 1; rect.maxX = p.x + iX - 1; rect.minZ = p.z - iV + 1; rect.maxZ = p.z + iV - 1; }
  npcs.push({ kind: 'wander', role: p.type === 'mosque' || p.type === 'church' ? 'Worshipper' : p.type === 'stadium' ? 'Fan' : 'Customer', rect, count: plan.visitors });
  return { furniture, npcs, counterZone, plan };
}

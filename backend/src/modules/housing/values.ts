import type { AppContext } from '../../context.js';
import { withTx } from '../../db.js';

/**
 * Area value index: 1.00 = launch prices. It follows population: residents = NPC settlers (who move in at a steady
 * per-area rate, capped) + real players living there. The index chases a target (+0.1 per resident above the starting
 * crowd, clamped to a floor and ceiling) by at most `stepPerUpdate` every `updateMinutes`, so it moves smoothly, not in jumps.
 * Early buyers in a growing area profit when they sell; selling costs `sellFeePercent`. Everything is data-driven (estate.json).
 */
export const priceNow = (base: number, idx: number) => Math.max(50, Math.round((base * idx) / 50) * 50);
const LIVE = ['active', 'grace'];

export async function areaIndex(q: { query: (s: string, p?: any[]) => Promise<any> }, area: string): Promise<number> {
  const r = await q.query('SELECT idx FROM area_values WHERE area=$1', [area]);
  return r.rows[0] ? Number(r.rows[0].idx) : 1;
}

async function ensureRows(ctx: AppContext) {
  const now = ctx.now();
  for (const c of ctx.data.geo.cities) await ctx.pool.query('INSERT INTO area_values (area, idx, residents, created_at, updated_at) VALUES ($1,1,$2,$3,$3) ON CONFLICT (area) DO NOTHING', [c.id, ctx.data.estate.values.startSettlers, now]);
}

const settlersAt = (ctx: AppContext, area: string, createdAt: Date, t: Date) => {
  const e = ctx.data.estate, rate = e.settlersPerDay[area] ?? e.settlersPerDay.default ?? 0.4;
  const days = Math.max(0, (t.getTime() - createdAt.getTime()) / 86_400_000);
  return Math.min(e.maxSettlers, e.values.startSettlers + rate * days);
};

/** Bring every area's index up to date (catches up if the server was off). Safe to call often. */
export async function updateAreaValues(ctx: AppContext) {
  const v = ctx.data.estate.values, stepMs = v.updateMinutes * 60_000, now = ctx.now();
  const have = Number((await ctx.pool.query('SELECT count(*)::int n FROM area_values')).rows[0].n);
  if (have < ctx.data.geo.cities.length) await ensureRows(ctx);
  const areas = (await ctx.pool.query('SELECT area FROM area_values WHERE updated_at <= $1', [new Date(now.getTime() - stepMs)])).rows.map((r) => r.area as string);
  for (const area of areas) {
    await withTx(ctx.pool, async (tx) => {
      const row = (await tx.query('SELECT * FROM area_values WHERE area=$1 FOR UPDATE', [area])).rows[0];
      const last: Date = row.updated_at, n = Math.min(2000, Math.floor((now.getTime() - last.getTime()) / stepMs));
      if (n < 1) return;
      const players = Number((await tx.query(`SELECT count(*)::int n FROM tenancies t JOIN properties p ON p.id=t.property_id WHERE p.district=$1 AND t.status = ANY($2)`, [area, LIVE])).rows[0].n);
      let idx = Number(row.idx), residents = Number(row.residents);
      const every = Math.max(1, Math.floor(n / 24));
      for (let k = 1; k <= n; k++) {
        const t = new Date(last.getTime() + k * stepMs);
        residents = settlersAt(ctx, area, row.created_at, t) + players;
        const target = Math.min(v.ceiling, Math.max(v.floor, 1 + v.valuePerResident * (residents - v.startSettlers)));
        idx += Math.max(-v.stepPerUpdate, Math.min(v.stepPerUpdate, target - idx));
        if (k % every === 0 || k === n) await tx.query('INSERT INTO area_value_history (area, idx, residents, at) VALUES ($1,$2,$3,$4)', [area, idx, residents, t]);
      }
      await tx.query('UPDATE area_values SET idx=$2, residents=$3, updated_at=$4 WHERE area=$1', [area, idx, residents, new Date(last.getTime() + n * stepMs)]);
      await tx.query(`DELETE FROM area_value_history WHERE area=$1 AND id NOT IN (SELECT id FROM area_value_history WHERE area=$1 ORDER BY at DESC LIMIT $2)`, [area, v.historyKeep]);
    });
  }
}

export interface AreaStats { area: string; idx: number; residents: number; players: number; change24h: number; change7d: number; spark: number[] }

/** Value, population, recent change and a sparkline for one or all areas. */
export async function areaStats(ctx: AppContext, only?: string): Promise<AreaStats[]> {
  await updateAreaValues(ctx);
  const rows = (await ctx.pool.query(`SELECT * FROM area_values ${only ? 'WHERE area=$1' : ''}`, only ? [only] : [])).rows;
  const pl = new Map((await ctx.pool.query(`SELECT p.district AS area, count(*)::int n FROM tenancies t JOIN properties p ON p.id=t.property_id WHERE t.status = ANY($1) GROUP BY p.district`, [LIVE])).rows.map((r) => [r.area, r.n as number]));
  const now = ctx.now().getTime();
  const out: AreaStats[] = [];
  for (const r of rows) {
    const hist = (await ctx.pool.query('SELECT idx, at FROM area_value_history WHERE area=$1 ORDER BY at DESC LIMIT 60', [r.area])).rows;
    const at = (ms: number) => { const h = hist.find((x) => x.at.getTime() <= now - ms); return h ? Number(h.idx) : hist.length ? Number(hist[hist.length - 1].idx) : 1; };
    const idx = Number(r.idx);
    out.push({ area: r.area, idx, residents: Number(r.residents), players: pl.get(r.area) ?? 0, change24h: idx / at(86_400_000) - 1, change7d: idx / at(7 * 86_400_000) - 1, spark: hist.slice(0, 24).reverse().map((x) => Number(x.idx)).concat([idx]).slice(-24) });
  }
  return out;
}

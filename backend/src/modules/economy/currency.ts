import type { GameData } from '../../gamedata.js';

/**
 * Money is stored and moved as integer MVC (the internal accounting unit). What a player SEES depends on the country they
 * are standing in: amount x that currency's perMVC rate. The rates are fixed game values from game-data/geo.json (not live
 * market rates), so the books always balance and nobody can profit from a stale rate.
 */
export interface CurrencyInfo { code: string; symbol: string; name: string; perMVC: number; decimals: number; countryId: string; countryName: string; flag: string }

export function currencyOfCity(data: GameData, cityId: string): CurrencyInfo {
  const city = data.cityById.get(cityId) ?? data.cityById.get(data.geo.startCity)!;
  const country = data.countryById.get(city.country)!;
  const cur = data.geo.currencies[country.currency]!;
  return { code: country.currency, symbol: cur.symbol, name: cur.name, perMVC: cur.perMVC, decimals: cur.decimals, countryId: country.id, countryName: country.name, flag: country.flag };
}

export function formatLocal(mvc: number, cur: Pick<CurrencyInfo, 'symbol' | 'perMVC' | 'decimals'>): string {
  const v = mvc * cur.perMVC;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: cur.decimals, maximumFractionDigits: cur.decimals });
  return `${v < 0 ? '-' : ''}${cur.symbol}${s}`;
}
export const formatMoney = (data: GameData, mvc: number, cityId: string) => formatLocal(mvc, currencyOfCity(data, cityId));

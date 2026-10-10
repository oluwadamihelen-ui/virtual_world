# Economy tuning

All values below are **placeholders** for playtesting. Change JSON in `game-data/`, restart the backend (`npm run dev` / `npm start`). Static definitions are re-synced on boot; live stock quantities and occupancy are not reset (to reset stock, update `shop_stock` in SQL).

| Value | File / key | Current |
|---|---|---|
| Starting balance | `economy.json` → `startingBalance` | 2,000 MVC |
| Rent period / grace | `economy.json` → `rentPeriodHours`, `rentGraceHours` | 168h (a "week") / 48h |
| Rent per property | `properties.json` → `rentPerPeriod` | room 500, apartment 900 |
| Shift wage, tasks, pacing | `jobs.json` → `wagePerShift`, `tasksPerShift`, `minSecondsPerTask` | 250 MVC, 5 tasks, 20s |
| Anti-grind cap | `jobs.json` → `maxShiftsPer24h` | 4 shifts / rolling 24h |
| Shop prices / limited stock | `shops.json` | water 8, sandwich 25, lamp 120 (5), sofa 350 (2) |
| Display-name rules | `economy.json` → `displayName` | 3–20 chars; fill in `blockedSubstrings` |

Notes
- Setup cost, starter inventory and license costs are listed in `economy.json` for future business features; **nothing consumes them yet**.
- Faucet/sink visibility: new money only enters via `faucet:world` (grants), `faucet:npc_employers` (wages), `adjustments:admin`. Sinks: `sink:landlord_npc` (rent) and `shop:*`. Query these account balances/entries to see weekly inflow vs outflow while balancing.
- With current numbers a maximum of 4 shifts/day = 1,000 MVC/day vs 500/week rent, which is probably far too generous. This is exactly the sort of value to tune during alpha with real telemetry. Do not treat any number here as balanced.
- Rent is real-time (168h = 7 real days). Use a smaller value when testing; the tests move an injected clock instead.

## Businesses (`game-data/businesses.json`, `items.json`)

| Value | Key | Current |
|---|---|---|
| Premises + setup fee | `premises[].setupCost` | 3000 / 3000 / 3500 MVC |
| Max businesses per owner | `maxOpenPerOwner` | 2 |
| Shelf / restock limits | `maxStockPerItem`, `maxRestockPerOrder` | 500 / 200 |
| Player price bounds | `priceMinMultiplier`, `priceMaxMultiplier` × item `basePrice` | 0.5× to 3× |
| Wholesale cost / reference price / demand weight | `items.json`: `wholesalePrice`, `basePrice`, `npcDemand` | e.g. sandwich 12 / 25 / 2 |
| NPC customers per tick (city-wide) / tick length | `npcDemand.customersPerTick`, `tickSeconds` | 6 per 60 s |
| NPC refuses prices above | `npcDemand.maxPriceMultiplier` × `basePrice` | 1.6× |
| How strongly NPCs prefer cheaper shops | `npcDemand.priceSensitivity` | 2 (weight = (base/price)²) |

How the NPC economy works: each tick a **fixed pool** of customers shops across the whole city (so more shops = split demand, not more demand). Each customer picks an item by demand weight, then picks among shops that stock it at an acceptable price, favouring cheaper ones. NPC money enters via the `faucet:npc_customers` account and wholesale spending leaves via `sink:supplier_npc`; setup fees leave via `sink:city_fees`, so all three flows are measurable.

Known balance risks (untested with real players): with a wholesale margin of ~50% and a pool of 6 customers/minute, one well-priced shop can earn far more than a job. Measure shop profit/hour against shift income during alpha and adjust `customersPerTick`, wholesale prices or the setup fee.

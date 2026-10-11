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

## Currencies, travel, loans, betting (`geo.json`, `phone.json`)
- **Display currency** per country: `geo.json` `currencies[].perMVC` (₦100, GH₵0.8, KSh8.6, £0.05 per MVC). Fixed placeholders. The ledger is always MVC.
- **Prices** scale by city `priceIndex` (Lagos 1.0 ... London 1.8): shop prices, room rents, bus/taxi/flight fares use it where noted in the code.
- **Fares:** `transport[]`: base + per-km, speed `secPerKm`, flights need 200+ km and add an international fee. Fares go to `sink:transport`.
- **Loans:** money is created from `faucet:bank` and repaid back to it; the 10% fee is the only net sink. **Betting:** stakes go to `faucet:betting_house`, winnings come from it; with an 8% margin the house account trends positive (a sink). Watch both accounts' balances for inflation.

## Real estate (`game-data/estate.json`, scaled by each area's `priceIndex` in `geo.json`)
| Item | Rent per week | Price | Notes |
|---|---|---|---|
| Room (apartment block) | 500 MVC | rent only | 8 per generated area (Lagos has 40) |
| Apartments A1, A2, B1, Penthouse | 900 / 1,000 / 1,400 / 2,400 | 16,000 / 18,000 / 26,000 / 48,000 | in the apartment block |
| Houses: Garden, Family, Corner Villa | 2,200 / 3,000 / 4,500 | 42,000 / 60,000 / 95,000 | one per house lot |
| Land plots A, B / C, D | none | 9,000 / 14,000 | max 3 plots per player |
| Build a Starter Home on land | | 15,000 | house is then worth price + 15,000, rent 5% of value |
| Sell back | | 70% of value | back to the market account |

All numbers are **untested guesses**. With the 2,000 MVC starting grant and 250 MVC per shift (max 4 a day), a room is the realistic first home and a house is a long-term goal (about 6 weeks of full-time work at current wages). Use `npm run grant -- "Name" 50000` in development to try buying. The ledger account `faucet:real_estate` receives every purchase and pays every sell-back; a growing positive balance means money is being drained from the economy, negative means sell-backs outpace purchases (the 70% rate keeps it positive). Owners pay no rent, so owning is a one-off money sink.

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

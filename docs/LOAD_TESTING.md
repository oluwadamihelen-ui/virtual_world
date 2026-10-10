# Load testing

`backend/scripts/loadtest.mjs` drives a **running** backend over HTTP using the production paths: players are created through the player API and join through the ticket flow, then every virtual player runs a mixed workload (50% purchases of an unlimited item, 25% summary reads, 15% chat checks, 10% shop listings, 20–120 ms think time). Afterwards all players hit the same limited item and the same property simultaneously, and (optionally) the ledger integrity check runs.

```
cd backend
npm run build
# server on a throwaway database; rate limiting may only be disabled outside production
set DATABASE_URL=postgres://mvw:...@localhost:5432/mvw_load
set PORT=3200
set LOG_LEVEL=warn
set RATE_LIMIT_DISABLED=1
node dist/index.js
# another window:
set SERVER_KEY=<SERVER_API_KEY from .env>
set BASE=http://localhost:3200
node scripts/loadtest.mjs --players 40 --seconds 20 --admin-email you@example.com --admin-password ...
```
(Windows `cmd` syntax shown; unexecuted on Windows. The script exits non-zero on any 5xx/transport error, wrong contention winner count, or ledger inconsistency.)

## Results so far (one machine, one run each, so indicative only)

Environment: Linux sandbox VM, 4 vCPU, 15 GB RAM. **The load generator, the Node backend and PostgreSQL 16 all shared those 4 cores**, with default PostgreSQL settings. 40 concurrent virtual players, 20 s.

| | Before lock fix | After lock fix |
|---|---|---|
| Throughput (mixed workload) | 429 ops/s | 490 ops/s |
| Purchase p50 / p95 / p99 | 40.5 / 84.5 / 100.9 ms | 11.6 / 62.2 / 115.7 ms |
| Summary read p50 / p95 | 3.7 / 8.8 ms | not re-captured |
| 5xx / transport errors | 0 | 0 |
| 40 players race for 5 limited lamps | exactly 5 succeed | exactly 5 succeed |
| 40 players race for 1 property | exactly 1 wins | exactly 1 wins |
| Ledger integrity after run | ok (sum 0, no drift) | ok (earlier run; second run did not re-check) |

The fix: purchases of **unlimited** NPC stock no longer lock the stock row (there is nothing to decrement). Limited stock still locks, as required for correctness.

## What this does and does not tell you
- It shows the backend economy path stays correct and responsive at the *design target of 40 concurrent players issuing economic requests*, on weak shared hardware. 40 players here each generate ~12 requests/s, far more than real players would.
- It does **not** test the Unreal server, replication, chat delivery, network latency, long soak runs, a production-sized database, or multiple backend instances. **It is not evidence that a 40-player Unreal session works.**
- Known hot spot: every purchase at one shop updates that shop's single ledger account row, which serializes buyers of the same shop. Fine at these rates (~200 purchases/s measured); if a single shop ever needs far more, shard the shop's revenue account.
- Not yet measured: p95 under 100+ players, memory growth, DB size growth, recovery time after a crash.

## Suggested pre-playtest thresholds (proposals, to be agreed and re-measured on target hardware)
p95 purchase < 150 ms and zero 5xx at 40 players for 30 minutes; zero ledger-integrity violations in a 2-hour soak; restore from backup < 30 min.

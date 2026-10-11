# Milestones & checklist

Legend: ✅ done and verified by automated tests · 🟡 done but unverified/partial · ⬜ not started

## Milestone 1 — Technical foundation + backend vertical slice (this delivery)

| # | Item | State | Evidence / note |
|---|---|---|---|
| 1 | Environment assessment | ✅ | Linux sandbox; Node 22, PostgreSQL 16, Redis 7, clang/cmake present. **No Unreal Engine, no Windows, no .NET.** |
| 2 | Repo structure, config, `.env.example`, secrets excluded | ✅ | `.env` git-ignored; prod refuses placeholder secrets |
| 3 | Schema + migrations + game-data loader with validation | ✅ | |
| 4 | Identity: register/login/characters/name rules/appearance catalogue | ✅ | `identity-moderation.test.ts` |
| 5 | MVC ledger: double entry, no negatives, idempotent, append-only | ✅ | `economy.test.ts` |
| 6 | Shop purchase (price from DB, limited stock) | ✅ | |
| 7 | Housing: rent, exclusive claim, access check, furnishing, history | ✅ | `housing.test.ts` |
| 8 | Rent lifecycle: autopay, grace, recovery, expiry, furniture return, sanction pause | ✅ | simulated with an injected clock |
| 9 | Job: shift → tasks (paced) → wage once → skill XP, daily cap | ✅ | `jobs.test.ts` |
| 10 | Persistence across backend restart | ✅ | `acceptance.test.ts` (new app + pool, same DB) |
| 11 | Moderation: reports, queue, suspend/ban, lift, audit; admin adjustment w/ reason | ✅ | |
| 12 | Backup + restore drill | 🟡 | Done once on Linux/PG16 with `pg_dump`/`pg_restore` (restored data matched; ledger integrity OK). Not scheduled; not tested on Windows or production infra. |
| 13 | Docs: architecture, setup, API, tuning | ✅ | Windows commands unexecuted on Windows |
| 14 | UE5 project, greybox neighborhood, movement, 2 players on a dedicated server | ⬜ | Needs Unreal Engine. `unreal/Source/MVWBackend` is uncompiled. |

### Test results (last run)
`cd backend && npm test` → **9 files, 83 tests passed** (PostgreSQL 16.15, Node 22). `npm run typecheck` clean. The real server entry point was started and answered `/healthz`, rejected a call without the server key, and served `/world/properties` with it.

### Acceptance criteria status

| Criterion | State |
|---|---|
| 1 Launch the 3D game · 4 Move through neighborhood · 5 Interact with another player | ⬜ not possible without UE5 client |
| 2 Create a character | ✅ backend (UI ⬜) |
| 3 Connect to a session | 🟡 backend `join` verified; no game server yet |
| 6 Access an apartment · 7 Rent it with MVC | ✅ backend |
| 8 Complete a job, earn MVC | ✅ backend (in-world task validation is the game server's job) |
| 9 Buy from a shop | ✅ backend |
| 10–11 Disconnect/reconnect; balance, rental, inventory, progression preserved | ✅ backend, incl. full backend restart |
| Insufficient funds rejected | ✅ |
| Duplicate request does not duplicate payment | ✅ (sequential and 50 concurrent) |
| Simultaneous purchases of exclusive stock/property: only one succeeds | ✅ |
| Client manipulation cannot create MVC | ✅ at API level (no client path to the economy API; price/amount fields ignored). Needs re-verification once a real client exists. |
| Backend failures don't corrupt confirmed transactions | ✅ fault-injection tests: error after payment posted, and DB connection killed mid-transaction, both leave no partial state and the same key can be retried |
| Moderators review reports and enforce sanctions | ✅ |
| Backup and recovery tested | 🟡 see item 12 |

**The overall milestone is NOT complete** because the 3D game, movement and in-world interaction do not exist.

## Known limitations
- Join tickets exist (single use, 60 s, audience-separated from login tokens) and the bare-id join route is disabled in production. The game server must still be written to use them: **the Unreal side of this flow is uncompiled and unexercised.**
- The chat rate limiter is per backend process (in memory). Move it to Redis before running more than one backend instance.
- The chat blocklist is a four-word placeholder; it is not a real safety filter.
- Business closing forfeits remaining shelf stock; businesses have no rent, staff, loans or taxes yet.
- Rate limiting is tested (login brute-force limit, game-server exemption, wrong-key throttling) but limits are per backend process (in memory).
- No email verification, password reset, age gating, chat filtering, block/mute, TLS (use a reverse proxy), metrics, or scheduled backups.
- Rent timing uses real hours; no in-game calendar yet.
- Backend load tested once on a shared 4-core VM (see `docs/LOAD_TESTING.md`). **No claim is made about concurrent player capacity of the full game; the Unreal server is untested.**
- Appearance options and all game data are placeholders.

## Milestone 2 — Phase-3 gameplay foundations (backend only)

| Item | State | Evidence |
|---|---|---|
| Join tickets: issue, single-use redeem (50-way race), expiry, tamper/forgery/wrong-audience rejection, sanction checks | ✅ | `tickets-faults.test.ts` |
| Fault injection (see above) + production hardening (dev routes absent in prod) | ✅ | `tickets-faults.test.ts` |
| Businesses: exclusive premises (5-way race), till deposits/withdrawals, wholesale restock, price bounds, owner-only controls, player purchases (8-way last-units race), close | ✅ | `business.test.ts` |
| Simulated NPC customers: weighted by price, shared city-wide pool (cheaper shops win, overpriced get none), idempotent per tick | ✅ | `business.test.ts` |
| Owner report: revenue, expenses (restock), net profit, kept separate from deposits/withdrawals | ✅ | |
| 3 more jobs (barista, courier, office assistant gated by reputation) | ✅ | `social-progression.test.ts` |
| Achievements → reputation → unlocks | ✅ | |
| Block list, chat check (mask, length, rate limit, mute/suspend), moderator mute | ✅ | |
| Housing customization | ✅ (furnishing, from milestone 1) | |
| City services, moderator UI, Redis, metrics | ⬜ | |

## Milestone 3 — trading, moderation console, load test

| Item | State | Evidence |
|---|---|---|
| Player trading: offer/confirm with versions, atomic swap, bait-and-switch protection, 2-way confirm race, duplicated-item race, funds vanish → no partial swap, blocks/expiry/limits | ✅ | `trade.test.ts` (9) |
| Moderator console `/mod` (sign-in, report queue, dismiss/warn/mute/suspend/ban with required notes, admin audit + integrity) | ✅ | exercised in a real browser: refused non-mod login, required note, HTML in reports shown as text, mute took effect |
| `npm run set-role` (operator-only promotion, audited) | ✅ | |
| Rate limiting: tests + game-server exemption (fixes a throttling flaw found by review) | ✅ | |
| Name rule bug fixed (names differing only by digits 2/6/8/9 collided) found by the load test | ✅ | |
| Load test script and first run | 🟡 | indicative only; see `docs/LOAD_TESTING.md` |

## Milestone 4: Maple Court greybox (Unreal, **uncompiled, untested**)

| Item | State | Note |
|---|---|---|
| Unreal module builds on UE 5.8 (backend subsystem + console commands) | ✅ | built and `mvw.health` showed ONLINE on the user's machine |
| Maple Court subsystem: auto-built cube neighborhood, spawn, door/counter/work interactions, HUD, dev identity + ticket login | 🟡 | written, reviewed, **not compiled or run**: see `docs/MAPLE_COURT.md` test checklist |
| Multiplayer interactions (server RPCs for clients) | ⬜ | next |
| Real art, interiors, pedestrians, day/night, audio | ⬜ | |

## Milestone 5: Playable browser game (replaces the Unreal client as the main client)

| Item | State | Evidence |
|---|---|---|
| Game server: ticket-only WebSocket entry, authoritative movement on shared physics, tenant-only door, proximity-validated interactions, proximity chat/emotes, block/report, NPC residents, interest-managed snapshots, position persistence | ✅ | `realtime.test.ts` (16) |
| Browser client: login/register, character creator with live 3D preview, 3D neighborhood with day/night, avatars, name tags, chat bubbles, emotes, goal cards, context cards, Phone (wallet/jobs/goals), Map, touch joystick, reconnect | ✅ (software-rendered Chromium) | screenshots + flows in `docs/WEB_CLIENT.md` |
| Real-GPU performance, Safari, low-end phones | ⬜ untested | |
| WebSocket load test | ✅ one run: 40 players clean, 150 players degrade slightly (see `docs/LOAD_TESTING.md`) | `scripts/wsload.mjs` |
| Per-tenant instanced interiors, more buildings/districts, sound, real art | ⬜ | |
| Unreal Engine client | ⏸ paused by decision | docs kept |

## Milestone 6: Map, travel, currencies, phone apps

| Item | State | Evidence |
|---|---|---|
| 8 cities / 4 countries, generated city worlds, per-city shops/rooms/prices | ✅ | `travel.test.ts` |
| Travel (bus, taxi, flight, walk) with ledger-charged fares and arrival in the new city | ✅ | `travel.test.ts` (15) + browser flight Lagos to Accra |
| Wallet shows local currency (₦, GH₵, KSh, £) from fixed game rates | ✅ | tests + screenshots (₦200,000 to GH₵1,472.00 after a ₦16,000 flight) |
| Date of birth at sign-up, age groups, 18+ gating | ✅ self-declared only | `phone.test.ts`, `identity-moderation.test.ts` |
| Vault: send money (limits, idempotent), loans (limit by reputation, overdue collection) | ✅ | `phone.test.ts` |
| Chatter DMs, block/age-group rules | ✅ | `phone.test.ts` |
| Spark dating (adults only, mutual match, delete data) | ✅ | `phone.test.ts` + 2-browser flow |
| Odds play-money betting (limits, breaks, settlement) | ✅ | `phone.test.ts` + browser |
| Legal / safety review of dating, betting, lending | ⬜ **required before real users** | `docs/SAFETY.md` |
| Real exchange rates, real payments, ID age verification | ⬜ not built | |

## Remaining tasks (sequenced)
1. **UE5 project + dedicated server + greybox block** (blocks everything player-facing). Compile `MVWBackend`. *Done when:* two clients see each other on a dedicated server.
2. ~~Join-ticket endpoint~~ done on the backend. *Remaining:* the game server must use it (Unreal).
3. In-engine interactables (door/counter/workstation) wired to the subsystem; HUD for MVC/inventory. *Done when:* acceptance steps 1–11 pass on a build.
4. ~~Fault-injection tests~~ and ~~backend load test~~ done once. *Remaining:* soak test, bigger populations, real hardware, Unreal server load.
5. Phase 3: more jobs, businesses + NPC customers, progression, proximity chat, block/mute, chat filter, moderator UI, Redis for sessions, metrics/alerts, scheduled backups.
6. Before a wider playtest, define and measure thresholds. Suggested starting targets (proposals, not measured): p95 purchase API latency < 150 ms at 40 concurrent players; zero ledger-integrity violations across a soak test; server tick ≥ 30 Hz at 40 players; restore RTO < 30 min / RPO < 15 min.

## Next recommended action
Install UE 5.4+ and Visual Studio on the Windows dev machine, follow `unreal/README.md` to create the project and compile `MVWBackend`, then build the greybox block. I can continue with the join-ticket endpoint and fault-injection tests in the meantime, since neither needs Unreal.

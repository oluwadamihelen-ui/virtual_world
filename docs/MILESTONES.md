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
`cd backend && npm test` → **5 files, 43 tests passed** (PostgreSQL 16.15, Node 22). `npm run typecheck` clean. The real server entry point was started and answered `/healthz`, rejected a call without the server key, and served `/world/properties` with it.

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
| Backend failures don't corrupt confirmed transactions | 🟡 transactional design + constraint tests; **no fault-injection / crash-mid-write test yet** |
| Moderators review reports and enforce sanctions | ✅ |
| Backup and recovery tested | 🟡 see item 12 |

**The overall milestone is NOT complete** because the 3D game, movement and in-world interaction do not exist.

## Known limitations
- `characterId` is supplied by the caller of `/v1/game/*`. Without a join-ticket flow, the game server must be trusted to bind a connection to the right character. Add signed, short-lived join tickets from the player JWT before any public test.
- Rate limiting is configured but **not covered by tests** (disabled in the test app).
- No email verification, password reset, age gating, chat filtering, block/mute, TLS (use a reverse proxy), metrics, or scheduled backups.
- Rent timing uses real hours; no in-game calendar yet.
- No load testing. **No claim is made about concurrent player capacity.**
- Appearance options and all game data are placeholders.

## Remaining tasks (sequenced)
1. **UE5 project + dedicated server + greybox block** (blocks everything player-facing). Compile `MVWBackend`. *Done when:* two clients see each other on a dedicated server.
2. **Join-ticket endpoint** (player JWT → short-lived signed ticket → game server validates). *Done when:* the game server never accepts a bare characterId from a client; tested.
3. In-engine interactables (door/counter/workstation) wired to the subsystem; HUD for MVC/inventory. *Done when:* acceptance steps 1–11 pass on a build.
4. Fault-injection tests (kill backend/DB mid-transaction) and a small load test of the purchase/rent paths.
5. Phase 3: more jobs, businesses + NPC customers, progression, proximity chat, block/mute, chat filter, moderator UI, Redis for sessions, metrics/alerts, scheduled backups.
6. Before a wider playtest, define and measure thresholds. Suggested starting targets (proposals, not measured): p95 purchase API latency < 150 ms at 40 concurrent players; zero ledger-integrity violations across a soak test; server tick ≥ 30 Hz at 40 players; restore RTO < 30 min / RPO < 15 min.

## Next recommended action
Install UE 5.4+ and Visual Studio on the Windows dev machine, follow `unreal/README.md` to create the project and compile `MVWBackend`, then build the greybox block. I can continue with the join-ticket endpoint and fault-injection tests in the meantime, since neither needs Unreal.

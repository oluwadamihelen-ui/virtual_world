# Architecture

## Responsibilities

```
 ┌─────────────────┐  UE replication   ┌──────────────────────────┐  HTTPS+server key  ┌──────────────────────┐   SQL    ┌────────────┐
 │  Game client    │◄─────────────────►│  Dedicated game server   │───────────────────►│  MVW backend (Node)  │◄────────►│ PostgreSQL │
 │  Unreal 5, PC   │  (movement, chat, │  Unreal 5, authoritative │  (never the client)│  modular monolith    │          │ (truth)    │
 │  UI + input     │   emotes, state)  │  world: validates in-    │                    │  ledger, housing,    │          └────────────┘
 └────────┬────────┘                   │  world conditions        │                    │  jobs, shop, mod     │          ┌────────────┐
          │ HTTPS + player JWT         └──────────────────────────┘                    └──────────▲───────────┘          │ Redis      │
          └─ login, character list/create, reports ───────────────────────────────────────────────┘                      │ (later:    │
                                                                                                                         │ sessions)  │
                                                                                                                         └────────────┘
```

| Component | Owns | Never does |
|---|---|---|
| **Client** | Rendering, input, UI. Talks to the backend only for account login, character create/list and reports (player JWT). | Hold the server key; decide balances, prices, wages, ownership. |
| **Dedicated game server** | World simulation, movement/interaction validation (is the player at the counter? at the workstation?), chat, replication. Calls the backend with a shared secret to perform economic actions and replicates the confirmed result. | Compute balances itself. |
| **Backend** | All persistent, consequential state: MVC ledger, inventory, tenancies, shifts/wages, reports, sanctions, audit. Re-validates everything it can independently (prices from DB, pacing, stock, permissions). | Trust any amount or price from a caller. |
| **PostgreSQL** | Source of truth. Constraints are the last line of defence (no negative balances, balanced ledger, one live tenancy per property). | |

Key decision: **client → server → backend**. A modified client can only send inputs the game server is willing to validate. The economy API is unreachable without the server key, so "give myself MVC" has no path.

## Trust model for jobs

The backend cannot see the 3D world. It enforces what it can see: a shift must be started on the server's clock, each task must respect `minSecondsPerTask`, all tasks must be done, shifts per 24h are capped, and the wage is paid at most once (key derived from the shift ID). The **game server** is responsible for confirming the in-world part of each task (e.g. the character is at the right station) before calling `/task`.

## Transaction strategy (the money rules)

1. **Double-entry ledger.** Every movement is a set of `ledger_entries` that sum to zero. New money enters only from `faucet:*` system accounts (starting grant, NPC wages, admin adjustments), so faucets and sinks are measurable. A deferred constraint trigger rejects any transaction that does not balance at COMMIT; entries are append-only (UPDATE/DELETE blocked).
2. **One DB transaction per action.** Payment + stock decrement + inventory grant (or tenancy creation, etc.) commit together or not at all.
3. **No overdrafts.** `UPDATE … WHERE balance + delta >= 0` is the check; a `CHECK (allow_negative OR balance >= 0)` constraint is the backstop.
4. **Idempotency.** Each money-moving request claims a unique key (`ledger_transactions.idempotency_key`) first. Same key + same request → original response replayed, no second charge (tested with 50 concurrent retries). Same key + different request → `409`. Wage and rent keys are derived server-side (`shift-wage:<id>`, `rent:<tenancy>:<due date>`), so a client cannot retry its way to a second payout.
5. **Lock ordering.** Character row → domain rows (property/stock) → ledger accounts sorted by ID. Prevents deadlocks; the transaction wrapper also retries on deadlock/serialization errors.
6. **Exclusivity.** Properties: row lock + partial unique index `tenancies(property_id) WHERE status IN ('active','grace')`. Limited stock: row lock on `shop_stock`. Tested with 8 simultaneous renters (1 wins) and 6 simultaneous buyers of 5 lamps.
7. **Integrity check.** `GET /v1/admin/ledger-integrity` verifies: global sum is 0, each cached balance equals the sum of its entries, every transaction balances.
8. **Admin adjustments** are ordinary ledger transactions against `adjustments:admin`, require a ≥10-char reason, are idempotent and write an `audit_log` row.

Amounts are integer MVC stored as `bigint` and read as JS numbers; inputs are bounded to 10¹² (well below 2⁵³).

## Join tickets (client → server identity)

The game server must never trust a `characterId` sent by a client. Instead: the client (player JWT) requests `POST /v1/characters/:id/join-ticket`; the backend verifies ownership and account standing and returns a 60-second HS256 token (audience `mvw-join-ticket`, key derived separately from login tokens, unique `jti`). The client presents it to the dedicated server, which redeems it via `POST /v1/game/tickets/redeem`; the `jti` is recorded in `join_tickets_used` (primary key = single use, race-safe). In production the bare-id join route does not exist.

## Businesses

A business owns a **ledger account** (`kind='business'`) as its till. Money flows: owner wallet ⇄ till (deposit/withdraw: neither profit nor loss), till → `sink:supplier_npc` (restock = expense), customer → till (sale = revenue; NPC customers are paid from `faucet:npc_customers`). The owner report derives revenue, expenses and net profit from ledger transaction types, so it cannot drift from the real balances. Premises are exclusive via a partial unique index. NPC customer simulation shares one city-wide demand pool (see `docs/ECONOMY_TUNING.md`) so owners compete; each simulated sale claims an idempotency key `npc-sale:<tick>:<n>`, so overlapping ticks cannot double-sell.

## Social safety & progression

`blocks` (two-way effect), `accounts.muted_until` (moderator mute, lifted by appeal), `POST /chat/check` (control-character stripping, length cap, per-character rate limit, word masking, mute/suspension check) — the **game server** calls these before broadcasting. Achievements are awarded once (`achievements` primary key) inside the same transaction as the action that earns them and grant reputation, which gates better jobs.

## Rent lifecycle

Rent is charged for the first period at signup. When due, the server auto-pays from the wallet (one idempotent charge per billing period). If the wallet cannot cover it, the tenancy enters **grace** (`rentGraceHours`, default 48h, counted from the first failure) with access retained; paying up during grace restores `active`. If grace lapses, the tenancy **ends**, the property is released and placed furniture is returned to the tenant's inventory. Nothing is destroyed. Tenancies of suspended or banned accounts are not processed, so a sanction never costs someone their home. The sweep runs every minute and on player join.

## Modules (backend/src/modules)

`identity` (accounts, scrypt password hashes, JWT, characters, name rules) · `economy` (ledger) · `inventory` · `housing` (rent, furnishing, access) · `employment` (shifts/wages/skills) · `commerce` (shops) · `moderation` (reports, sanctions, admin adjustments, audit). Modules call each other only through exported functions; each can become a service later. Government/civic and businesses are **not implemented**; the ledger already supports `business` accounts and `owner_ref` for them.

## Data entities

accounts · characters · ledger_accounts · ledger_transactions · ledger_entries · inventory_items · shop_stock · properties · tenancies · rent_payments · placed_furniture · shifts · skills · reports · audit_log. Static definitions (items, shops, jobs, property templates, appearance options) live in `game-data/*.json`, validated at boot (cross-references checked) and synced to the DB without resetting live stock/occupancy.

## Network model (target, not yet built)

Unreal dedicated server, authoritative movement (CharacterMovementComponent), relevancy-based replication with a distance cull, proximity chat validated and filtered server-side. Initial design target 20–40 players per instance. **This is a target, not a measured capability**; it must be load-tested before being claimed.

## Security notes / known gaps

Done: scrypt hashing, uniform login errors, JWT roles, constant-time server-key check, per-route rate limits (10/min on auth, 300/min global), Zod input validation, no internals leaked in 500s, secrets only via env (`.env` is git-ignored; production refuses placeholder secrets), request body limit.
Not yet done: Redis-backed shared rate limiting, a real chat filter, email verification and password reset, age gating/parental flows and privacy policy (needed before any teen access), TLS termination (run behind a reverse proxy), chat filtering, block/mute, refresh tokens/JWT revocation, per-account login lockout, structured metrics/monitoring, automated scheduled backups, Redis, AI features (kept out of the authoritative path by design).

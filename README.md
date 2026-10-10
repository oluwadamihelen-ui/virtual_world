# My Virtual World (MVW)

A persistent 3D multiplayer life-simulation. Players rent homes, work jobs, trade and (later) run businesses and take part in civic life in the fictional city of **New Meridian**. Currency: **MVC (My Virtual Credit)**, a closed-loop game currency with no real-world cash value.

## Status (honest summary)

| Part | State |
|---|---|
| Authoritative backend (TypeScript + PostgreSQL) | **Built and tested**: 43 automated tests pass against a real PostgreSQL 16 |
| Ledger, wallet, idempotency, concurrency safety | **Built and tested** (see `docs/MILESTONES.md`) |
| Identity, characters, housing/rent lifecycle, jobs, shop, moderation, admin audit | **Built and tested** |
| Backup / restore procedure | **Drill performed once** on Linux/PostgreSQL 16 (`scripts/`) |
| Unreal Engine 5 client + dedicated server | **Not built.** UE5 was not available in the build environment. Only a small, **uncompiled** server-side backend bridge exists (`unreal/Source/MVWBackend`). |
| 3D neighborhood, movement, replication, chat, emotes | **Not started** (needs Unreal Engine) |
| Redis, Windows `.cmd` helper scripts | Not used yet / not written |

Because the 3D client does not exist yet, **the milestone-1 acceptance criteria are only partly met**: the backend half (steps 2, 3, 6–11 and every listed security/consistency test) is verified; launching the 3D game, walking around, and interacting with another player in-world are not.

## Repository layout

```
backend/        TypeScript modular monolith (Fastify + pg + zod). Authoritative economy/persistence.
  src/modules/  identity, economy (ledger), inventory, housing, employment, commerce, moderation
  migrations/   SQL schema (applied by the built-in migrator)
  test/         vitest suites (run against a real PostgreSQL)
game-data/      Tunable game data (economy, items, shops, properties, jobs, appearance). No code changes needed to rebalance.
unreal/         Unreal Engine side (currently: server-side backend bridge module, uncompiled)
scripts/        Backup / restore
docs/           Architecture, setup, milestones, economy tuning, API
```

## Quick start

See [docs/SETUP_WINDOWS.md](docs/SETUP_WINDOWS.md) for Windows. In short: install Node 20+ and PostgreSQL 16, create the DB, copy `backend/.env.example` to `backend/.env`, then `npm install`, `npm test`, `npm run dev` inside `backend/`.

## Documents

- [Architecture](docs/ARCHITECTURE.md) · [Setup (Windows)](docs/SETUP_WINDOWS.md) · [Milestones](docs/MILESTONES.md) · [Economy tuning](docs/ECONOMY_TUNING.md) · [API](docs/API.md) · [Unreal notes](unreal/README.md)

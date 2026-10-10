# Backend API (v1)

JSON over HTTP. Errors: `{ "error": "<code>", "message": "..." }`. Money is integer MVC.

**Auth types:** *Player* = `Authorization: Bearer <JWT>` from `/v1/auth/login`. *Server* = `x-server-key: <SERVER_API_KEY>` (dedicated game server only). *Mod/Admin* = player JWT with role.

## Player
| Method & path | Notes |
|---|---|
| `POST /v1/auth/register` `{email,password(≥10)}` | 10 req/min limit |
| `POST /v1/auth/login` `{email,password}` → `{token}` | banned accounts get 403 |
| `POST /v1/characters` `{displayName, appearance{bodyPreset,skinTone,hairstyle,hairColor,outfit}}` | 201; grants starting MVC via ledger |
| `GET /v1/characters`, `GET /v1/characters/:id/summary` | summary only for own characters |
| `POST /v1/reports` `{reporterCharacterId,targetCharacterId,category,detail?}` | |

## Game server (`/v1/game/...`)
| Method & path | Purpose |
|---|---|
| `POST /characters/:id/join` | admit/reconnect; runs rent sweep; returns full summary |
| `GET /characters/:id/summary` · `GET .../ledger?limit=` | state / transaction history |
| `PUT /characters/:id/position` | persist location |
| `GET /world/properties` · `/world/jobs` · `/world/shops/:shopId` | catalogues |
| `POST /characters/:id/shops/:shopId/purchase` `{itemId,quantity,idempotencyKey}` | 402 insufficient funds, 409 out_of_stock |
| `POST /characters/:id/rent` `{propertyId,idempotencyKey}` | 409 property_unavailable / tenancy_limit |
| `GET /properties/:propertyId/access/:id` | door check |
| `POST /characters/:id/furniture` `{itemId,x,y,z,yaw?}` · `DELETE .../furniture/:furnitureId` | slot-limited |
| `GET /characters/:id/rent-history` | |
| `POST /characters/:id/shifts` `{jobId}` → `.../shifts/:sid/task` → `.../complete` · `.../abandon` | wage once per shift |
| `GET /characters/:id/employment-history` | |

Idempotency keys: 8–100 chars, unique per player intent (use a GUID). Retry with the **same** key after timeouts; use a **new** key for a new intent.

## Moderation / admin
`GET /v1/mod/reports?status=` · `POST /v1/mod/reports/:id/resolve` `{action: dismiss|warn|suspend(hours)|ban, note}` (ban = admin only) · `POST /v1/mod/characters/:id/lift-sanction` · `POST /v1/admin/adjustments` `{characterId,delta,reason,idempotencyKey}` · `GET /v1/admin/audit` · `GET /v1/admin/ledger-integrity`.

Promoting the first moderator/admin is done directly in SQL (`UPDATE accounts SET role='admin' WHERE email=...`); there is deliberately no API for it.

## Added in milestone 2

**Player:** `POST /v1/characters/:id/join-ticket` → `{ticket, expiresInSeconds:60}` (own characters only; sanctioned accounts refused).

**Game server** (all under `/v1/game`):
| Method & path | Purpose |
|---|---|
| `POST /tickets/redeem` `{ticket}` | Single-use; returns the character summary. **The only join route in production** (`POST /characters/:id/join` exists only when `NODE_ENV` ≠ production). |
| `GET /world/premises` · `/world/businesses?district=` · `/world/businesses/:bid` | Shop units, open businesses, a business's shelf |
| `POST /characters/:id/businesses` `{premisesId,type,name,idempotencyKey}` | Open (type `convenience_shop` or `cafe`) |
| `POST .../businesses/:bid/fund` `{direction: deposit|withdraw, amount, idempotencyKey}` | Move MVC wallet ↔ till |
| `POST .../businesses/:bid/restock` `{itemId,quantity,idempotencyKey}` | Wholesale purchase from the till |
| `PUT .../businesses/:bid/prices` `{itemId,price}` | Within 0.5×–3× of the item's base price |
| `GET .../businesses/:bid/report` · `POST .../businesses/:bid/close` | Revenue/expenses/net profit · close and return till cash |
| `POST /characters/:id/business-purchase/:bid` `{itemId,quantity,idempotencyKey}` | Player buys from a player-owned business |
| `GET/POST /characters/:id/blocks` · `DELETE .../blocks/:targetId` · `GET /social/blocked/:a/:b` | Block list; the game server must check before delivering chat/interactions |
| `POST /chat/check` `{characterId,text}` | → `{allowed, text, filtered}` or `{allowed:false, reason: muted|too_long|empty|rate_limited}` |

**Moderator:** resolve action `mute` (`hours`, `note`) added; `lift-sanction` also clears mutes.

**Dev only** (not registered in production): `GET /dev` (test console), `POST /v1/dev/grant`, `POST /v1/dev/run-customers`.

# Putting the game online

## Where it can and cannot run
The backend is **one long-running Node process**: the web pages, the API, the WebSocket game server (20 ticks a second), NPCs, and timers for rent and property values. That needs a host that keeps a process alive and allows WebSockets.
- **Works:** Render, Railway, Fly.io, a VPS (DigitalOcean, Hetzner...), or your own machine with a tunnel. Start command: `npm run build && npm start` in `backend/`, Node 22.
- **Vercel does not fit.** Vercel runs short-lived serverless functions: no WebSockets and no permanent process, so players could load the page but never join the world. Use Vercel (if you like) only for static files, not the game server.

## Node version
Use Node **22.12 or newer** (`engines` in `backend/package.json` says 22.x). On Vercel the error `ERR_REQUIRE_ESM ... content-disposition` came from an older `@fastify/static` pulling an ESM-only dependency; `@fastify/static` is now pinned to v8, which avoids it.

## Environment variables
Set these in the host's dashboard (never commit real values). Names are in `backend/.env.example`.

**Required**
| Variable | What it is |
|---|---|
| `DATABASE_URL` | PostgreSQL 16 connection string from a hosted database (Neon, Supabase, Render Postgres, Railway...). Add `?sslmode=require` if the provider needs SSL. |
| `JWT_SECRET` | 32+ random characters; signs login tokens. |
| `SERVER_API_KEY` | 24+ random characters; secret for the game-server-only API. |
| `NODE_ENV` | `production` |

**Recommended**
| Variable | What it is |
|---|---|
| `PORT` | Usually set by the host; the server listens on it (default 3000). |
| `MESSAGE_KEY` | 32+ random characters; encrypts direct messages at rest. Back it up: lose it and old messages cannot be read. |
| `PUBLIC_BASE_URL` | The public https address, e.g. `https://play.example.com` (payment return pages). |
| `LOG_LEVEL` | `info` (default) |

**Optional: top-ups** (a method appears only when its keys are set; see `docs/PAYMENTS.md`)
`PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`, `KORAPAY_SECRET_KEY`, `MANUAL_TOPUP_INSTRUCTIONS`

**Optional: voice chat** `VOICE_ICE_SERVERS` (JSON, add a TURN server for players behind strict firewalls)

**Other:** `GAME_DATA_DIR` (default `../game-data`, so deploy the whole repo, not only `backend/`), `RATE_LIMIT_DISABLED` (load testing only; ignored in production).

Generate secrets with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## First start
The server creates its tables itself on boot (migrations), then loads `game-data/`. Make yourself an admin with `npm run set-role -- you@example.com admin` (run it where `DATABASE_URL` is set), then open `/mod`.

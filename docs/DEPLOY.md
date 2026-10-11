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
| `TRUST_PROXY` | `1` on any host that puts a proxy in front of you (Render, Railway, Fly...). **Required for real hosting**: without it all players share the proxy's IP and hit the per-IP rate and connection limits together. |
| `LOG_LEVEL` | `info` (default) |

**Optional: top-ups** (a method appears only when its keys are set; see `docs/PAYMENTS.md`)
`PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`, `KORAPAY_SECRET_KEY`, `MANUAL_TOPUP_INSTRUCTIONS`

**Optional: voice chat** `VOICE_ICE_SERVERS` (JSON, add a TURN server for players behind strict firewalls)

**Other:** `GAME_DATA_DIR` (default `../game-data`, so deploy the whole repo, not only `backend/`), `RATE_LIMIT_DISABLED` (load testing only; ignored in production).

Generate secrets with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## First start
The server creates its tables itself on boot (migrations), then loads `game-data/`. Make yourself an admin with `npm run set-role -- you@example.com admin` (run it where `DATABASE_URL` is set), then open `/mod`.

## Step by step on Render (written from Render's usual setup; not tested from here, so check the screens against Render's current docs)
1. Push this repo to GitHub (it is). Create a Render account and connect GitHub.
2. **New > PostgreSQL** (version 16). Pick the same region you will use for the web service. Copy its **Internal Database URL**.
3. **New > Web Service**, choose the repo and the branch you deploy.
   - Root Directory: `backend`
   - Runtime: Node. Build Command: `npm install && npm run build`. Start Command: `npm start`
   - Instance type: a **paid** one. Free instances go to sleep after inactivity and would kick everyone out of a live world.
   - Health Check Path: `/healthz`
4. Environment variables: `NODE_ENV=production`, `DATABASE_URL` (the internal URL), `JWT_SECRET`, `SERVER_API_KEY`, `MESSAGE_KEY`, `TRUST_PROXY=1`, `GAME_DATA_DIR=/opt/render/project/src/game-data`, then `PUBLIC_BASE_URL` once you know your address (`https://<name>.onrender.com` or your own domain).
5. Deploy. Open `https://<name>.onrender.com/play/`. Register, then promote yourself (Render dashboard > your service > Shell): `npm run set-role -- you@example.com admin`, and open `/mod`.
6. Run **one** instance only. The world lives in that process's memory; two instances would be two separate worlds.
7. Backups: turn on the database provider's backups. The ledger is the money.

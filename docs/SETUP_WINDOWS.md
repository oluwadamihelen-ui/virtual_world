# Windows development setup

> Verified on Linux (Node 22, PostgreSQL 16). The Windows commands below follow the same steps but **have not been run on Windows yet**; report any difference.

## 1. Install

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20.12+ (22 LTS recommended) | https://nodejs.org |
| PostgreSQL | 16 | Remember the `postgres` superuser password. Add `C:\Program Files\PostgreSQL\16\bin` to PATH. |
| Git | any recent | |
| Unreal Engine | 5.4+ via Epic Games Launcher | Needed for the 3D game (not used by the backend) |
| Visual Studio 2022 | "Game development with C++" workload, Windows 11 SDK | Needed to compile Unreal C++ |

## 2. Create the databases (Command Prompt)

```bat
psql -U postgres -c "CREATE ROLE mvw LOGIN PASSWORD 'mvw_dev_password' CREATEDB"
psql -U postgres -c "CREATE DATABASE mvw_dev OWNER mvw"
psql -U postgres -c "CREATE DATABASE mvw_test OWNER mvw"
```

`mvw_dev_password` is for local development only. Use a strong, unique password anywhere else.

## 3. Configure and run the backend

```bat
cd backend
copy .env.example .env
```

Shortcut: `npm run setup` does steps 2 and this .env step for you (creates the role, databases and random secrets). Manual route: edit `.env`: set `JWT_SECRET` and `SERVER_API_KEY` to long random values:

```bat
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bat
npm install
npm run typecheck
npm test
npm run dev
```

`npm test` **wipes and recreates the `public` schema of `TEST_DATABASE_URL`**, so never point it at a database you care about. `npm run dev` applies migrations, syncs `game-data/`, and listens on port 3000. Check it: `curl http://localhost:3000/healthz` → `{"status":"ok"}`.

Production build: `npm run build` then `npm start` (runs `dist/index.js`).

## 4. Exercise the vertical slice by hand (no game client needed)

Replace `%KEY%` with your `SERVER_API_KEY`. Use Git Bash or adapt the quoting for `cmd` (`\"`).

```bash
curl -X POST localhost:3000/v1/auth/register -H "content-type: application/json" -d '{"email":"me@example.com","password":"a long password"}'
curl -X POST localhost:3000/v1/auth/login    -H "content-type: application/json" -d '{"email":"me@example.com","password":"a long password"}'   # -> token
curl -X POST localhost:3000/v1/characters -H "authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"displayName":"Test Pilot","appearance":{"bodyPreset":"body_a","skinTone":2,"hairstyle":"short","hairColor":"brown","outfit":"casual_1"}}'   # -> characterId
curl -X POST localhost:3000/v1/game/characters/<characterId>/join -H "x-server-key: %KEY%"
curl -X POST localhost:3000/v1/game/characters/<characterId>/rent -H "x-server-key: %KEY%" -H "content-type: application/json" -d '{"propertyId":"prop_resi_room_101","idempotencyKey":"rent-0001-abcd"}'
curl -X POST localhost:3000/v1/game/characters/<characterId>/shops/shop_corner_grocery/purchase -H "x-server-key: %KEY%" -H "content-type: application/json" -d '{"itemId":"sandwich","quantity":2,"idempotencyKey":"buy-0001-abcd"}'
```

Repeat the last command with the same key: the response has `"replayed": true` and the balance does not change.

## 5. Backups (tested on Linux; use Git Bash on Windows)

```bash
export DATABASE_URL=postgres://mvw:...@localhost:5432/mvw_dev
scripts/backup.sh backups/mvw.dump
# restore into an EMPTY database and verify integrity:
scripts/restore.sh backups/mvw.dump postgres://mvw:...@localhost:5432/mvw_restore
```

Restore drills must be repeated on your real infrastructure before alpha. Scheduling and off-site copies are not set up yet.

## 6. Unreal Engine

See [unreal/README.md](../unreal/README.md). The 3D client and dedicated server do not exist yet.

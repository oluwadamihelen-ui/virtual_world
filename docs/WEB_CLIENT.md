# Browser game client + game server

The playable game: a 3D stylized city in the browser (Three.js), a real-time game server (WebSocket), and the existing transactional backend. Open `http://localhost:3000/play`.

## Architecture

```
 Browser (Three.js + DOM UI)  --WebSocket /ws?ticket=-->  Game server (src/realtime/gateway.ts)  --in-process-->  Backend services --> PostgreSQL
        │  REST: register/login, characters, join-ticket                │ 20 Hz authoritative simulation
        └────────────────────────────────────────────────────────────────┘ 10 Hz snapshots to nearby players
```

- **Identity:** the browser logs in over REST (player JWT), asks for a single-use 60 s **join ticket**, and presents it on the WebSocket upgrade. The server redeems it, so the connection is bound to a character the player provably owns. Cross-site WebSocket attempts are refused (origin check).
- **Movement is server-authoritative.** The client sends a *direction* (never a position). The server runs the shared physics (`backend/shared/sim.mjs`: speed cap, wall and furniture collision, tenant-only door gate) and broadcasts positions. The browser runs the **same code** for instant local prediction and gently corrects toward the server.
- **Interactions are server-validated.** `interact{zone,item}` is checked for distance to the zone, rate (one per 250 ms), and account standing, then executed through the same services as the REST API (ledger, idempotency, locking). The client only displays confirmed results.
- **Social:** proximity chat (25 m) with the word filter, rate limit, mute and block checks; emotes; report and block messages feed the existing moderation tools. Players disconnected for flooding (4008) or garbage (4009). Logging in again elsewhere replaces the old session (4000).
- **World:** `game-data/world.json` is the single description of the neighbourhood (buildings, doors, furniture, props, interaction zones, NPC routes). Server collision and client rendering are both generated from it.
- **Ambient life:** six NPC residents walk routes on the server and appear in every nearby player's snapshot (no name tag; the map shows them grey).
- **Day/night:** deterministic from the server clock (1 real minute = 1 game hour); lamps and windows light at dusk.
- **Persistence:** position is saved every 15 s while moving and on disconnect; money, home, items, shift state and progress come from the backend as always.

## WebSocket messages (JSON)
Client → server: `input{seq,dx,dz,run}` · `chat{text}` · `emote{e}` · `interact{zone,item?}` · `shopinfo{zone}` · `phone{tab}` · `home` · `report{targetId,category,detail?}` · `block/unblock{targetId}` · `ping{c}`
Server → client: `welcome{you,world,summary,door,jobs,achievements,serverNow}` · `snap{ack,you,ps,spawns,gone,online}` · `chat` · `emote` · `toast{kind,text}` · `summary{summary,door}` · `shopinfo` · `phone{tab,data}` · `pong`

## UI (modelled on the layout idea of your reference screenshots, original artwork)
Top bar (clock, online count, ping, MVC balance + wallet), goal cards from real achievements, name tags and chat bubbles, location card with chat box, quick-walk chips, emote picker, context card when you stand on an interaction ring, bottom nav (Home, Buy, Map, Phone), Phone (wallet / jobs / goals), live map, "Clean screen" toggle, touch joystick and pinch zoom on phones.

## Verified so far
- 16 automated game-server tests (real WebSockets): ticket-only entry (replay, forgery, wrong origin), speed cap, solid walls, tenant-only door, proximity-validated rent/buy/work, chat range/filter/block/mute, emote range and rate limit, report/block, snapshots and interest management, NPCs, persistence of position, flood and garbage protection, session replacement.
- Browser checks with a real headless Chromium + WebGL: sign-up, character creator with 3D preview, entering the world, renting (balance 2,000 → 1,500) and walking through the unlocked door, buying (25 and 8 MVC), two players seeing each other with chat bubbles and emotes, day and night, phone and map panels, and a phone-sized touch layout. No JavaScript errors.

## Known limitations
- All tenants share the one apartment interior (per-tenant instanced rooms come later).
- The cafe, job centre and bank are scenery. No sound or music. Art is simple stylized primitives, not final.
- The 3D client was exercised on software rendering (SwiftShader); real-GPU frame rates, low-end phones and Safari are **untested**.
- Chat history is not stored; only the last few lines are shown. The chat rate limit and word list are the starter versions described in `docs/ARCHITECTURE.md`.
- Game-server scale is untested: one process, one world instance. The earlier backend load test does not cover WebSocket traffic.
- Click-to-report always files "harassment" for now (a category picker is a small follow-up).

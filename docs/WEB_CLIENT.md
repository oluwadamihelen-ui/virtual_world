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
Client → server: `input{seq,dx,dz,run}` · `chat{text}` · `emote{e}` · `interact{zone,item?}` · `shopinfo{zone}` · `phone{tab}` · `app{rid,app,a,d}` · `quote{to}` · `travel{to,mode}` · `home` · `report{targetId,category,detail?}` · `block/unblock{targetId}` · `ping{c}`
Server → client: `welcome{you,world,summary,door,jobs,achievements,serverNow}` · `snap{ack,you,ps,spawns,gone,online}` · `chat` · `emote` · `toast{kind,text}` · `summary{summary,door}` · `shopinfo` · `phone{tab,data}` · `app{rid,ok,data|code,message}` · `quote` · `travel` · `notify{kind,...}` · `pong`

## UI (modelled on the layout idea of your reference screenshots, original artwork)
Top bar (clock, online count, ping, MVC balance + wallet), goal cards from real achievements, name tags and chat bubbles, location card with chat box, quick-walk chips, emote picker, context card when you stand on an interaction ring, bottom nav (Home, Buy, Map, Phone), Phone (wallet / jobs / goals), live map, "Clean screen" toggle, touch joystick and pinch zoom on phones.

## Verified so far
- 16 automated game-server tests (real WebSockets): ticket-only entry (replay, forgery, wrong origin), speed cap, solid walls, tenant-only door, proximity-validated rent/buy/work, chat range/filter/block/mute, emote range and rate limit, report/block, snapshots and interest management, NPCs, persistence of position, flood and garbage protection, session replacement.
- Browser checks with a real headless Chromium + WebGL: sign-up, character creator with 3D preview, entering the world, renting (balance 2,000 → 1,500) and walking through the unlocked door, buying (25 and 8 MVC), two players seeing each other with chat bubbles and emotes, day and night, phone and map panels, and a phone-sized touch layout. No JavaScript errors.

## One continuous city (state) with districts
Each state (Lagos, Abuja, Accra, Nairobi, London, and single-district Port Harcourt, Kano, Kumasi) is **one continuous world**. Lagos has six districts (Ikeja, Yaba/Maple Court, Surulere, Ikoyi, Victoria Island, Lekki) laid out on a grid with avenues between them, a lagoon crossed by two bridges, streetlights, townspeople and about 40 landmark and business buildings (hospital, mosque, church, market, university, stadium, hotels, restaurants, salons, gym, cinema, mall, bank, boat cruise, beach, golf club...). Walk anywhere. The area, place name, prices and listings follow your feet. Press **V** (or the pin button on the right) for **city view**: the camera pulls far back and every building shows a floating name label; the mouse wheel zooms between 7 and 170 m. Zoom in and the labels hide again.
- Open the Map and pick any area or building: **Walk there yourself** plans a route along the streets and over a bridge. Bus and taxi are quick journeys that cost money. Each area (and each state) lists its **places and businesses**.
- Cafes, restaurants, markets and malls are open: stand at the door and buy food and drink at that area's prices. The other buildings (hospital, university...) are scenery with labels for now.
- Other states are other worlds: use the Map to fly or take a bus.

## Cities, travel and currency
Eight cities in four countries (`game-data/geo.json`). Only Lagos is hand-laid; the others are **generated variants of the same neighbourhood** (recoloured, mirrored, renamed, price-scaled). The Map lists every city in the chosen country; tap a city, choose bus / taxi / flight (or a walk list inside your own city), and tap twice to pay. The fare is charged in the ledger, you travel (a few seconds to a minute), then arrive in that city's world. **Your wallet shows the currency of the country you are in**, converted at fixed game rates (1 MVC = ₦100 = GH₵0.8 = KSh8.6 = £0.05); the ledger itself is always MVC. The rates are game values, not real exchange rates.

## Homes, apartments and land
Click a house, the apartment block or a fenced plot in the world (or use the phone's **Homes** app, or the Map's "Homes & land here" button). The sheet shows size, beds, rent per week and price; Rent and Buy take two taps (the second confirms). After renting or buying a home you are taken to it at once. Land can be built on. The signs above each lot update every 20 seconds. Server messages: `app{app:'estate', a:'list|overview|rent|buy|build|sell|movein|leave'}`. Houses (and homes built on land) have a real inside with their own door that only the owner or tenant can pass. The apartment block is one shared room, so each tenant sees only their own furniture in it. Furnish mode: phone > Home Store to buy, sofa button to place (messages `app{app:'home', a:'info|place|pickup'}` and `app{app:'store', a:'list|buy'}`).

## Phone apps
Vault (activity, send money, loans, rates), Chatter (direct messages), Spark (dating, 18+), Odds (play-money betting, 18+), Jobs, Goals, Maps, Settings. All logic is on the server (`backend/src/modules/phone`). Rules and limits are in `docs/SAFETY.md` and `game-data/phone.json`.

## Known limitations
- All tenants share the one apartment interior (per-tenant instanced rooms come later).
- The cafe, job centre and bank are scenery. No sound or music. Art is simple stylized primitives, not final.
- The 3D client was exercised on software rendering (SwiftShader); real-GPU frame rates, low-end phones and Safari are **untested**.
- Chat history is not stored; only the last few lines are shown. The chat rate limit and word list are the starter versions described in `docs/ARCHITECTURE.md`.
- Game-server scale is untested: one process, one world instance. The earlier backend load test does not cover WebSocket traffic.
- Every district in every state is a recoloured or mirrored copy of the Maple Court layout, and the landmark buildings are generated from simple shapes. Real city maps would need hand-made level design.
- The browser build is much heavier than before. It uses merged and instanced geometry and 8 pooled streetlights, but it was only tested on software rendering (about 1 frame per second there); real GPU frame rates are unknown. Type `mvwStats()` in the browser console to see draw calls.
- The other seven cities are template variants of Lagos, not unique maps. Travel by bus/taxi is a loading screen, not a driven route.
- Click-to-report always files "harassment" for now (a category picker is a small follow-up).

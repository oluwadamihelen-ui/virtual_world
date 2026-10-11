# Voice chat plan (proposal, nothing built yet)

Goal: players inside the same building can talk by voice. Text chat already works building-wide (see `docs/WEB_CLIENT.md`).

## Rules (server decides, the client cannot override)
- **Off by default.** Each player opts in once (Settings > Voice) and the browser then asks for the microphone.
- **Adults only at first.** Under-18 accounts get no voice in version 1. Adults and minors are never in the same voice room (same rule as DMs, `docs/SAFETY.md`).
- **Same building only.** You join the room of the building you stand in and leave it when you walk out. Rooms are capped (start with 8 speakers).
- **Blocks, mutes and suspensions apply.** A blocked pair never hears each other; a moderator-muted or suspended account cannot speak.
- **Push-to-talk by default** (hold V is taken, so hold T), with a mute button, a "speaking" ring above heads, and a per-player mute.
- **No recording by default.** Reports attach who was in the room and when, plus the text evidence already captured. Recording voice needs a legal and consent decision first.

## How it would work
1. Game server (existing WebSocket) tracks voice rooms per building and checks the rules above before letting anyone join.
2. Audio goes **browser to browser over WebRTC**; the game server only relays signalling (`voice{offer|answer|ice}`) and never touches audio. Up to ~8 people this is a simple mesh.
3. A STUN server is needed, and a TURN server (for example coturn) for players behind strict networks. Both cost money to run.
4. Volume can fall off with distance inside big buildings (Web Audio panner) later.

## Known trade-offs
- Mesh WebRTC exposes players' IP addresses to each other. For public launch use a media server (SFU such as LiveKit) so players only connect to us; that also allows moderation tools and bigger rooms.
- Voice is harder to moderate than text. Before a public release we need a report-with-clip flow (opt-in, short rolling buffer) and moderator guidance.
- Cannot be fully tested in a headless server environment; needs two real devices with microphones.

## Build order
1. Server: voice opt-in flag, room membership by building, rule checks, signalling relay, tests (no audio needed).
2. Client: opt-in, push-to-talk, mesh WebRTC, speaking indicator, mute controls.
3. Two-device test on a real network, then decide STUN/TURN or SFU.
4. Safety review (minors, reporting, retention) before anyone outside the team uses it.

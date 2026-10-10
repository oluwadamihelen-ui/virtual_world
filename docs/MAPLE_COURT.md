# Maple Court: the first playable neighborhood (greybox)

**Status: written but never compiled or run by me** (no Unreal Engine in my environment). Expect to fix a compile error or two. Paste the error text and I'll fix it.

## What it is
When you press Play, a world subsystem (`UMVWMapleCourtSubsystem`) builds a small neighborhood out of basic engine cubes, in a zone 1 km away from Epic's practice level, and moves your character there. You don't edit the level or place anything.

```
            north (+X) →
   ┌────────────────────────────────────────────┐
   │ spawn                         ┌───────────┐│
   │  →            road ──────────→│  GROCERY  ││   east side, doorway faces the road
   │                               │ counter   ││
   │  ┌─────────────┐              │ work desk ││
   │  │ APARTMENTS  │              └───────────┘│
   │  │ (door)      │                           │
   │  └─────────────┘                           │
   └────────────────────────────────────────────┘
```

| Place | Key | What happens (the **backend** decides every outcome) |
|---|---|---|
| Apartment door (blue building) | **E** | Backend access check. If you don't rent it, it rents the first free room (500 MVC) and unlocks. The door panel disappears for 8 s so you can walk in. |
| Shop counter (orange building) | **E** / **R** | Buy a Sandwich (25 MVC) / Water (8 MVC). |
| Work station (yellow crate) | **E** | Start a shift, then press E for each task (the server insists on ~20 s between tasks). After the last task the wage (250 MVC) is paid. |

Top-left HUD: your name and **MVC balance**, home, backpack, and job progress. Text at the bottom shows results and errors.

## How it connects (and what it proves)
1. First run creates a throwaway dev account and saves it in `<project>\Saved\MVWDevIdentity.json`, so your money, room and items persist between runs. Delete that file to start fresh.
2. It logs in, finds or creates a character, asks the backend for a **join ticket** and redeems it (the production identity flow).
3. Every action is an HTTP call to your backend with idempotency keys. Nothing is calculated in Unreal.

## Limits (be aware)
- **Single-player and listen-server host only.** Connected multiplayer clients see the buildings and each other, but their E/R presses do nothing yet: they'd need server RPCs (next milestone). They see a yellow message saying so.
- Visuals are grey/colored boxes; labels are debug text. Colors rely on the engine material `BasicShapeMaterial` having a `Color` parameter. If everything looks plain white/grey, that's why; it doesn't affect gameplay and the labels still identify everything.
- Only the first free *room* is offered; if all rooms are rented (for example by test characters from the web page), you'll see "No rooms are free". Reset the backend database or end a tenancy to free one.
- Reads keys with `WasInputKeyJustPressed(E/R)`. If E/R don't react, tell me; the fallback is a normal Enhanced Input mapping.
- Uses `/Engine/BasicShapes/Cube` loaded by path, which is fine in the editor and Development builds but is not set up for a packaged release yet.

## How to update your project and try it (Windows)
1. **Close the Unreal Editor** completely (Live Coding blocks builds while it's open).
2. Download the repo ZIP again (same branch), extract it, and **copy the whole folder** `unreal\Source\MVWBackend` over `...\Unreal Projects\MVW\Source\MVWBackend`, answering **Replace** to everything.
3. Open `MVW.sln`, choose **Development Editor** + **Win64**, right-click **MVW** → **Build**. Wait for "Build: 1 succeeded". (Several minutes.)
4. Start the backend (`npm run dev` in `backend`).
5. New Command Prompt: `set MVW_SERVER_KEY=...` then start the editor with the command from the setup guide.
6. Press **Play**. You should drop into Maple Court. Walk to the labels.

## Test checklist (tell me which pass/fail)
- [ ] Compiles
- [ ] You spawn in a flat green area with a dark road, a blue building (west) and an orange building (east)
- [ ] HUD shows your name and "MVC: 2000"
- [ ] Orange building counter: E buys a sandwich, MVC drops by 25, backpack shows it
- [ ] Yellow crate: E starts a shift; 5 more presses ~20 s apart finish it, MVC +250
- [ ] Blue building door: E rents (MVC -500), door vanishes, you can walk in; E again later just opens it
- [ ] Stop and press Play again: balance, home and backpack are still there

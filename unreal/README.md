# Unreal Engine side

**Status: not built.** Unreal Engine was not installed in the environment where the backend was developed (Linux, no UE5), so nothing here has been compiled or run. `Source/MVWBackend` is a small module written against the UE5 HTTP/Json APIs from knowledge of the engine; expect to fix compile errors on first build.

## What exists
`Source/MVWBackend`: `UMVWBackendSubsystem` (GameInstance subsystem). Server-only bridge exposing `JoinCharacter`, `Purchase`, `RentProperty`, `StartShift`, `CompleteShiftTask`, `CompleteShift`, `SavePosition` with idempotency keys. It does nothing unless running as a dedicated server (or in the editor). Config: `-MvwBackendUrl=http://host:3000` and env var `MVW_SERVER_KEY`.

## Setup on Windows
Step-by-step with screenshots-in-words: **[docs/SETUP_WINDOWS_FULL.md](../docs/SETUP_WINDOWS_FULL.md)**. The notes below are the short technical version.

1. Install UE 5.4+ (Epic Launcher) and Visual Studio 2022 with the C++ game workload.
2. Create a C++ project from the *Third Person* template named `MVW` in `unreal/` (this gives you character movement, replication-ready defaults).
3. Copy `Source/MVWBackend` into the project's `Source/`, add `"MVWBackend"` to the module list in `MVW.uproject`, and add it to `PublicDependencyModuleNames` of the game module. Generate project files and build.
4. Add a dedicated-server target (`MVWServer.Target.cs`, `TargetType.Server`) — requires a source-built engine for packaged dedicated servers.
5. Run the backend, set `MVW_SERVER_KEY`, start the server with `-log -MvwBackendUrl=http://127.0.0.1:3000`, connect two clients (PIE with "Run Under One Process" off, net mode "Play As Client", 2 players).

## Maple Court
See **[docs/MAPLE_COURT.md](../docs/MAPLE_COURT.md)** for the greybox neighborhood (`MVWMapleCourt.*`).

## Recommended build order for the in-engine slice
1. Greybox residential block (one street, one enterable room, one shop counter, one workstation) in a World Partition-free small level.
2. Login screen → character list/create (player JWT REST) → connect to server with `characterId` + a short-lived join ticket (**backend endpoint for tickets does not exist yet**: add before trusting the client-supplied `characterId`; today the game server must establish identity itself).
3. Interactables (door, counter, workstation) as server-validated actors that call the subsystem and replicate the confirmed result (balance, inventory) to the owning client only.
4. Persist position on disconnect and periodically; call `JoinCharacter` on connect and apply the returned summary.
5. Proximity chat via server RPC with distance filtering; emotes as replicated montages; report button → `/v1/reports`.

## Security reminder
`MVW_SERVER_KEY` must exist only on server machines. Never put it in a packaged client, `DefaultGame.ini` or the repository.

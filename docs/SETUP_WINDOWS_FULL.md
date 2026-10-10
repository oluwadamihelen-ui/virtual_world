# Full Windows setup: backend + Unreal Engine (step by step)

## Read this first (what you will and won't see)

- ✅ You **will** see: the backend running; the test web page (rent, buy, work, shop); a **3D character you can walk around with a second player** (this is Epic's free *Third Person* demo level, not my city); and on-screen messages in Unreal proving it can talk to the MVW backend.
- ❌ You will **not** see: the city **New Meridian**, apartments, shops, or jobs in 3D. Those haven't been built. This setup gets the 3D foundation running so that work can begin.
- ⚠️ **Honesty note:** the backend steps were tested on Linux. The Unreal steps have **never been run by me** (I have no Unreal Engine). The C++ module may fail to compile the first time. If it does, copy the red error text to me and I'll fix it.

**Time:** about 3 hours, mostly downloads and one long wait for Unreal's first start.
**You need:** Windows 10/11 64-bit, 16 GB RAM (32 GB is better), a graphics card that supports DirectX 12, and about **100 GB** of free disk space (SSD recommended).

---

# PART A — The backend (the "engine room")

### A1. Install Node.js
https://nodejs.org → green **LTS** button → run it → **Next**… **Finish**.

### A2. Install PostgreSQL 16
https://www.postgresql.org/download/windows/ → **Download the installer** → version **16** → run it.
It asks for a **password**: choose one and **write it on paper**. Keep port **5432**. Untick "Stack Builder" at the end.

### A3. Get the game files
1. https://github.com/oluwadamihelen-ui/virtual_world (sign in if asked).
2. Branch button → **claude/blissful-lamport-vc52z7**.
3. Green **Code** button → **Download ZIP**.
4. Right-click the ZIP in Downloads → **Extract All…** and put it somewhere short, like `C:\virtual_world` (long folder names cause trouble later).

Restart your computer once.

### A4. Start the backend
1. Open `C:\virtual_world\backend`. Click the address bar, type `cmd`, press **Enter**.
2. Type these one at a time (Enter after each):
```
npm install
npm run setup
npm run dev
```
`npm run setup` asks for your PostgreSQL password from A2. When `npm run dev` says it's listening on port 3000, **leave that window open**. If Windows asks about the firewall, click **Allow**.

### A5. Check it
Open **http://localhost:3000/dev** in Chrome/Edge. Paste the text after `SERVER_API_KEY=` from the file `backend\.env` (open with Notepad; if you can't see `.env`: File Explorer → View → Show → Hidden items) into the first box, make a character, rent a room, buy a sandwich. If that works, Part A is done. 🎉

---

# PART B — Unreal Engine

### B1. Install Visual Studio 2022 (Unreal needs it to compile C++)
1. https://visualstudio.microsoft.com/downloads/ → **Community 2022** (free) → download and run.
2. Tick **Game development with C++**. Also tick **.NET desktop development**.
3. On the right side, check that **Windows 11 SDK** (or Windows 10 SDK) is ticked. Click **Install** (about 10–15 GB).

Epic's own page lists the exact Visual Studio components for each Unreal version: search "Unreal Engine Setting up Visual Studio for UE" if the build later complains about a missing component.

### B2. Install the Epic Games Launcher and Unreal Engine
1. https://www.unrealengine.com/download → download the **Epic Games Launcher**, install it, sign in (create a free account if needed).
2. Left side: **Unreal Engine** → tab **Library** → click the yellow **+ (Add Engine Version)**.
3. Choose **5.4.x or newer** (5.5 is fine). Click **Install**, accept the default folder and options, and wait. This is 40–60 GB, so it can take 1–2 hours. Leave your PC on.

### B3. Make the project from Epic's Third Person template
1. Epic Launcher → **Unreal Engine → Library → Launch**. Wait for the project browser (the first start can take several minutes).
2. Click **Games** → **Third Person** → **Next**.
3. Project Defaults, set exactly:
   - **C++** (NOT Blueprint)
   - **Starter Content:** off
   - **Project Location:** `C:\UnrealProjects` (create the folder if needed)
   - **Project Name:** `MVW`
4. Click **Create**. Unreal builds the project and opens the editor (first time: 5–20 minutes while it compiles shaders). Then **close the editor**.

You now have `C:\UnrealProjects\MVW\MVW.uproject`.

### B4. Add the MVW backend module
1. Copy the folder `C:\virtual_world\unreal\Source\MVWBackend` into `C:\UnrealProjects\MVW\Source\` (so you get `C:\UnrealProjects\MVW\Source\MVWBackend\MVWBackend.Build.cs`).
2. Open `C:\UnrealProjects\MVW\MVW.uproject` with Notepad. Find the `"Modules"` list and add the second entry:
```json
"Modules": [
    {
        "Name": "MVW",
        "Type": "Runtime",
        "LoadingPhase": "Default"
    },
    {
        "Name": "MVWBackend",
        "Type": "Runtime",
        "LoadingPhase": "Default"
    }
],
```
(Mind the comma between the two blocks.) Save.
3. Open `C:\UnrealProjects\MVW\Source\MVW\MVW.Build.cs` with Notepad. Find the line starting `PublicDependencyModuleNames.AddRange(` and add `"MVWBackend"` to the list, for example:
```csharp
PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "InputCore", "EnhancedInput", "MVWBackend" });
```
(Keep whatever names your file already has; just add `"MVWBackend"` at the end.) Save.

### B5. Build it
1. In `C:\UnrealProjects\MVW`, right-click **MVW.uproject** → **Generate Visual Studio project files** (on Windows 11 you may need "Show more options" first).
2. Double-click the new **MVW.sln** (opens Visual Studio).
3. In the toolbar choose **Development Editor** and **Win64**. In the right-hand Solution Explorer right-click **MVW** (under *Games*) → **Build**. Wait 5–15 minutes.
4. The bottom should say **Build: 1 succeeded**. If it shows **errors**, copy the red text and send it to me. That's expected to happen once or twice with code written without an engine to test against.

### B6. Open the game and look around
1. Make sure the backend from Part A is still running (the black window).
2. Open a **new** Command Prompt and start the editor with your key (replace the path if your engine folder is `UE_5.5`, and paste your real key after the `=`):
```
set MVW_SERVER_KEY=PASTE_THE_KEY_FROM_backend\.env_HERE
"C:\Program Files\Epic Games\UE_5.4\Engine\Binaries\Win64\UnrealEditor.exe" "C:\UnrealProjects\MVW\MVW.uproject"
```
   (Starting it from this window is what lets Unreal see the key.)
3. In the editor, press the green **Play** button. Walk with **W A S D**, look with the mouse, jump with **Space**. 🎮 That's your 3D character.
4. Press **`** (the key under Esc) to open the console and type:
   - `mvw.health` → green text **"MVW backend: ONLINE"** means the 3D game can talk to your backend.
   - `mvw.shop` → cyan lines listing Bottled Water, Desk Lamp, Sandwich… prove the secret key works.

### B7. See two players at once
1. Next to the **Play** button click the **⋮** (three dots) → **Advanced Settings**.
2. Set **Number of Players** to **2** and **Net Mode** to **Play As Client**.
3. Press **Play**. Two windows open. Walk in one window and watch your character move in the other. 👀 That is real multiplayer through a dedicated server running inside the editor.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not log in to PostgreSQL` | Wrong password: run `npm run setup` again. |
| `ECONNREFUSED` | PostgreSQL isn't running: Windows key → *Services* → **postgresql-x64-16** → Start. |
| `'npm' is not recognized` | Restart the PC after installing Node.js. |
| Unreal asks "Missing modules, rebuild?" | Click **Yes**. If it fails, build in Visual Studio (B5) to see the real error. |
| Build error mentioning `MVWBackend` | Copy the full red error text to me. If it says it can't find the module, also add `ExtraModuleNames.Add("MVWBackend");` next to the `MVW` line in `Source\MVW.Target.cs` and `Source\MVWEditor.Target.cs`. |
| Build says Windows SDK / MSVC missing | Open the **Visual Studio Installer** → *Modify* → tick the missing component. |
| `mvw.health` says NOT REACHABLE | Backend window closed, or not on port 3000. Start `npm run dev` again. |
| `mvw.shop` says failed / 401 | You didn't start the editor from the window where you ran `set MVW_SERVER_KEY=...`, or the key was pasted wrong. |
| "subsystem not available" | The module didn't load: re-check B4 step 2 (uproject) and rebuild. |
| Editor is slow / stutters | Lower the editor's engine scalability: Settings (top right) → **Engine Scalability Settings** → Medium. |
| Folder names too long errors | Keep projects near the drive root (`C:\UnrealProjects`). |

## What's next (once this works)
Build the first neighborhood from basic shapes, add interactables (door, shop counter, job station) that call the backend through `UMVWBackendSubsystem`, and a small HUD showing your MVC. Tell me when B6/B7 work, or send me the first error you hit.

# See My Virtual World running — a guide for beginners (Windows)

**What you will see:** a web page with buttons. You make a character, rent a room, buy a sandwich, work a shift and earn money. Then you "disconnect", and everything is still there.

**What you will NOT see:** a 3D city. That part needs a game-making program called Unreal Engine and has not been built yet. What you're about to run is the game's *engine room*: the part that keeps track of money, homes and jobs, and stops cheating.

> This guide was tested on Linux. The steps are the same on Windows, but nobody has run them on Windows yet. If something is different, tell me exactly what you saw.

Time needed: about 30 minutes, most of it waiting for downloads.

---

## Part 1 — Install 3 things (one time only)

### 1. Node.js (it runs the engine room)
1. Go to **https://nodejs.org** and click the big green **LTS** button.
2. Open the downloaded file and click **Next** until it says Finish. Leave every box as it is.

### 2. PostgreSQL (the engine room's notebook, where it writes everything down)
1. Go to **https://www.postgresql.org/download/windows/** and click **Download the installer**.
2. Choose version **16**, Windows x86-64, and download.
3. Open it and click **Next**. When it asks for a **password**, type one you will remember and **write it on paper**. This is *your* PostgreSQL password. You'll need it in a minute.
4. Keep the port as **5432**. Click **Next** until it installs. If it asks about "Stack Builder" at the end, untick it and click Finish.

### 3. The game files
1. Go to **https://github.com/oluwadamihelen-ui/virtual_world** and sign in if it asks.
2. Click the branch button (it says `main`), choose **claude/blissful-lamport-vc52z7**.
3. Click the green **Code** button, then **Download ZIP**.
4. Open your Downloads folder, right-click the ZIP and choose **Extract All…**

Restart your computer once so Windows notices what you installed.

---

## Part 2 — Start the engine room

### 4. Open the Command Prompt in the right folder
1. Open the extracted folder, then open the folder called **backend**. You should see files such as `package.json`.
2. Click on the **address bar** at the top of the window (where the folder path is), type `cmd` and press **Enter**.
3. A black window opens. This is the Command Prompt. (Use this one, not "PowerShell". It causes fewer problems.)

### 5. Type these, one at a time, pressing Enter after each

```
npm install
```
Wait until it finishes (a minute or two). Some warnings are OK.

```
npm run setup
```
It asks for your PostgreSQL password. **Type the one from step 2 and press Enter** (the letters will show as you type, so type carefully). You should see green ticks ✔ and **"All set!"**

```
npm run dev
```
Wait until you see a line saying the server is listening on port 3000. **Leave this black window open.** If you close it, the game stops. If Windows asks about the firewall, click **Allow**.

### 6. Open the test page
Open Chrome or Edge and go to: **http://localhost:3000/dev**

---

## Part 3 — Play with it

**Step 1 — Secret key.** In the `backend` folder, open the file named **.env** with Notepad (right-click → Open with → Notepad. If you can't see it, in File Explorer click *View → Show → Hidden items*). Find the line `SERVER_API_KEY=` and copy the long text after the `=` sign. Paste it into the first box on the page. It remembers it for next time.

**Step 2 — Make a player.** Type a name (3 to 20 letters or numbers) and click **Create my character**. You get **2000 MVC** (My Virtual Credit, the game money).

Now try things and watch the green and red lines in "What just happened":

| Try this | What should happen |
|---|---|
| Click **Rent** on Room 101 | Money goes down by 500. Your home shows up. The room says *(taken)*. |
| Click **Buy 1** next to Sandwich | Money goes down by 25. A sandwich appears in your backpack. |
| Click **Work a shift** | Wait about 100 seconds (the server's clock can't be rushed). You earn **250 MVC** and 10 retail xp. |
| Click **🔄 Pretend I disconnected & reconnected** | Nothing is lost. Money, home, backpack and skills are all still there. |
| Keep clicking **Buy 1** on Starter Sofa | After 2, it's **sold out**, and your money is not taken for the failed try. |
| Keep buying until you're broke | You get **"Not enough MVC!"** and the balance never goes below 0. |
| Click **Create my character** again with the same name | **"That name is taken."** |
| Open the page in a second browser window and make a second player | They can't take the room you rented. |

### Run your own shop 🏪
1. Click **Give me 5000 test MVC** in the "Test helpers" box (this button only exists for testing).
2. Under **Your business**, click **Open "Corner Plus" shop** (costs 3000 MVC).
3. Click **Put 1000 MVC in the till**, then **Buy 20 sandwiches wholesale**. Your shelf now shows sandwiches at a default price.
4. Click **Sandwich price → 20**, then click **Make 6 pretend customers shop right now** a few times. (Real pretend customers also arrive by themselves every minute.)
5. Watch the line **Till / Revenue / Costs / Profit**. Profit starts *negative*, because you paid for the sandwiches before you sold them. That's how real shops work too!
6. Try **Sandwich price → 40**. It's too expensive and the pretend customers walk past. Prices that are too low earn little, and prices that are too high earn nothing.

The **Money history** box is the game's receipt book. Every coin that moves is written down there.

---

### Be a moderator 🛡️ (optional)
1. On the test page, make a second character in another browser window and use it later to report the first one (reports are filed by the game; there is no button on this page yet).
2. Make an account a moderator: in the black window press **Ctrl+C**, then type `npm run set-role -- your-email@example.com moderator` (use the email of an account you registered, then start the server again).
3. Open **http://localhost:3000/mod**, sign in, and you'll see the report queue with buttons to dismiss, warn, mute or suspend (you must write a short note).

## Part 4 — Stopping and starting again

- **Stop:** click the black window and press **Ctrl + C** (then Y if it asks).
- **Start again later:** open the `backend` folder, type `cmd` in the address bar, then `npm run dev`. (You don't need `npm install` or `npm run setup` again.) Your characters and money are saved in PostgreSQL, so they're still there.
- **Run the safety checks** (optional): `npm test`. It takes about 15 seconds and should say **83 passed**.

## When something goes wrong

| What you see | What to do |
|---|---|
| `'npm' is not recognized` | Restart the computer after installing Node.js. Still no? Reinstall Node.js. |
| `Could not log in to PostgreSQL (28P01)` | Wrong password. Run `npm run setup` again and type the password from step 2. |
| `ECONNREFUSED` or "Is PostgreSQL running" | PostgreSQL isn't running. Press the Windows key, type **Services**, open it, find **postgresql-x64-16**, right-click → **Start**. |
| `Port 3000 already in use` | Another copy is running. Close other black windows, or restart the computer. |
| The page says "The secret key is wrong or missing" | Re-copy `SERVER_API_KEY` from `.env` (only the part after `=`, no spaces). |
| Page doesn't open | Make sure the black window is still open and says it's listening. |
| Anything else | Copy the red text from the black window and send it to me. |

## What is real and what isn't yet

- ✅ Real and tested: accounts, characters, money ledger, rent, jobs, shop, anti-cheating rules, saving.
- ❌ Not built yet: the 3D city, walking around, seeing other players, chat, businesses, voting. These need Unreal Engine, which is the next big step.

**This page is only a helper for developers.** It never appears in the real game, and the server switches it off when it's set to production mode.

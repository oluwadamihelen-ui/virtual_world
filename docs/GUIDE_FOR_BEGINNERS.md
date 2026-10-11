# Play My Virtual World on your computer (Windows, step by step)

**What you'll get:** a 3D neighborhood in your web browser (Chrome or Edge). You make a character, walk around, rent a room, buy food, work a shift, chat and wave at other players. Everything is saved.

**You do NOT need Unreal Engine or Visual Studio for this.** Only three downloads.

> I tested these steps on Linux. They should be the same on Windows. If something looks different, tell me exactly what you see (a screenshot helps).

Time: about 20 minutes, mostly waiting for downloads.

---

## Part 1: Install 3 things (one time only)

### 1. Node.js (it runs the game server)
Go to **https://nodejs.org**, click the green **LTS** button, open the file, and click **Next** until it finishes.

### 2. PostgreSQL 16 (it saves everything)
1. Go to **https://www.postgresql.org/download/windows/** and click **Download the installer**. Choose version **16**.
2. Open it and click **Next**. When it asks for a **password**, choose one and **write it on paper**. You'll need it later.
3. Keep the port **5432**. Untick "Stack Builder" at the end.

### 3. The game files
1. Go to **https://github.com/oluwadamihelen-ui/virtual_world** (sign in if it asks).
2. Click the branch button (it says `main`) and choose **claude/blissful-lamport-vc52z7**.
3. Click the green **Code** button, then **Download ZIP**.
4. Right-click the ZIP in Downloads, choose **Extract All…**, and put it in a **new** folder such as `C:\virtual_world_new` (so it doesn't mix with older copies).

Restart your computer once.

---

## Part 2: Start the game server

1. Open the extracted folder, then the folder called **backend**.
2. Click the **address bar** at the top of the window, type `cmd`, and press **Enter**. A black window opens.
3. Type these three commands, one at a time, pressing **Enter** after each:

```
npm install
```
Wait until it finishes (a minute or two). Warnings are fine.

```
npm run setup
```
It asks for your **PostgreSQL password** (from step 2). Type it and press Enter. You should see green ticks and "All set!" (If it says things "already exist", that's fine: your old characters are still there.)

```
npm run dev
```
Wait for the message **"My Virtual World is running"**. **Leave this black window open.** If Windows asks about the firewall, click **Allow**.

---

## Part 3: Play!

Open Chrome or Edge and go to:

# http://localhost:3000/play/

1. Click **Create account**, type an email, a password (10+ characters) and your **date of birth**, and click the green button. (Under 13 can't play. Under 18 can't open the dating or betting apps.)
2. Make your character: type a name (3 to 20 letters/numbers) and pick your look. Click **Enter the city**.
3. You're in **New Meridian**. 🎉

### Controls
| What | Computer | Phone / tablet |
|---|---|---|
| Walk | **W A S D** or arrow keys | the round joystick |
| Run | hold **Shift** | push the joystick to the edge |
| Look around | click and drag the background | drag |
| Zoom | mouse wheel | pinch |
| Use something | press **E**, or tap the green button on the card that pops up | tap the card button |
| Chat | press **Enter**, type, press Enter | tap the box at the bottom |
| Emote | tap 😀 and pick one | same |
| Report or block a player | click their blue name tag | tap it |

### Things to try (watch your MVC money at the top)
- 🏠 **Rent a room:** tap **Apartments** at the bottom to be guided there, stand on the glowing ring by the blue building's door, and tap **Rent & move in**. Then walk through the door. (Nobody without a tenancy can!) The walls drop away so you can see inside.
- 🛒 **Buy lunch:** tap **Grocery**, walk to the counter, and tap **Sandwich**.
- 💼 **Earn money:** at the yellow crate (the **Work station**) start a shift, then do 5 tasks, about 20 seconds apart. You earn **250 MVC**.
- 📱 **Phone** (right side): **Vault** (send money to a friend by their exact name, take a loan, see exchange rates), **Chatter** (messages), **Spark** (dating, 18+), **Odds** (play-money betting, 18+), Jobs, Goals, Maps.
- 🗺️ **Map:** pick a country tab, tap a city, choose Bus / Taxi / Flight, and tap again to pay. When you arrive, your money changes to that country's currency (₦ in Nigeria, GH₵ in Ghana, KSh in Kenya, £ in the UK).
- 🏠 **Homes, apartments and land:** every area has an apartment block (rooms and flats), three houses and four empty plots. Each has a floating sign with its price. **Click or tap one** (or open the phone's **Homes** app) to see the details, then **Rent** or **Buy** (tap twice to confirm). You move in immediately. On an empty plot you can **Build a home** later, and you can **Sell back** or **Move out** any time. Prices are big numbers because 1 MVC is N100. To try buying a house, give yourself money: leave the game running, open a second black window in the `backend` folder (type `cmd` in the address bar again) and run `npm run grant -- "Your Character Name" 50000`.
- 🛋 **Furnish your home:** every home starts empty and has a real inside (walk through the door). Open the phone's **Home Store**, buy furniture (it goes to your backpack), then tap the **sofa button** on the right while you are inside your home. Pick a piece, tap the floor to place it (green = fits, red = blocked, **R** turns it), and tap placed furniture to pick it up again. Other players cannot see or touch your furniture.
- 📈 **Invest:** prices follow how many people live in an area. Open **Homes** to see each area's value trend, buy where it is rising, and sell later from the same sheet (a 5% fee applies). **My properties** shows what you paid and your profit if you sold today.
- 🌆 **The whole city:** Lagos is now one big city you can walk around. Cross the bridges between districts, press **V** to zoom out to **city view** (names of every landmark and business appear), and use the **Map** to get directions ("Walk there yourself") or to list the places and businesses in each area. **Tap any floating name label** to get there: choose walk (free), bike, city bus or taxi, and you arrive at the door. Cafes, restaurants, markets and malls sell food and drink. Hospitals, schools and other landmarks are scenery for now. If the game feels slow on your computer, close other programs and tell me your graphics card.
- 🏙 **Areas:** Lagos has 6 areas (Yaba, Ikeja, Surulere, Ikoyi, Victoria Island, Lekki) and the other big cities have more than one too. Open the **Map**, use the "Lagos areas" tab, and walk (free, under 4 km), take a bus or a taxi. Each area has its own prices.
- 💱 Try it: in the Map choose **Accra** and take the flight. Your wallet changes from ₦ to GH₵.
- 🌙 Wait a few minutes and the sun sets: street lamps and windows light up. (A whole day lasts 24 real minutes.)
- 👯 **Play with a friend:** open a second browser window (or another computer on the same Wi-Fi, using `http://YOUR-PC-IP:3000/play`), create a second account, and wave at each other. Chat only reaches players close to you.

Close the browser tab any time. When you come back and sign in, your money, home, backpack and position are still there.

---

## Part 4: Try messaging with a second player (same computer)

1. Keep your first browser window open and signed in.
2. Open a **private/incognito window** (Ctrl + Shift + N in Chrome or Edge) and go to `http://localhost:3000/play`. Create a **second account** (different email) with a different character name. Use a date of birth that makes the player **18 or older** for both (messages only connect players in the same age group).
3. In window 1: tap the **phone** icon, then **Chatter**, **New message**, type the **exact name** of your second character, then **Start chat** and send a message. (Shortcut: click another player's name tag in the world and choose **Message**.)
4. In window 2: a toast says "New message from…", the phone icon shows a red number, and the message is waiting in **Chatter**. Reply, and window 1 updates live.
5. Also try **Vault > Send** (money), and the **Map** (take a flight to another country and watch your money change currency).

**How private are messages?** Only the two people in a chat can read it. Other players never see it, and other players cannot ask the server for it. Messages are **encrypted in the database** so a copy of the database does not show them in plain text. It is **not end-to-end encryption**: the game server holds the key and could read them. The only time a moderator sees any messages is when one player **reports** the other: then the last 15 messages between those two are attached to that report. Block a player and you will not get their messages. In production set a separate `MESSAGE_KEY` in `backend/.env` (32+ random characters) and back it up: if you lose it, old messages cannot be read.

---

## Stopping and starting again
- **Stop:** click the black window and press **Ctrl + C**.
- **Updating to a newer download:** extract the new ZIP into a new folder, copy your old `backend\.env` file into its `backend` folder, run `npm install` and `npm run dev` (the database upgrades itself).
- **Start again later:** open the `backend` folder, type `cmd` in the address bar, and run `npm run dev`. (No need for the other two commands again.)

## If something goes wrong
| What you see | What to do |
|---|---|
| `'npm' is not recognized` | Restart the computer after installing Node.js. |
| `Could not log in to PostgreSQL` | Wrong password. Run `npm run setup` again and type your PostgreSQL password. |
| `EADDRINUSE: address already in use ...:3000`, or `/play` says "Route GET:/play not found" | An **older copy** of the game is still running and holds port 3000 (the 404 comes from the old copy). Close every black window, or open one and run `netstat -ano \| findstr :3000`, then `taskkill /PID <the number at the end> /F`. Then run `npm run dev` again in the **new** folder. Or edit `backend\.env`, set `PORT=3001`, and open `http://localhost:3001/play`. |
| `ECONNREFUSED` or "Is PostgreSQL running?" | Press the Windows key, type **Services**, find **postgresql-x64-16**, right-click, **Start**. |
| Page says "Cannot reach the game server" | The black window isn't running. Start it again with `npm run dev`. |
| The 3D view is black or very slow | Update your browser and graphics driver. Try Chrome or Edge. Close other heavy programs. |
| Another PC on your Wi-Fi can't connect | Windows Firewall: allow Node.js on **Private networks**. |
| Anything else | Copy the red text from the black window, or send a screenshot. |

## For developers and testers (optional)
- `http://localhost:3000/mod`: moderator page (make yourself a moderator with `npm run set-role -- your-email@example.com moderator`).
- `http://localhost:3000/dev`: the older button-panel test console for the money system.
- `npm test`: the automated safety checks (about a minute; it erases the **test** database only).

## What isn't built yet
Other districts (market, central, waterfront), real services inside most public buildings (you can walk into banks, cafes and the like and see people there, but only food and the bank counter do anything), businesses in 3D, trading in 3D, voice chat, sound, and real art (everything is simple stylized shapes). The earlier Unreal Engine version is paused; the browser game is the main version now.

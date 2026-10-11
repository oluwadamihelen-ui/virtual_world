# Life apps: Health, Courses, Cars, Assurance

All numbers live in `game-data/life.json` (and the new jobs in `game-data/jobs.json`); they are **placeholder values to tune by playtesting** (`docs/ECONOMY_TUNING.md`). Everything is decided on the server; the phone apps only show it. Tested in `backend/test/life.test.ts` (ledger integrity checked after bills, claims and sales). The screens were looked at in a headless browser on software rendering; real-device feel is untested.

## Health (phone > Health, heart bar under the wallet)
- Health is 0 to 100. You start at 90, lose 3 an hour (offline time counts, at most 16 hours' worth) and 6 per finished shift.
- Below 25 you cannot start a shift. Below 20 you walk slower (server-enforced, ×0.6).
- Treatments: pharmacy tablets (+20, anywhere), clinic check-up (+45, anywhere, 40% off inside a clinic or hospital building), hospital treatment (full recovery, **only while standing inside a hospital or clinic**). Fees go to the medical sink account.

## Courses (phone > Courses)
- Pay tuition, study for a real-time number of minutes (you can log off), then you get a **credential** and skill XP. One course at a time.
- Customer service (unlocks Bank Teller job), Driving school (driving licence: needed to buy or drive a car, and for the Delivery Driver job), Business administration (needs reputation 1; unlocks Office Manager). Jobs with a `requirements.credential` refuse to start without it.

## Cars (phone > Cars)
- Needs the driving licence. Buy up to 3 cars (hatchback, sedan, SUV, sports coupe), pick one active, then **Drive** (or **Park** on the dashboard at the top of the screen). Cars cannot go indoors.
- Driving is 2.8 to 3.8 times walking speed, set by the server. It burns fuel by distance and wears the car; you can crash (random, about 6% per km, damage 12 to 28 points). Below 30% condition the car slows; at 0 it stops; out of fuel it stops.
- Refuel and repair in the app anywhere; **30% cheaper while standing inside a garage building**. Selling pays a share of the price depending on condition (50% to 85%). Other players see your car.
- Fuel and wear are tracked in memory while you drive and saved when you stop, every 15 seconds, and when you disconnect.

## Assurance (phone > Assurance)
- Health cover (70% or 90% of treatment bills) and car cover (70% or 90% of repair bills, per car, premium is a percentage of the car's price).
- Cover starts 12 hours after buying, so you cannot insure after the accident. Premiums are charged weekly from your wallet; if you cannot pay, the policy lapses (never goes into debt). The insurer's share is paid by a system account in the same ledger transaction as your share.
- Home cover is listed as coming soon.

## Known limits
- No events yet that damage homes, so there is no home cover. Crashes only happen in cars.
- Health has no food or sleep system; time and shifts are the only drains.
- Cars have no police, tickets, parking or theft. Speed is not capped by traffic.
- The car model is a simple box car; no sounds.
- Balance of prices (course fees vs wages, car prices vs top-up packs) is a first guess.

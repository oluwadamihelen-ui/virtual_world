# Safety, age and money rules (what is built, and what is NOT)

## Age
- Sign-up asks for a **date of birth**. Under 13 is refused. The date is **self-declared**: there is no ID check, so a child can lie. Treat age rules as a first layer, not a guarantee.
- Under-18 accounts, and old accounts with no date of birth, are treated as the **safe group**.
- **Adults (18+) and under-18s are never connected** by direct messages (Chatter) or money transfers (Vault). The server enforces this, not the screen.
- **Spark (dating) and Odds (betting) are 18+ only.** The server refuses every request from non-adults (`adults_only`); the phone shows them locked.
- Loans are 18+ only.

## Spark (dating)
- Both sides must be adults. No photos, no exact age, no street-level location; only name, city, reputation, a short filtered bio and interests.
- Mutual likes become matches; only matches are suggested for messaging by the app, but Chatter itself works between any two same-age-group players who are not blocked.
- Block and report buttons on every profile. Blocked players never see each other. A player can pause or **delete** their profile, likes and matches.
- 50 swipes per day.

## Odds (betting)
- **Play money only.** MVC cannot be bought, sold or cashed out anywhere in this project. If that ever changes, real-money gambling law applies and this feature must be reviewed by a lawyer **before** it ships.
- Fixtures and results come from a server-side secret, so they cannot be predicted or edited; the house edge (8%) is shown to players.
- Limits (in `game-data/phone.json`): stake 10 to 500 MVC, 10 open bets, **24-hour loss limit 2,000 MVC**, and a **take-a-break** self-exclusion (1, 7 or 30 days) that cannot be cancelled early.
- Results are fictional teams, not real sport.

## Money
- Send money: max 5,000 MVC per transfer, 20,000 per day (2,000 for under-18s). Idempotent (a double tap never pays twice).
- Loans: limit grows with reputation (500 + 100 per point, up to 5,000), flat 10% fee, 72 h term, one at a time. If overdue, up to 30% of the **wallet** is collected at most once an hour. Items and homes are never taken. Wallet cannot go below zero.
- Every movement is a double-entry ledger transaction; `verifyLedgerIntegrity` is asserted in the tests.

## Other
- Chat filter, rate limits, block, report and moderator tools exist (see ARCHITECTURE).
- **Not built:** parental controls, ID/age verification, an audit trail for the apps' messages beyond the database, moderator review of direct messages or profiles (reports file against the player; there is no UI to read a DM), account deletion for the whole account. A privacy policy, terms and a legal review (data protection, children's online safety, gambling, lending) are required before real users.

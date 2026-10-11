# Wallet top-ups (buying MVC with real money)

**Status:** built and tested against a *fake* provider API in `backend/test/topup.test.ts` (signatures, amounts, replays, limits, ledger integrity). **Not yet run against any real Paystack, Flutterwave or Korapay account**, so do the sandbox checks below before taking real money. The provider adapters follow each provider's public documentation (`backend/src/modules/topup/providers.ts`); I could not open the providers' docs from the build environment, so confirm endpoint details against their current docs while testing.

## What players see
Phone > **Top up**: four packs at fixed rates (`game-data/topup.json`), a Naira / USD switch, and these payment methods: Paystack, Flutterwave, Korapay (each shown only when its keys are set) and **Bank transfer** (shown when `MANUAL_TOPUP_INSTRUCTIONS` is set).

| Pay | Game money | MVC |
|---|---|---|
| ₦1,000 / $1 | ₦50,000 | 500 |
| ₦5,000 / $4 | ₦300,000 | 3,000 |
| ₦10,000 / $7 | ₦700,000 | 7,000 |
| ₦20,000 / $14 | ₦1,600,000 | 16,000 |

(1 MVC = ₦100 game money.) Packs, prices and limits live in `game-data/topup.json`.

## How a payment is made safe
1. The player picks a pack; the server creates an order with our own reference and the price it expects, then asks the provider for a checkout page. The player pays on the **provider's** page; the game never sees card details.
2. The provider calls our webhook (`POST /v1/webhooks/paystack|flutterwave|korapay`). We check the signature, but we **never trust the webhook's amount or status**: we only read the reference from it, then ask the provider's API (with our secret key) whether it was paid, how much and in what currency.
3. Only if the confirmed amount covers the price and the currency matches, the MVC is credited from the system account `faucet:topup` through the ledger with the idempotency key `topup:<order id>`. Webhook retries, the player's own "Check payment", and the return page can all fire together and it is still credited once. A short payment goes to "review" and nothing is credited.
4. When the player returns from the provider (`/topup/return` then `/play/?topup=<ref>`) and while the Top up screen is open, the game also checks the payment itself, so it works even if a webhook is delayed.
5. **Manual bank transfer:** the player gets the reference and your bank details, transfers, then taps "I have paid" with the sender name. An admin sees it at `GET /v1/admin/topups?status=review` and approves or declines with `POST /v1/admin/topups/:id/decide {approve, note}` (admin role only; every decision is audited). The admin screen is the moderator console at `/mod` (sign in as an admin): the "manual top-ups" card lists transfers waiting for you with player, amount, reference, sender name and note; **Approve** (asks you to confirm) or **Decline** (needs a short reason). Moderators who are not admins cannot see it.

## Rules
- Adults only (18+); suspended or banned accounts cannot buy.
- Limits (data file): 5 unfinished orders, ₦100,000 per player per 24 hours (USD packs counted at the rate in `limits.usdToNgnForLimits`). Unpaid provider orders expire after 60 minutes (a late payment is still credited if it arrives).
- Game money cannot be cashed out or refunded to real money. Say so in your terms.

## Setting it up (operator)
1. Put the keys in `backend/.env` (never in git); see `.env.example`: `PUBLIC_BASE_URL` (the address players use, https in production), then per provider:
   - **Paystack:** `PAYSTACK_SECRET_KEY`. Dashboard > Settings > API Keys & Webhooks: webhook URL `PUBLIC_BASE_URL/v1/webhooks/paystack`.
   - **Flutterwave:** `FLUTTERWAVE_SECRET_KEY` and `FLUTTERWAVE_SECRET_HASH` (invent a long random string, enter the same value as the "secret hash" in Settings > Webhooks), webhook URL `.../v1/webhooks/flutterwave`.
   - **Korapay:** `KORAPAY_SECRET_KEY`, webhook URL `.../v1/webhooks/korapay` in the dashboard.
   - **Bank transfer:** `MANUAL_TOPUP_INSTRUCTIONS`.
2. Webhooks need a public https address. On your own computer use a tunnel (for example ngrok) while testing.
3. USD only works if USD collection is enabled on that provider account.
4. Restart the server; the Top up app now shows the methods as available.

## Sandbox checklist before real money
- [ ] One test payment per provider with the provider's TEST keys: order goes paid, balance rises once.
- [ ] Pay the wrong amount in the sandbox: nothing credited, order in review.
- [ ] Replay the same webhook: balance does not change again.
- [ ] Close the payment tab without paying: order shows "Waiting", later expires.
- [ ] `GET /v1/admin/ledger-integrity` reports ok afterwards.

## Not built yet (decide before launch)
- **Chargebacks and refunds** (taking MVC back or banning abusers). Today a refund at the provider does not touch the ledger.
- Receipts by email and provider payouts/accounting reports.
- **Legal and policy:** selling virtual currency to real people has consumer-protection, tax and (for minors) age rules that depend on country. Get advice before enabling real keys. This is not legal advice.
- **Economy:** every top-up creates money. Re-read `docs/ECONOMY_TUNING.md` so prices and rents stay balanced when players can buy MVC.

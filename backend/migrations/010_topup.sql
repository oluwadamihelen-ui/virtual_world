-- Wallet top-ups: a player buys a pack of MVC with real money (Paystack, Flutterwave, Korapay) or by manual bank transfer approved by an admin.
-- The ledger is only touched when an order becomes 'paid', exactly once (ledger idempotency key topup:<order id>).
CREATE TABLE topup_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  uuid NOT NULL REFERENCES characters(id),
  account_id    uuid NOT NULL REFERENCES accounts(id),
  provider      text NOT NULL CHECK (provider IN ('manual','paystack','flutterwave','korapay')),
  pack_id       text NOT NULL,
  mvc           bigint NOT NULL CHECK (mvc > 0),
  currency      text NOT NULL CHECK (currency IN ('NGN','USD')),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),          -- kobo or cents
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','review','paid','failed','cancelled','rejected')),
  reference     text NOT NULL UNIQUE,                               -- our reference, sent to the provider / quoted in the bank transfer
  provider_ref  text,                                               -- the provider's own transaction id
  checkout_url  text,
  sender_name   text,
  note          text,
  decided_by    uuid,                                               -- admin account that approved or rejected a manual order
  created_at    timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz
);
CREATE INDEX topup_orders_char ON topup_orders (character_id, created_at DESC);
CREATE INDEX topup_orders_status ON topup_orders (status, created_at);

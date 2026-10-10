-- Join tickets (single-use), muting, blocking, achievements, player businesses.

CREATE TABLE join_tickets_used (
  jti          text PRIMARY KEY,
  character_id uuid NOT NULL REFERENCES characters(id),
  used_at      timestamptz NOT NULL
);

ALTER TABLE accounts ADD COLUMN muted_until timestamptz;

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES characters(id),
  blocked_id uuid NOT NULL REFERENCES characters(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE achievements (
  character_id   uuid NOT NULL REFERENCES characters(id),
  achievement_id text NOT NULL,
  earned_at      timestamptz NOT NULL,
  PRIMARY KEY (character_id, achievement_id)
);

CREATE TABLE premises (
  id          text PRIMARY KEY,
  district    text NOT NULL,
  name        text NOT NULL,
  setup_cost  bigint NOT NULL CHECK (setup_cost >= 0)
);

CREATE TABLE businesses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_character_id uuid NOT NULL REFERENCES characters(id),
  premises_id        text NOT NULL REFERENCES premises(id),
  type               text NOT NULL,
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at         timestamptz NOT NULL,
  closed_at          timestamptz
);
-- Exclusive premises: only one open business per premises (race-proof).
CREATE UNIQUE INDEX businesses_one_open_per_premises ON businesses (premises_id) WHERE status = 'open';
CREATE INDEX businesses_owner_idx ON businesses (owner_character_id);

CREATE TABLE business_stock (
  business_id uuid NOT NULL REFERENCES businesses(id),
  item_id     text NOT NULL,
  quantity    integer NOT NULL CHECK (quantity >= 0),
  price       bigint NOT NULL CHECK (price > 0),
  PRIMARY KEY (business_id, item_id)
);

CREATE TABLE business_sales (
  id           bigserial PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses(id),
  item_id      text NOT NULL,
  quantity     integer NOT NULL,
  unit_price   bigint NOT NULL,
  buyer_type   text NOT NULL CHECK (buyer_type IN ('npc','player')),
  buyer_character_id uuid REFERENCES characters(id),
  tx_id        uuid NOT NULL REFERENCES ledger_transactions(id),
  created_at   timestamptz NOT NULL
);
CREATE INDEX business_sales_biz_idx ON business_sales (business_id, created_at DESC);

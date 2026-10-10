-- MVW initial schema. Authoritative persistent state lives here.
-- Money is stored as integer MVC (bigint). No floating point anywhere.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Identity ----------
CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'player' CHECK (role IN ('player','moderator','admin')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  suspended_until timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX accounts_email_key ON accounts (lower(email));

CREATE TABLE characters (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id),
  display_name     text NOT NULL,
  display_name_key text NOT NULL,             -- normalized form used for uniqueness
  appearance       jsonb NOT NULL,
  district         text NOT NULL DEFAULT 'residential',
  pos_x            double precision NOT NULL DEFAULT 0,
  pos_y            double precision NOT NULL DEFAULT 0,
  pos_z            double precision NOT NULL DEFAULT 0,
  reputation       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (display_name_key)
);
CREATE INDEX characters_account_idx ON characters (account_id);

-- ---------- Economy: double-entry ledger ----------
CREATE TABLE ledger_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text NOT NULL CHECK (kind IN ('player','business','system')),
  owner_ref      text NOT NULL,
  allow_negative boolean NOT NULL DEFAULT false,
  balance        bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, owner_ref),
  CONSTRAINT balance_non_negative CHECK (allow_negative OR balance >= 0)
);

CREATE TABLE ledger_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL,
  status           text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','reversed')),
  idempotency_key  text NOT NULL UNIQUE,
  request_hash     text NOT NULL,
  actor_character_id uuid REFERENCES characters(id),
  reference_type   text,
  reference_id     text,
  amount           bigint NOT NULL CHECK (amount >= 0),
  response         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_tx_actor_idx ON ledger_transactions (actor_character_id, created_at DESC);

CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  tx_id         uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id    uuid NOT NULL REFERENCES ledger_accounts(id),
  delta         bigint NOT NULL,
  balance_after bigint NOT NULL
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id DESC);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (tx_id);

-- Entries are append-only.
CREATE FUNCTION ledger_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ledger_entries is append-only'; END $$;
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

-- Every transaction must balance to zero (checked at commit).
CREATE FUNCTION ledger_tx_must_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bigint;
BEGIN
  SELECT COALESCE(SUM(delta),0) INTO s FROM ledger_entries WHERE tx_id = NEW.tx_id;
  IF s <> 0 THEN RAISE EXCEPTION 'ledger transaction % does not balance (sum=%)', NEW.tx_id, s; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_tx_must_balance();

-- ---------- Inventory & shops ----------
CREATE TABLE inventory_items (
  character_id uuid NOT NULL REFERENCES characters(id),
  item_id      text NOT NULL,
  quantity     integer NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (character_id, item_id)
);

CREATE TABLE shop_stock (
  shop_id  text NOT NULL,
  item_id  text NOT NULL,
  price    bigint NOT NULL CHECK (price >= 0),
  quantity integer CHECK (quantity IS NULL OR quantity >= 0),   -- NULL = unlimited (NPC supply)
  PRIMARY KEY (shop_id, item_id)
);

-- ---------- Housing ----------
CREATE TABLE properties (
  id               text PRIMARY KEY,
  type             text NOT NULL,
  district         text NOT NULL,
  name             text NOT NULL,
  rent_per_period  bigint NOT NULL CHECK (rent_per_period >= 0),
  capacity         integer NOT NULL,
  furniture_slots  integer NOT NULL,
  status           text NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','unavailable'))
);

CREATE TABLE tenancies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   text NOT NULL REFERENCES properties(id),
  character_id  uuid NOT NULL REFERENCES characters(id),
  status        text NOT NULL CHECK (status IN ('active','grace','ended')),
  rent_amount   bigint NOT NULL,
  started_at    timestamptz NOT NULL,
  paid_until    timestamptz NOT NULL,
  grace_until   timestamptz,                 -- set when a rent payment fails
  ended_at      timestamptz,
  end_reason    text
);
-- Exclusive property: at most one live tenancy per property (race-proof).
CREATE UNIQUE INDEX tenancies_one_live_per_property ON tenancies (property_id) WHERE status IN ('active','grace');
CREATE INDEX tenancies_character_idx ON tenancies (character_id);

CREATE TABLE rent_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id  uuid NOT NULL REFERENCES tenancies(id),
  tx_id       uuid NOT NULL REFERENCES ledger_transactions(id),
  amount      bigint NOT NULL,
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  paid_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE placed_furniture (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenancy_id   uuid NOT NULL REFERENCES tenancies(id),
  item_id      text NOT NULL,
  pos_x double precision NOT NULL, pos_y double precision NOT NULL, pos_z double precision NOT NULL,
  yaw  double precision NOT NULL DEFAULT 0
);

-- ---------- Employment ----------
CREATE TABLE shifts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id  uuid NOT NULL REFERENCES characters(id),
  job_id        text NOT NULL,
  status        text NOT NULL CHECK (status IN ('in_progress','completed','abandoned')),
  tasks_required integer NOT NULL,
  tasks_done    integer NOT NULL DEFAULT 0,
  started_at    timestamptz NOT NULL,
  last_task_at  timestamptz,
  completed_at  timestamptz,
  wage_paid     bigint
);
-- One in-progress shift per character.
CREATE UNIQUE INDEX shifts_one_active ON shifts (character_id) WHERE status = 'in_progress';
CREATE INDEX shifts_char_idx ON shifts (character_id, started_at DESC);

CREATE TABLE skills (
  character_id uuid NOT NULL REFERENCES characters(id),
  skill_id     text NOT NULL,
  xp           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, skill_id)
);

-- ---------- Moderation & audit ----------
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_account_id uuid,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_character_id uuid NOT NULL REFERENCES characters(id),
  target_character_id   uuid NOT NULL REFERENCES characters(id),
  category    text NOT NULL,
  detail      text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  resolved_by uuid REFERENCES accounts(id),
  resolution  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Player-to-player trading (two-sided offers, versioned confirmation, atomic swap).
CREATE TABLE trades (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_id  uuid NOT NULL REFERENCES characters(id),
  partner_id    uuid NOT NULL REFERENCES characters(id),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled','expired')),
  version       integer NOT NULL DEFAULT 0,          -- bumped on every offer change; confirmations bind to it
  initiator_confirmed_version integer,
  partner_confirmed_version   integer,
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  completed_at  timestamptz,
  tx_id         uuid REFERENCES ledger_transactions(id),
  CHECK (initiator_id <> partner_id)
);
CREATE INDEX trades_initiator_idx ON trades (initiator_id, status);
CREATE INDEX trades_partner_idx ON trades (partner_id, status);

CREATE TABLE trade_offers (
  trade_id     uuid NOT NULL REFERENCES trades(id),
  character_id uuid NOT NULL REFERENCES characters(id),
  mvc          bigint NOT NULL DEFAULT 0 CHECK (mvc >= 0),
  items        jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (trade_id, character_id)
);

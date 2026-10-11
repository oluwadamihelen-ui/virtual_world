-- Phone apps: loans, direct messages, dating, play-money betting. All money moves through the ledger.
CREATE TABLE loans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id),
  principal    bigint NOT NULL CHECK (principal > 0),
  fee          bigint NOT NULL CHECK (fee >= 0),
  repaid       bigint NOT NULL DEFAULT 0 CHECK (repaid >= 0),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid')),
  created_at   timestamptz NOT NULL,
  due_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX loans_one_active ON loans (character_id) WHERE status = 'active';

CREATE TABLE direct_messages (
  id         bigserial PRIMARY KEY,
  from_id    uuid NOT NULL REFERENCES characters(id),
  to_id      uuid NOT NULL REFERENCES characters(id),
  body       text NOT NULL,
  created_at timestamptz NOT NULL,
  read_at    timestamptz
);
CREATE INDEX dm_to_idx ON direct_messages (to_id, created_at DESC);
CREATE INDEX dm_pair_idx ON direct_messages (LEAST(from_id,to_id), GREATEST(from_id,to_id), id);

CREATE TABLE dating_profiles (
  character_id uuid PRIMARY KEY REFERENCES characters(id),
  bio          text NOT NULL,
  looking_for  text NOT NULL,
  interests    text[] NOT NULL DEFAULT '{}',
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL
);
CREATE TABLE dating_swipes (
  from_id    uuid NOT NULL REFERENCES characters(id),
  to_id      uuid NOT NULL REFERENCES characters(id),
  liked      boolean NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE bet_state (
  character_id uuid PRIMARY KEY REFERENCES characters(id),
  break_until  timestamptz
);
CREATE TABLE bets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id),
  round        bigint NOT NULL,
  slot         integer NOT NULL,
  pick         text NOT NULL CHECK (pick IN ('home','draw','away')),
  stake        bigint NOT NULL CHECK (stake > 0),
  odds         numeric(8,2) NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  payout       bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL,
  settled_at   timestamptz,
  UNIQUE (character_id, round, slot)
);
CREATE INDEX bets_char_idx ON bets (character_id, created_at DESC);

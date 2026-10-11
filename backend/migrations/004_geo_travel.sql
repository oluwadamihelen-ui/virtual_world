-- Cities, travel and age. (Age is self-declared; it only drives safe defaults, see docs/SAFETY.md.)
ALTER TABLE characters ADD COLUMN city text NOT NULL DEFAULT 'lagos';
ALTER TABLE characters ADD COLUMN travel_to text;
ALTER TABLE characters ADD COLUMN travel_until timestamptz;
ALTER TABLE accounts   ADD COLUMN birth_date date;

CREATE TABLE trips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id),
  from_city    text NOT NULL,
  to_city      text NOT NULL,
  mode         text NOT NULL,
  distance_km  integer NOT NULL,
  fare         bigint NOT NULL CHECK (fare >= 0),
  tx_id        uuid NOT NULL REFERENCES ledger_transactions(id),
  started_at   timestamptz NOT NULL,
  arrives_at   timestamptz NOT NULL
);
CREATE INDEX trips_char_idx ON trips (character_id, started_at DESC);

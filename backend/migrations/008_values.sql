-- Area property values follow population: every area has a value index (1.00 = launch prices) that moves with residents.
CREATE TABLE area_values (
  area        text PRIMARY KEY,
  idx         numeric(8,4) NOT NULL DEFAULT 1,
  residents   numeric(8,2) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE TABLE area_value_history (
  id        bigserial PRIMARY KEY,
  area      text NOT NULL,
  idx       numeric(8,4) NOT NULL,
  residents numeric(8,2) NOT NULL,
  at        timestamptz NOT NULL
);
CREATE INDEX area_value_history_idx ON area_value_history (area, at DESC);
ALTER TABLE properties ADD COLUMN bought_for bigint;   -- what the current owner has paid in total (purchase + building)

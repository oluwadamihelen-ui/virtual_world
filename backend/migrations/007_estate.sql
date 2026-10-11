-- Real estate: homes, apartments and land can be rented or bought; land can be built on.
ALTER TABLE properties ADD COLUMN lot_id     text;
ALTER TABLE properties ADD COLUMN sale_price bigint CHECK (sale_price IS NULL OR sale_price > 0);
ALTER TABLE properties ADD COLUMN beds       integer NOT NULL DEFAULT 1;
ALTER TABLE properties ADD COLUMN size_sqm   integer NOT NULL DEFAULT 30;
ALTER TABLE properties ADD COLUMN blurb      text NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN build_cost bigint;
ALTER TABLE properties ADD COLUMN built      boolean NOT NULL DEFAULT false;
ALTER TABLE properties ADD COLUMN owner_id   uuid REFERENCES characters(id);
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_status_check;
ALTER TABLE properties ADD CONSTRAINT properties_status_check CHECK (status IN ('available','occupied','owned','unavailable'));
ALTER TABLE tenancies  ADD COLUMN kind text NOT NULL DEFAULT 'rent' CHECK (kind IN ('rent','own'));
CREATE INDEX properties_owner_idx ON properties (owner_id) WHERE owner_id IS NOT NULL;

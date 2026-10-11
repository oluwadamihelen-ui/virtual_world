-- Life apps: health, courses and credentials, cars, insurance.
CREATE TABLE character_health (
  character_id uuid PRIMARY KEY REFERENCES characters(id),
  value        numeric NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE TABLE credentials (
  character_id  uuid NOT NULL REFERENCES characters(id),
  credential_id text NOT NULL,
  earned_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, credential_id)
);
CREATE TABLE course_enrolments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id),
  course_id    text NOT NULL,
  fee          bigint NOT NULL,
  status       text NOT NULL DEFAULT 'studying' CHECK (status IN ('studying','done')),
  started_at   timestamptz NOT NULL,
  ready_at     timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE UNIQUE INDEX one_course_at_a_time ON course_enrolments (character_id) WHERE status = 'studying';
CREATE TABLE cars (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id),
  model_id     text NOT NULL,
  plate        text NOT NULL,
  fuel         numeric NOT NULL,
  condition    numeric NOT NULL DEFAULT 100,
  bought_for   bigint NOT NULL,
  active       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sold_at      timestamptz
);
CREATE INDEX cars_owner ON cars (character_id) WHERE sold_at IS NULL;
CREATE TABLE policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id),
  kind         text NOT NULL CHECK (kind IN ('health','car')),
  plan_id      text NOT NULL,
  car_id       uuid REFERENCES cars(id),
  premium      bigint NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lapsed','cancelled')),
  started_at   timestamptz NOT NULL,
  paid_until   timestamptz NOT NULL
);
CREATE UNIQUE INDEX one_health_policy ON policies (character_id) WHERE kind='health' AND status='active';
CREATE UNIQUE INDEX one_policy_per_car ON policies (car_id) WHERE kind='car' AND status='active';

-- Temperature Logs: one log per pharmacy, per location, per month.
-- setup / rows / calibration hold exactly what the page sends.
-- Each pharmacy is a row in users, so pharmacy_id references users(id).
CREATE TABLE IF NOT EXISTS temperature_logs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_key TEXT        NOT NULL,          -- slug of setup.location
  year         SMALLINT    NOT NULL,
  month        SMALLINT    NOT NULL,          -- 1-12 (the page sends 0-11; add 1 on save)
  setup        JSONB       NOT NULL,          -- month, year, fridges, times, initials, default comments
  rows         JSONB       NOT NULL,          -- 28-31 day entries
  calibration  JSONB       NOT NULL,          -- seven sign-off fields
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pharmacy_id, location_key, year, month)
);

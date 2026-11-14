CREATE TABLE IF NOT EXISTS admin_impersonation_log (
  id              BIGSERIAL PRIMARY KEY,
  admin_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pharmacy_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

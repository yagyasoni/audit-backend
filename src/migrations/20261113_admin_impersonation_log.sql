-- One row each time an admin uses "View as pharmacy" (who, which pharmacy, when).
-- users.id is a UUID, so both references are UUID.
-- The record is kept when an account is deleted later (no cascade): it is an
-- audit trail.
CREATE TABLE IF NOT EXISTS admin_impersonation_log (
  id               BIGSERIAL   PRIMARY KEY,
  admin_id         UUID        NOT NULL,
  pharmacy_user_id UUID        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_impersonation_log_created
  ON admin_impersonation_log (created_at);

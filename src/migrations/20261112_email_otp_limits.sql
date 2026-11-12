-- Email codes (sign-up and admin login): limits on guessing and re-sending.
--   attempts   - wrong tries used on the current code (it stops working at 5)
--   purpose    - 'signup' or 'admin_login', so one kind cannot be used as the other
--   created_at - when the current code was sent (a new one is allowed after 60 seconds)
-- One code per email + purpose at a time, enforced by the unique index.
--
-- Run this BEFORE deploying the backend code that uses these columns:
--   node src/scripts/runSql.js src/migrations/20261112_email_otp_limits.sql
-- Safe to run more than once.
ALTER TABLE email_otps ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE email_otps ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'signup';

ALTER TABLE email_otps ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Codes are valid for 5 minutes, so rows that already expired are dead weight.
DELETE FROM email_otps WHERE expires_at IS NULL OR expires_at < NOW();

-- Keep only the newest code per email + purpose so the unique index can be built.
DELETE FROM email_otps a
 USING email_otps b
 WHERE a.email = b.email
   AND a.purpose = b.purpose
   AND (a.expires_at < b.expires_at
        OR (a.expires_at = b.expires_at AND a.id < b.id));

CREATE UNIQUE INDEX IF NOT EXISTS email_otps_email_purpose_key ON email_otps (email, purpose);

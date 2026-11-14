-- M29: track whether the publish notification email was already sent.
-- Prevents re-sending on every Draft→Published edit.
ALTER TABLE publishing_posts
  ADD COLUMN IF NOT EXISTS notification_sent_at TIMESTAMPTZ;

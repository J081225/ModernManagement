-- LP section 10 / ruling R6: Property Management goes "under
-- construction" and PM SIGNUP is replaced by a waitlist. This is that
-- waitlist. Append-only; idempotent per email (case-insensitive) so
-- repeat submissions never error and never duplicate.
CREATE TABLE IF NOT EXISTS pm_waitlist (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_waitlist_email ON pm_waitlist ((LOWER(email)));

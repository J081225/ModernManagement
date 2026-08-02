-- AD5: verification-before-power for contact channels (Law 2 extended).
-- Additive only.
--
-- Verified state: a contact value is trusted with alerts only when its
-- verified_at is set. Changing the value clears it (in code, same
-- UPDATE — no window where a new value inherits old trust).
--
-- GRANDFATHERING, ruled explicitly: every EXISTING non-null value is
-- marked verified at migration time — no current account loses alert
-- delivery because this law shipped. New/changed values after this
-- migration start unverified and are treated as absent by every sender
-- (including the emergency path — ruling: law wins, the email fallback
-- carries emergencies).

ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_phone_verified_at TIMESTAMPTZ;

UPDATE users SET notification_email_verified_at = NOW()
 WHERE notification_email IS NOT NULL AND notification_email <> ''
   AND notification_email_verified_at IS NULL;

UPDATE users SET alert_phone_verified_at = NOW()
 WHERE alert_phone IS NOT NULL AND alert_phone <> ''
   AND alert_phone_verified_at IS NULL;

-- One active verification per (user_id, field) — a new request replaces
-- the old row. code_hash stores sha256 of the mailed token / spoken
-- code; the raw value is never at rest (LAW 4, the AD3 pattern).
-- attempts counts wrong guesses for the spoken phone code (5 burns it).
CREATE TABLE IF NOT EXISTS contact_verifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field       TEXT NOT NULL CHECK (field IN ('notification_email', 'alert_phone')),
  target_value TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_verifications_user_field_uq
  ON contact_verifications (user_id, field);

CREATE INDEX IF NOT EXISTS contact_verifications_expires_idx
  ON contact_verifications (expires_at);

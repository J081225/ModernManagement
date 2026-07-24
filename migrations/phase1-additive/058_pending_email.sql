-- AD3 c2: email change with verification.
-- Additive only. pending_email_token_hash stores SHA-256(raw token) —
-- LAW 4: tokens are ammunition, hashed at rest. (The legacy
-- password_reset_tokens table stores raw tokens as its PRIMARY KEY —
-- weaker than this floor; flagged in the AD3 look-first, upgrade
-- scheduled as a reported follow-up, not smuggled in here.)
-- Single-use: verification clears all three columns, so a second
-- presentation of the same token matches nothing. Expiry: 1 hour via
-- pending_email_expires, checked at verify time and swept by the CP4
-- expiry sweep (piggyback, no new timer).
-- users.email — the reset key — is untouched until the swap (LAW 2).

ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email_expires TIMESTAMPTZ;

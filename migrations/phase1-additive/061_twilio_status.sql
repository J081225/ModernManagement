-- SP3: the phone-provisioning axis, modeled (ruling: option d).
-- connect_status stays the Stripe/card axis, untouched. twilio_status
-- is the Twilio axis, with the STRUCTURAL invariant: a workspace may
-- claim a working line if and only if it has a number. The ws12-class
-- state — "active"-looking with no phone — becomes unwritable at the
-- database, while no truthful Stripe Connect write can ever fail
-- (the constraint touches only the Twilio columns).
--
-- States: not_started (never attempted) | provisioning (SP4's async
-- in-flight, legal and honest) | active (number attached) | failed
-- (attempts exhausted; needs visibility). last_error + attempts are
-- SP4's retry bookkeeping, inert until then.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_last_error TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_attempts INTEGER NOT NULL DEFAULT 0;

-- Backfill BEFORE the constraints so the invariant holds at birth:
-- has a number -> 'active'; no number -> stays 'not_started'.
UPDATE workspaces SET twilio_status = 'active'
 WHERE twilio_phone_number IS NOT NULL AND twilio_phone_number <> ''
   AND twilio_status = 'not_started';

-- Guard rail: an empty-string phone is not a number. Kept as its own
-- constraint so the ruled invariant below can use the ruled formula
-- verbatim without an '' loophole.
ALTER TABLE workspaces ADD CONSTRAINT workspaces_twilio_phone_not_empty
  CHECK (twilio_phone_number IS NULL OR twilio_phone_number <> '');

ALTER TABLE workspaces ADD CONSTRAINT workspaces_twilio_status_valid
  CHECK (twilio_status IN ('not_started', 'provisioning', 'active', 'failed'));

-- THE invariant, as ruled: active if-and-only-if a number is attached.
ALTER TABLE workspaces ADD CONSTRAINT workspaces_twilio_active_iff_phone
  CHECK ((twilio_status = 'active') = (twilio_phone_number IS NOT NULL));

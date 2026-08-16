-- A2P consent surface: durable record of end-user SMS opt-in.
--
-- Danny (Twilio) requires visual + record proof that consent is captured
-- with an affirmative, unchecked-by-default checkbox before any number is
-- messaged. The public opt-in form (/sms-opt-in) and the owner
-- contact-intake both gate on that checkbox; THIS table is where the
-- public form's opt-ins are written so consent is provable after the fact
-- (who consented, to what wording, when, from where).
--
-- Deliberately standalone: no FK to workspaces (the form is reachable
-- before a number is ever attached to a workspace, and a business may
-- link customers to it with ?business=<name>). It is an append-only
-- consent ledger, never summed into anything financial.
CREATE TABLE IF NOT EXISTS sms_consents (
  id             SERIAL PRIMARY KEY,
  business_name  TEXT,
  full_name      TEXT NOT NULL,
  phone          TEXT NOT NULL,
  consent_text   TEXT NOT NULL,     -- the exact wording the user agreed to
  source         TEXT NOT NULL DEFAULT 'public_opt_in_form',
  ip             TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_consents_phone ON sms_consents (phone);
CREATE INDEX IF NOT EXISTS idx_sms_consents_created ON sms_consents (created_at);

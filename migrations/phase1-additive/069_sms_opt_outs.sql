-- A2P/TCPA opt-out state, per workspace + per number. A STOP from a
-- customer opts them out of THAT workspace's messages (each workspace is
-- a distinct business, so opt-out is scoped per business, not globally);
-- START/UNSTOP opts back in. Enforced at OUR send layer
-- (lib/sms-consent.isOptedOut), independent of Twilio's carrier-level
-- Advanced Opt-Out — honoring STOP is TCPA strict liability, a law.
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  id            SERIAL PRIMARY KEY,
  workspace_id  INTEGER NOT NULL,
  phone         TEXT NOT NULL,
  opted_out     BOOLEAN NOT NULL DEFAULT true,
  opted_out_at  TIMESTAMPTZ,
  opted_in_at   TIMESTAMPTZ,
  last_keyword  TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One consent row per (workspace, number) — the upsert anchor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_opt_outs_ws_phone
  ON sms_opt_outs (workspace_id, phone);

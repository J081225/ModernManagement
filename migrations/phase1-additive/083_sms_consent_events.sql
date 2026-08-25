-- 083: CONSENT-EVENTS — the append-only consent evidence layer.
-- sms_opt_outs remains the fast send-gate STATE table, untouched;
-- this table is the EVENT history. Consent history is liability
-- history: never purged, INSERT-only by code law (no UPDATE or
-- DELETE path exists anywhere in code — the no-detach precedent).
-- Announced before apply, 2026-08-25.
CREATE TABLE IF NOT EXISTS sms_consent_events (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  INTEGER NOT NULL,
  phone         TEXT NOT NULL,
  keyword       TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('opt_out', 'opt_in', 'help')),
  message_sid   TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_consent_events_ws_phone
  ON sms_consent_events (workspace_id, phone, received_at);

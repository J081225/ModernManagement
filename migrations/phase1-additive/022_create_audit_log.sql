-- =====================================================================
-- Phase 1 — 022_create_audit_log.sql
-- =====================================================================
-- Purpose:
--   Create a generic `audit_log` table for safety-critical and
--   compliance-relevant user actions. Designed to be a single shared
--   table for many event types rather than a purpose-specific
--   `consent_log` / `permission_log` / etc., so future safety
--   features can reuse it without new migrations.
--
--   First consumers (AI Auto-Reply Safety Layer — Layer 3, sub-step D):
--     event_type = 'auto_reply_consent_granted'  → user toggled
--                                                  auto-reply ON
--                                                  through the consent
--                                                  modal (with the
--                                                  acknowledgement
--                                                  checkbox checked).
--     event_type = 'auto_reply_consent_revoked'  → user toggled
--                                                  auto-reply OFF.
--
--   Future consumers (not in scope today, listed for reference):
--     - keyword-list edits (if we ever expose them)
--     - admin-impersonation events
--     - data-export requests
--     - bulk-message sends
--     - account deletions
--
-- Schema:
--   id          SERIAL PRIMARY KEY
--   user_id     INTEGER NOT NULL REFERENCES users(id)
--                 — the user whose action is being logged. NOT NULL
--                 because every audit event must be attributable to
--                 someone; system events get attributed to whichever
--                 admin user triggered them.
--   event_type  TEXT NOT NULL
--                 — free-form string. App-layer convention is
--                 snake_case verbs ("auto_reply_consent_granted").
--                 Not an enum — adding new event types should not
--                 require a schema migration.
--   details     JSONB DEFAULT '{}'::jsonb
--                 — event-specific payload. Empty object on
--                 revocations and on most consent grants. Future
--                 consumers can store relevant context (e.g.,
--                 keyword diffs, exported file size, etc.).
--   ip          TEXT
--                 — captured from req.ip in Express. Nullable
--                 because some events (e.g., system-triggered) won't
--                 have an originating request. App must remember to
--                 set('trust proxy') for Render's reverse proxy or
--                 this captures the proxy IP, not the client.
--   created_at  TIMESTAMPTZ DEFAULT NOW()
--                 — wall-clock UTC; canonical event time.
--
-- Index:
--   (user_id, event_type, created_at DESC)
--   — supports the most common future audit query: "what events of
--   type X did user Y trigger, most recent first?" Cheap on this
--   table since it's append-only.
--
-- Scope note:
--   The `phase1-additive` directory was originally inventory-scoped.
--   020 / 021 / 022 extend the numbering on feat/inventory-ui as
--   auto-reply safety work, not inventory. See 020 header for the
--   full caveat.
--
-- Depends on:  001 / pre-Phase-1 users table (FK target).
-- Enables:     Layer 3 consent-event recording (sub-step D) via
--              POST /api/automation/consent (grant) and the
--              existing PUT /api/automation handler (revoke).
--
-- Idempotent:  Yes. CREATE TABLE IF NOT EXISTS + CREATE INDEX IF
--              NOT EXISTS. Re-runs are no-ops.
-- Reversible:  DROP INDEX IF EXISTS audit_log_user_event_time_idx;
--              DROP TABLE IF EXISTS audit_log;
--              CAVEAT: drops the entire audit history. For a real
--              prod environment this is a data-loss operation —
--              export to JSON / CSV first if compliance requires
--              retention.
-- =====================================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  details    JSONB DEFAULT '{}'::jsonb,
  ip         TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_user_event_time_idx
  ON audit_log (user_id, event_type, created_at DESC);

DO $$
DECLARE
  v_table_present  INTEGER;
  v_index_present  INTEGER;
  v_column_count   INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_table_present
  FROM information_schema.tables
  WHERE table_name = 'audit_log';

  SELECT COUNT(*) INTO v_index_present
  FROM pg_indexes
  WHERE indexname = 'audit_log_user_event_time_idx';

  SELECT COUNT(*) INTO v_column_count
  FROM information_schema.columns
  WHERE table_name = 'audit_log';

  RAISE NOTICE '022: audit_log table present (% of 1), index present (% of 1), column count = % (expected 6).',
    v_table_present, v_index_present, v_column_count;
END $$;

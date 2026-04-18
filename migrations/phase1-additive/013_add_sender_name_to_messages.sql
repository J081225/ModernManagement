-- =====================================================================
-- Phase 1 — 013_add_sender_name_to_messages.sql
-- =====================================================================
-- Purpose:
--   Rename the semantically-inconsistent `messages.resident` column to
--   `sender_name`. Per Decision §9.5, the rename is split across all
--   three phases:
--     • Phase 1 (this file): add `sender_name`, backfill from `resident`.
--     • Phase 2: routes dual-write BOTH columns; responses keep exposing
--       `resident` as an aliased field for frontend compat.
--     • Phase 3 (004_drop_resident_from_messages.sql): guard + drop
--       `resident` once every row has sender_name == resident.
--
-- Depends on: existing `messages` table (messages.resident is a TEXT
--             column populated by /api/messages, /api/email/incoming,
--             /api/sms/incoming, and the initDB seed path).
-- Enables:    Phase 2 dual-write for messages.
--
-- Idempotent: Yes.
--   • Column add uses IF NOT EXISTS.
--   • Backfill guarded by `sender_name = '' OR sender_name IS NULL`
--     so re-runs cannot overwrite a user-set value (and cannot
--     overwrite Phase-2 dual-writes once they start landing).
--
-- Reversible: ALTER TABLE messages DROP COLUMN IF EXISTS sender_name;
--             (Safe: Phase 1 does not modify existing `resident` data.)
-- =====================================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name TEXT DEFAULT '';

DO $$
DECLARE
  v_updated INTEGER := 0;
BEGIN
  UPDATE messages
     SET sender_name = resident
   WHERE sender_name = '' OR sender_name IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE '013: backfilled sender_name from resident for % row(s)', v_updated;
END $$;

CREATE INDEX IF NOT EXISTS messages_sender_name_idx ON messages(sender_name);

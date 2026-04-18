-- =====================================================================
-- Phase 3 — 004_drop_resident_from_messages.sql
-- =====================================================================
-- Purpose:
--   Drop the legacy `messages.resident` column once every row has
--   been kept in sync with `sender_name` through the Phase 2 dual-write
--   window. Per Decision §9.5, this is the final step of the
--   messages.resident → sender_name rename.
--
-- Depends on:
--   • Phase 1: 013 (messages.sender_name added and backfilled)
--   • Phase 2 dual-write for messages has been in production and
--     dropped from the codebase at least one commit before this runs.
--   • Every /api/messages, /api/email/incoming, /api/sms/incoming,
--     /api/broadcast (and anywhere else that writes to `messages`)
--     sets BOTH `resident` and `sender_name` during Phase 2.
--
-- Guard:
--   Counts rows where `resident IS DISTINCT FROM sender_name`. If any
--   row shows drift, RAISES EXCEPTION and aborts the drop. This is
--   intentional: a mismatch here means the dual-write had a bug and
--   data would be lost.
--
-- Idempotent: Yes. Short-circuits if the column is already gone.
-- Reversible: Only via Neon branch snapshot `pre-schema-gen-phase3-*`.
--             The `sender_name` column retains all the data.
-- =====================================================================

DO $$
DECLARE
  drift_count INTEGER;
BEGIN
  -- Short-circuit if already dropped.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='messages' AND column_name='resident'
  ) THEN
    RAISE NOTICE '004: messages.resident already dropped. Skipping.';
    RETURN;
  END IF;

  -- Verify every row has resident == sender_name. IS DISTINCT FROM
  -- treats NULL vs NULL as equal (so empty-string/NULL pairs don't
  -- fail the guard), and treats NULL vs 'x' as NOT equal.
  SELECT COUNT(*) INTO drift_count
  FROM messages
  WHERE resident IS DISTINCT FROM sender_name;

  RAISE NOTICE 'Phase3 guard 004: messages rows with resident<>sender_name = %', drift_count;

  IF drift_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % message row(s) have resident<>sender_name. Refusing to drop. Investigate dual-write, backfill, or re-run 013.', drift_count;
  END IF;

  ALTER TABLE messages DROP COLUMN resident;
  RAISE NOTICE 'Dropped column messages.resident.';
END $$;

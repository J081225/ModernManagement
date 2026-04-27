-- =====================================================================
-- Phase 1 — 021_add_messages_emergency_flagged.sql
-- =====================================================================
-- Purpose:
--   Add `emergency_flagged BOOLEAN DEFAULT FALSE` to `messages` to
--   mark incoming tenant messages that contain emergency keywords
--   (fire, gas leak, threats, injuries, etc.). Flagged messages are
--   held from AI auto-reply for manual review, pinned to the top of
--   the inbox, and trigger an SMS alert to the workspace owner.
--
--   Set to TRUE by the AI Auto-Reply Safety Layer (Layer 1)
--   detection logic in /api/sms/incoming, /api/email/incoming, and
--   /api/sms/transcription (sub-step B). Read by the inbox UI to
--   render an EMERGENCY badge + pin-to-top sort (sub-step C).
--
--   The flag is also the basis for the defensive short-circuit in
--   /api/sms/transcription: if the placeholder-text processing
--   already flagged this row, the transcript-completion handler
--   skips re-detection (no double-alert, no second auto-reply
--   attempt). Full voicemail double-fire fix is a separate task.
--
-- Scope note:
--   The `phase1-additive` directory was originally scoped to
--   Inventory work. 020 / 021 / 022 extend the numbering on
--   feat/inventory-ui but are auto-reply safety, not inventory.
--   See 020 header for full context.
--
-- Depends on:  001 / pre-Phase-1 messages table.
-- Enables:     Layer 1 detection write path (sub-step B); inbox
--              EMERGENCY badge and top-pin sort (sub-step C).
--
-- Idempotent:  Yes. ADD COLUMN IF NOT EXISTS. No backfill needed —
--              the column defaults to FALSE for every existing row.
--              Historical messages stay un-flagged (they predate the
--              feature; no retroactive emergency detection runs here).
-- Reversible:  ALTER TABLE messages DROP COLUMN IF EXISTS
--              emergency_flagged;
--              Safe in the schema sense; note that re-creating after
--              a drop would lose the historical flag values (the
--              detection function could re-derive them on demand by
--              re-scanning message text, but that is a manual
--              restoration step, not automatic).
-- =====================================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS emergency_flagged BOOLEAN DEFAULT FALSE;

DO $$
DECLARE
  v_column_present INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_column_present
  FROM information_schema.columns
  WHERE table_name = 'messages' AND column_name = 'emergency_flagged';
  RAISE NOTICE '021: messages.emergency_flagged column present (% of 1).', v_column_present;
END $$;

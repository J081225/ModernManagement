-- =====================================================================
-- Phase 1 — 007b_add_is_important_column.sql
-- =====================================================================
-- Purpose:
--   Split the legacy `type = 'important'` concept out of contact_type into
--   a dedicated boolean flag. Per Decision §9.4:
--     • New column `contacts.is_important BOOLEAN DEFAULT false`.
--     • Rows with the legacy `type = 'important'` are backfilled to
--       is_important = true.
--     • Those rows' `contact_type` is rewritten to 'other' so the
--       contact_type domain no longer carries the 'important' value.
--
-- Why split:
--   'important' is orthogonal to the tenant/vendor/other classification.
--   A vendor can also be important; a tenant can also be important. Only
--   a boolean captures this cleanly. See plan §9.4.
--
-- Depends on: 007_add_contact_type_column.sql (adds contact_type and
--             backfills it — including 'important' rows, which arrive
--             here with contact_type='important').
-- Enables:    frontend work to render a star/flag on important contacts
--             without relying on a magic type value.
--
-- Idempotent: Yes.
--   • `is_important` backfill guarded by `is_important = false` so
--     re-runs never overwrite a user-set true value back to false.
--   • `contact_type` rewrite guarded on `contact_type IN ('important', NULL)`
--     so re-runs don't touch rows a user has since relabeled.
--
-- Reversible:
--   ALTER TABLE contacts DROP COLUMN IF EXISTS is_important;
--   (contact_type values previously rewritten to 'other' cannot be
--   distinguished post-hoc from genuine 'other' rows — use the
--   migration_audit snapshot from 007 if reconstruction is needed.)
-- =====================================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_important BOOLEAN DEFAULT false;

-- Flag rows that came from legacy type='important'. Guard keeps the
-- re-run safe: once a user manually un-flags a contact (is_important
-- set back to false), a re-run must NOT re-flag it.
DO $$
DECLARE
  v_flagged_count INTEGER := 0;
  v_rewrite_count INTEGER := 0;
BEGIN
  UPDATE contacts
     SET is_important = true
   WHERE type = 'important'
     AND is_important = false;
  GET DIAGNOSTICS v_flagged_count = ROW_COUNT;

  -- Rewrite contact_type for those same legacy rows so 'important' is
  -- no longer a live value in the contact_type domain. We match either
  -- contact_type = 'important' (arrived from 007's passthrough) or NULL
  -- (if 007 has not yet been re-run against this row for some reason).
  UPDATE contacts
     SET contact_type = 'other'
   WHERE type = 'important'
     AND (contact_type = 'important' OR contact_type IS NULL);
  GET DIAGNOSTICS v_rewrite_count = ROW_COUNT;

  RAISE NOTICE '007b: flagged % contacts as is_important, rewrote % contact_type values to ''other''',
               v_flagged_count, v_rewrite_count;
END $$;

CREATE INDEX IF NOT EXISTS contacts_is_important_idx
  ON contacts(is_important) WHERE is_important = true;

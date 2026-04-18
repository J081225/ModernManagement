-- =====================================================================
-- Phase 1 — 007_add_contact_type_column.sql
-- =====================================================================
-- Purpose:
--   Add `contact_type` as a new column on `contacts`, populated from the
--   existing `type` column. During Phase 2, application code dual-writes
--   both columns. In Phase 3 the user decides whether to drop `type`.
--
--   Per Decision §9.3 (Option A), stored values become vertical-neutral
--   primitives. Display labels come from `vertical_configs`.
--
-- Depends on: existing `contacts` table.
-- Enables:    /api/contacts/* cutover in Phase 2, 007b (is_important).
--
-- Value remap (per §9.3 Decision A):
--   type = 'resident'           → contact_type = 'tenant'
--   type IS NULL OR type = ''   → contact_type = 'tenant'
--   type = 'vendor'             → contact_type = 'vendor'  (unchanged)
--   Any other existing value    → contact_type = type      (unchanged)
--
-- NOTE: `type = 'important'` is NOT handled here. Per Decision §9.4, the
--       'important' concept splits out into a separate boolean column
--       `contacts.is_important`. See 007b_add_is_important_column.sql,
--       which must run AFTER this script so it can rewrite contact_type
--       for those rows.
--
-- Audit: Before the UPDATE runs, we snapshot the pre-migration
--        distribution of `contacts.type` into a `migration_audit` table.
--        Row counts for each mapping are emitted via RAISE NOTICE.
--
-- Idempotent: Yes. UPDATE only fills NULL values; the audit insert
--             carries a `migration_key` that de-duplicates.
-- Reversible: ALTER TABLE contacts DROP COLUMN IF EXISTS contact_type;
--             DELETE FROM migration_audit WHERE migration_key LIKE '007_%';
-- =====================================================================

-- Ensure the audit log table exists (shared across Phase 1 scripts).
CREATE TABLE IF NOT EXISTS migration_audit (
  id             SERIAL PRIMARY KEY,
  migration_key  TEXT NOT NULL,
  snapshot_label TEXT NOT NULL,
  snapshot       JSONB NOT NULL,
  row_count      INTEGER,
  captured_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS migration_audit_migration_key_idx
  ON migration_audit(migration_key);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS contact_type TEXT;

-- Snapshot pre-migration distribution once. We guard on migration_key
-- so re-running the script does not pile up duplicate audit rows.
DO $$
DECLARE
  v_total        INTEGER;
  v_snapshot     JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM migration_audit WHERE migration_key = '007_contact_type_pre'
  ) THEN
    SELECT COUNT(*) INTO v_total FROM contacts;

    SELECT COALESCE(jsonb_object_agg(type_key, type_count), '{}'::jsonb)
      INTO v_snapshot
    FROM (
      SELECT COALESCE(NULLIF(type, ''), '__null_or_empty__') AS type_key,
             COUNT(*) AS type_count
      FROM contacts
      GROUP BY COALESCE(NULLIF(type, ''), '__null_or_empty__')
    ) s;

    INSERT INTO migration_audit (migration_key, snapshot_label, snapshot, row_count)
    VALUES ('007_contact_type_pre', 'contacts.type distribution pre-migration',
            v_snapshot, v_total);

    RAISE NOTICE 'Audit 007: pre-migration contacts.type distribution captured (total=%)', v_total;
  ELSE
    RAISE NOTICE 'Audit 007: pre-migration snapshot already exists; not overwriting.';
  END IF;
END $$;

-- Backfill contact_type with variable captures so we can log row counts.
DO $$
DECLARE
  v_resident_count INTEGER := 0;
  v_null_count     INTEGER := 0;
  v_vendor_count   INTEGER := 0;
  v_other_count    INTEGER := 0;
BEGIN
  -- resident → tenant
  UPDATE contacts
     SET contact_type = 'tenant'
   WHERE contact_type IS NULL
     AND type = 'resident';
  GET DIAGNOSTICS v_resident_count = ROW_COUNT;

  -- NULL or '' → tenant (default)
  UPDATE contacts
     SET contact_type = 'tenant'
   WHERE contact_type IS NULL
     AND (type IS NULL OR type = '');
  GET DIAGNOSTICS v_null_count = ROW_COUNT;

  -- vendor stays vendor
  UPDATE contacts
     SET contact_type = 'vendor'
   WHERE contact_type IS NULL
     AND type = 'vendor';
  GET DIAGNOSTICS v_vendor_count = ROW_COUNT;

  -- Any remaining non-null, non-empty, non-{resident,vendor} value: pass
  -- through unchanged. 'important' rows are intentionally included here
  -- so 007b can find them and set contact_type to 'other'.
  UPDATE contacts
     SET contact_type = type
   WHERE contact_type IS NULL
     AND type IS NOT NULL
     AND type <> '';
  GET DIAGNOSTICS v_other_count = ROW_COUNT;

  RAISE NOTICE 'Migrated % resident→tenant, % null→tenant, % vendor unchanged, % other passthrough',
               v_resident_count, v_null_count, v_vendor_count, v_other_count;
END $$;

CREATE INDEX IF NOT EXISTS contacts_contact_type_idx ON contacts(contact_type);

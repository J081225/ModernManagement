-- =====================================================================
-- Phase 3 — 003_remove_lease_columns_from_contacts.sql
-- =====================================================================
-- Purpose:
--   Drop lease_start, lease_end, monthly_rent from contacts now that
--   agreements is authoritative. Also optionally drop the old `type`
--   column if the user has decided to unify on `contact_type` (see
--   plan Open Questions §9.3).
--
-- Depends on: All /api/contacts/* and /api/leases/* routes have been
--             cut over to read from `agreements` (Phase 2 sessions 2.1
--             and 2.2) and no longer reference contacts.lease_*.
--
-- Guard: Aborts if agreements has fewer 'lease' rows than contacts have
-- non-empty lease_end strings (meaning backfill missed rows).
-- =====================================================================

DO $$
DECLARE
  contacts_with_lease INTEGER;
  lease_agreements    INTEGER;
BEGIN
  -- Short-circuit if already dropped.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='contacts' AND column_name='lease_end'
  ) THEN
    RAISE NOTICE 'Lease columns already dropped from contacts. Skipping.';
    RETURN;
  END IF;

  EXECUTE 'SELECT COUNT(*) FROM contacts WHERE lease_end IS NOT NULL AND lease_end != '''''
    INTO contacts_with_lease;

  SELECT COUNT(*) INTO lease_agreements
  FROM agreements WHERE agreement_type = 'lease';

  RAISE NOTICE 'Phase3 guard 003: contacts_with_lease=% lease_agreements=%',
               contacts_with_lease, lease_agreements;

  IF lease_agreements < contacts_with_lease THEN
    RAISE EXCEPTION 'ABORT: agreements has % lease rows but contacts still has % with lease data. Refusing to drop columns.',
                    lease_agreements, contacts_with_lease;
  END IF;

  ALTER TABLE contacts DROP COLUMN IF EXISTS lease_start;
  ALTER TABLE contacts DROP COLUMN IF EXISTS lease_end;
  ALTER TABLE contacts DROP COLUMN IF EXISTS monthly_rent;

  RAISE NOTICE 'Dropped lease_start, lease_end, monthly_rent from contacts.';
END $$;

-- The old `type` column is NOT dropped here. That decision is held for
-- the user — see docs/schema-migration-plan.md §9.3 and §9.4. When
-- ready, apply the following as a separate script:
--
--   ALTER TABLE contacts DROP COLUMN IF EXISTS type;

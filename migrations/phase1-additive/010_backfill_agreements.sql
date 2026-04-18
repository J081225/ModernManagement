-- =====================================================================
-- Phase 1 — 010_backfill_agreements.sql
-- =====================================================================
-- Purpose:
--   For every contact that has a non-empty lease_end, create an
--   agreement row capturing start_date, end_date, and monthly_amount.
--   contact_id references the source contact so Phase 2 code can join.
--
-- Depends on: 003 (agreements table), 008 (workspaces backfilled),
--             009 (entities backfilled), existing contacts table with
--             lease_start/lease_end/monthly_rent columns.
-- Enables:    /api/leases/* cutover in Phase 2.
--
-- Backfill filter: only contacts WHERE lease_end IS NOT NULL AND
--                  lease_end != ''. Rows with empty lease data stay
--                  in contacts only.
--
-- Idempotent: Yes. Uses partial unique index on
--             (contact_id, agreement_type) where agreement_type='lease'.
-- Reversible: DELETE FROM agreements WHERE agreement_type='lease' ...
-- =====================================================================

-- Prevent duplicate lease agreements for the same contact on re-run.
CREATE UNIQUE INDEX IF NOT EXISTS agreements_one_lease_per_contact_uq
  ON agreements(contact_id)
  WHERE agreement_type = 'lease';

INSERT INTO agreements (
  workspace_id,
  entity_id,
  contact_id,
  agreement_type,
  start_date,
  end_date,
  monthly_amount,
  status
)
SELECT
  w.id           AS workspace_id,
  e.id           AS entity_id,
  c.id           AS contact_id,
  'lease'        AS agreement_type,
  -- Lenient date parsing: empty string → NULL, anything else cast.
  -- If a string isn't a valid date, this will error — intentional so
  -- we see malformed data and fix it rather than silently dropping it.
  NULLIF(c.lease_start, '')::date AS start_date,
  NULLIF(c.lease_end,   '')::date AS end_date,
  COALESCE(c.monthly_rent, 0)     AS monthly_amount,
  CASE
    WHEN NULLIF(c.lease_end, '')::date < CURRENT_DATE
      THEN 'expired'
    WHEN NULLIF(c.lease_end, '')::date < CURRENT_DATE + INTERVAL '60 days'
      THEN 'expiring'
    ELSE 'active'
  END            AS status
FROM contacts c
JOIN workspaces w ON w.owner_user_id = c.user_id
LEFT JOIN entities e
  ON e.workspace_id = w.id AND e.entity_type = 'property'
WHERE c.lease_end IS NOT NULL
  AND c.lease_end != ''
ON CONFLICT DO NOTHING;

-- Orphan report: contacts with lease fields but no matching workspace
-- (would indicate data integrity issue — user_id points nowhere).
DO $$
DECLARE
  orphan_count INTEGER;
  agr_count    INTEGER;
  src_count    INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM contacts c
  LEFT JOIN workspaces w ON w.owner_user_id = c.user_id
  WHERE c.lease_end IS NOT NULL AND c.lease_end != ''
    AND w.id IS NULL;

  SELECT COUNT(*) INTO src_count
  FROM contacts
  WHERE lease_end IS NOT NULL AND lease_end != '';

  SELECT COUNT(*) INTO agr_count FROM agreements WHERE agreement_type = 'lease';

  RAISE NOTICE 'Backfill 010: contacts_with_lease=% lease_agreements=% orphans=%',
               src_count, agr_count, orphan_count;

  IF orphan_count > 0 THEN
    RAISE WARNING 'Backfill 010: % contact(s) have lease data but no workspace. Re-run 008 or create missing workspaces.', orphan_count;
  END IF;
END $$;

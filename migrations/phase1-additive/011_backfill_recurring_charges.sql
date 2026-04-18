-- =====================================================================
-- Phase 1 — 011_backfill_recurring_charges.sql
-- =====================================================================
-- Purpose:
--   Copy every row from `rent_payments` into `recurring_charges`, setting
--   charge_type='rent' and legacy_id = rent_payments.id.
--
-- Depends on: 005 (recurring_charges table), 008 (workspaces backfilled),
--             existing rent_payments table.
-- Enables:    /api/rent/* cutover in Phase 2.
--
-- Idempotent: Yes. ON CONFLICT (legacy_id) DO NOTHING — guarded by the
--             partial unique index `recurring_charges_legacy_id_uq`
--             created in 005.
--
-- Reversible: DELETE FROM recurring_charges WHERE charge_type='rent'
--             AND legacy_id IS NOT NULL;
-- =====================================================================

INSERT INTO recurring_charges (
  user_id,
  workspace_id,
  contact_id,
  charge_type,
  payer_name,
  unit,
  amount,
  due_date,
  status,
  notes,
  paid_date,
  legacy_id,
  created_at
)
SELECT
  rp.user_id,
  w.id AS workspace_id,
  -- Best-effort contact match by name within the same user_id.
  (SELECT c.id FROM contacts c
     WHERE c.user_id = rp.user_id AND c.name = rp.resident
     LIMIT 1) AS contact_id,
  'rent' AS charge_type,
  rp.resident AS payer_name,
  rp.unit,
  rp.amount,
  NULLIF(rp.due_date, '')::date   AS due_date,
  rp.status,
  rp.notes,
  NULLIF(rp.paid_date, '')::date  AS paid_date,
  rp.id AS legacy_id,
  rp."createdAt" AS created_at
FROM rent_payments rp
LEFT JOIN workspaces w ON w.owner_user_id = rp.user_id
ON CONFLICT (legacy_id) WHERE legacy_id IS NOT NULL DO NOTHING;

DO $$
DECLARE
  src_count INTEGER;
  dst_count INTEGER;
  orphan    INTEGER;
BEGIN
  SELECT COUNT(*) INTO src_count FROM rent_payments;
  SELECT COUNT(*) INTO dst_count FROM recurring_charges WHERE charge_type = 'rent';

  SELECT COUNT(*) INTO orphan
  FROM recurring_charges
  WHERE charge_type='rent' AND workspace_id IS NULL;

  RAISE NOTICE 'Backfill 011: rent_payments=% recurring_charges(rent)=% null_workspace=%',
               src_count, dst_count, orphan;

  IF dst_count < src_count THEN
    RAISE WARNING 'Backfill 011: destination row count < source. Investigate before proceeding.';
  END IF;
END $$;

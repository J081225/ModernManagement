-- =============================================================================
-- Phase 1 / 014 — Add matched_charge_id to payment_events
-- =============================================================================
-- Purpose:
--   Per Decision §9.8 (Q5 resolution): mirror the pattern used for
--   messages.sender_name. During Phase 1 we additively add a new column
--   matched_charge_id (pointing to recurring_charges.id) and backfill it from
--   the existing matched_rent_id (pointing to rent_payments.id) via the
--   legacy_id traceability we wrote into recurring_charges in 011.
--
--   matched_rent_id stays in place and continues to be authoritative through
--   Phase 2. Phase 2 (Session 2.4) adds dual-write. Phase 3's
--   005_drop_matched_rent_id_from_payment_events.sql drops the old column
--   once drift is zero.
--
-- Depends on:
--   - 011_backfill_recurring_charges.sql (populates recurring_charges.legacy_id
--     from rent_payments.id, which this file joins against)
--
-- Safety:
--   - Idempotent: ADD COLUMN IF NOT EXISTS + UPDATE guarded by
--     "matched_charge_id IS NULL" so re-runs never overwrite post-backfill
--     values.
--   - Non-destructive: no DROP, no ALTER TYPE, no data mutation of
--     matched_rent_id.
-- =============================================================================

-- 1. Add the new column
ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS matched_charge_id INTEGER;

-- 2. Backfill: for every payment_events row that has matched_rent_id set, find
--    the corresponding recurring_charges row (via legacy_id = matched_rent_id)
--    and record its new id in matched_charge_id.
--
--    Guarded by matched_charge_id IS NULL so this is safe to re-run.
DO $$
DECLARE
  v_backfilled_count INTEGER := 0;
  v_orphan_count     INTEGER := 0;
BEGIN
  -- Count rows that have a matched_rent_id but no corresponding charge row.
  -- These are orphan references; we log but don't fail.
  SELECT COUNT(*) INTO v_orphan_count
  FROM payment_events pe
  WHERE pe.matched_rent_id IS NOT NULL
    AND pe.matched_charge_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM recurring_charges rc WHERE rc.legacy_id = pe.matched_rent_id
    );

  -- Backfill the linkable rows.
  UPDATE payment_events pe
  SET matched_charge_id = rc.id
  FROM recurring_charges rc
  WHERE rc.legacy_id = pe.matched_rent_id
    AND pe.matched_rent_id IS NOT NULL
    AND pe.matched_charge_id IS NULL;

  GET DIAGNOSTICS v_backfilled_count = ROW_COUNT;

  RAISE NOTICE '014: backfilled matched_charge_id on % payment_events; % orphan references (matched_rent_id with no charge row) left as matched_charge_id=NULL', v_backfilled_count, v_orphan_count;
END $$;

-- 3. Optional: index for lookup performance.
CREATE INDEX IF NOT EXISTS payment_events_matched_charge_id_idx
  ON payment_events(matched_charge_id)
  WHERE matched_charge_id IS NOT NULL;

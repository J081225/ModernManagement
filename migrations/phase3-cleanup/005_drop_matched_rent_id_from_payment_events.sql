-- =============================================================================
-- Phase 3 / 005 — Drop payment_events.matched_rent_id
-- =============================================================================
-- Purpose:
--   Per Decision §9.8 (Q5): after Phase 2 dual-writes payment_events.matched_rent_id
--   AND .matched_charge_id for 7+ days in production with zero drift, drop the
--   legacy matched_rent_id column. Mirrors the pattern used for
--   messages.resident → sender_name (see 004_drop_resident_from_messages.sql).
--
-- Preconditions (verify manually before running):
--   - Phase 2 Session 2.4 has been in production ≥ 7 days
--   - /api/payments/events and related routes read+write matched_charge_id
--     as authoritative
--   - Drift check below returns 0
--   - Fresh Neon branch snapshot taken
--
-- Safety:
--   - Short-circuits if matched_rent_id already dropped (idempotent)
--   - RAISE EXCEPTION on any drift — will NOT drop a column while data is
--     inconsistent
-- =============================================================================

DO $$
DECLARE
  v_col_exists    BOOLEAN;
  v_drift_count   INTEGER;
BEGIN
  -- Idempotency: if matched_rent_id no longer exists, we're done.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_events' AND column_name = 'matched_rent_id'
  ) INTO v_col_exists;

  IF NOT v_col_exists THEN
    RAISE NOTICE '005: payment_events.matched_rent_id already dropped. Skipping.';
    RETURN;
  END IF;

  -- Drift check: for every payment_events row that has BOTH columns set,
  -- matched_charge_id must point to the recurring_charges row whose legacy_id
  -- equals matched_rent_id. Any mismatch blocks the drop.
  SELECT COUNT(*) INTO v_drift_count
  FROM payment_events pe
  LEFT JOIN recurring_charges rc ON rc.id = pe.matched_charge_id
  WHERE pe.matched_rent_id IS NOT NULL
    AND pe.matched_charge_id IS NOT NULL
    AND (rc.legacy_id IS DISTINCT FROM pe.matched_rent_id);

  IF v_drift_count > 0 THEN
    RAISE EXCEPTION '005: ABORT — % payment_events rows have matched_charge_id that does not resolve to the same rent_payment as matched_rent_id. Investigate before dropping.', v_drift_count;
  END IF;

  -- Also: any row that has matched_rent_id but NULL matched_charge_id means
  -- dual-write missed it. Block the drop.
  SELECT COUNT(*) INTO v_drift_count
  FROM payment_events
  WHERE matched_rent_id IS NOT NULL AND matched_charge_id IS NULL;

  IF v_drift_count > 0 THEN
    RAISE EXCEPTION '005: ABORT — % payment_events rows have matched_rent_id set but matched_charge_id is NULL. Phase 2 dual-write is incomplete.', v_drift_count;
  END IF;

  -- All clear. Drop the column.
  ALTER TABLE payment_events DROP COLUMN matched_rent_id;
  RAISE NOTICE '005: dropped payment_events.matched_rent_id successfully.';
END $$;

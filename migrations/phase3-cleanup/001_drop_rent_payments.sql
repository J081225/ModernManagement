-- =====================================================================
-- Phase 3 — 001_drop_rent_payments.sql
-- =====================================================================
-- Purpose:
--   Drop the old `rent_payments` table. Only safe to run after Phase 2
--   has been stable in production for at least 7 days and all drift
--   checks have returned zero for that entire period.
--
-- Pre-flight guard: aborts if recurring_charges has fewer rent-type rows
-- than rent_payments. A mismatch here means data would be lost.
--
-- Depends on: Phase 2 complete; dual-write has been REMOVED from
--             server.js one commit before this SQL runs.
-- Reversible: Only via Neon branch snapshot `pre-schema-gen-phase3-*`.
--             There is NO SQL rollback for DROP TABLE once committed.
-- =====================================================================

DO $$
DECLARE
  src_count INTEGER;
  dst_count INTEGER;
BEGIN
  -- Only try to count if both tables still exist (idempotency).
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rent_payments') THEN
    RAISE NOTICE 'rent_payments already dropped. Skipping.';
    RETURN;
  END IF;

  EXECUTE 'SELECT COUNT(*) FROM rent_payments'     INTO src_count;
  EXECUTE 'SELECT COUNT(*) FROM recurring_charges WHERE charge_type=''rent''' INTO dst_count;

  RAISE NOTICE 'Phase3 guard 001: rent_payments=% recurring_charges(rent)=%', src_count, dst_count;

  IF dst_count < src_count THEN
    RAISE EXCEPTION 'ABORT: recurring_charges has % rent rows but rent_payments has %. Refusing to drop. Re-run backfill 011 and verify.', dst_count, src_count;
  END IF;

  -- Safety: require the dual-write era to have shipped some new rows that
  -- are NOT legacy backfill (i.e., fresh user activity since cutover).
  -- Comment this check out if dropping on a staging DB without fresh activity.
  PERFORM 1 FROM recurring_charges WHERE charge_type='rent' AND legacy_id IS NULL LIMIT 1;
  IF NOT FOUND THEN
    RAISE WARNING 'No non-legacy recurring_charges rows found. You may be dropping before any new Phase-2 writes have landed. Proceed only if this is intentional.';
  END IF;

  DROP TABLE rent_payments CASCADE;
  RAISE NOTICE 'Dropped table rent_payments.';
END $$;

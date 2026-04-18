-- =====================================================================
-- Phase 3 — 002_drop_maintenance_tickets.sql
-- =====================================================================
-- Purpose:
--   Drop the old `maintenance_tickets` table. Same preconditions and
--   guard logic as 001_drop_rent_payments.sql.
--
-- Depends on: Phase 2 complete, dual-writes removed.
-- Reversible: Only via Neon branch snapshot.
-- =====================================================================

DO $$
DECLARE
  src_count INTEGER;
  dst_count INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'maintenance_tickets') THEN
    RAISE NOTICE 'maintenance_tickets already dropped. Skipping.';
    RETURN;
  END IF;

  EXECUTE 'SELECT COUNT(*) FROM maintenance_tickets' INTO src_count;
  EXECUTE 'SELECT COUNT(*) FROM service_requests WHERE request_type=''maintenance''' INTO dst_count;

  RAISE NOTICE 'Phase3 guard 002: maintenance_tickets=% service_requests(maintenance)=%', src_count, dst_count;

  IF dst_count < src_count THEN
    RAISE EXCEPTION 'ABORT: service_requests has % maintenance rows but maintenance_tickets has %. Refusing to drop.', dst_count, src_count;
  END IF;

  PERFORM 1 FROM service_requests WHERE request_type='maintenance' AND legacy_id IS NULL LIMIT 1;
  IF NOT FOUND THEN
    RAISE WARNING 'No non-legacy service_requests rows found. Proceed only if intentional.';
  END IF;

  DROP TABLE maintenance_tickets CASCADE;
  RAISE NOTICE 'Dropped table maintenance_tickets.';
END $$;

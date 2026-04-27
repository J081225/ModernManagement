-- =====================================================================
-- Phase 1 — 018_add_archived_at_to_entities.sql
-- =====================================================================
-- Purpose:
--   Add `archived_at TIMESTAMPTZ` to `entities` to support soft-delete
--   for properties. The Inventory UI (Feature 3, session 2026-04-23)
--   archives rather than DROPs a property so historical offerings,
--   agreements, and engagements continue to resolve their entity_id
--   references. Filter queries in the Inventory list use
--   `WHERE archived_at IS NULL`.
--
--   Semantics:
--     NULL        → not archived (default)
--     <timestamp> → archived at this moment; hidden from default listings
--
--   Un-archive is a simple `UPDATE entities SET archived_at = NULL`.
--
-- Depends on: 002 (entities table), 017 (entities metadata expansion).
-- Enables:    Inventory UI soft-delete (DELETE /api/entities/:id in
--             chunk 1b of the feat/inventory-ui session).
--
-- Idempotent: Yes. ADD COLUMN IF NOT EXISTS. No backfill needed — the
--             column simply defaults to NULL for every existing row.
-- Reversible: ALTER TABLE entities DROP COLUMN IF EXISTS archived_at;
--             (Safe: no data is stored in this column until the Inventory
--             UI ships, and even then only on explicit user archive.)
-- =====================================================================

ALTER TABLE entities ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

DO $$
DECLARE
  v_column_present INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_column_present
  FROM information_schema.columns
  WHERE table_name = 'entities' AND column_name = 'archived_at';
  RAISE NOTICE '018: entities.archived_at column present (% of 1).', v_column_present;
END $$;

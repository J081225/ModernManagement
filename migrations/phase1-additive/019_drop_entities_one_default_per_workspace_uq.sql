-- =====================================================================
-- Phase 1 — 019_drop_entities_one_default_per_workspace_uq.sql
-- =====================================================================
-- Purpose:
--   Drop the partial UNIQUE index `entities_one_default_per_workspace_uq`
--   created by 009_backfill_entities.sql. That index was only meant as a
--   backfill-safety guard (prevent double-creating the default entity on
--   re-run of 009). It accidentally persisted as a permanent constraint
--   that limits each workspace to ONE entity of entity_type='property' —
--   which breaks the Inventory UI's core feature of managing multiple
--   properties per workspace.
--
--   Discovered during chunk 3a of the Inventory UI build when POST
--   /api/entities failed with:
--     ERROR: duplicate key value violates unique constraint
--     "entities_one_default_per_workspace_uq"
--
-- Why this is safe:
--   - The index stores no data (it's a constraint, not content).
--   - Dropping it only relaxes a rule; existing rows are unaffected.
--   - 009's INSERT is still idempotent via its ON CONFLICT DO NOTHING
--     clause against the same index, and the backfill has already run
--     on every environment — re-running 009 after 019 would insert 0
--     rows (since entities already exist for every workspace).
--   - No application code currently relies on "at most one property
--     per workspace" — the Inventory UI explicitly supports N.
--
-- Philosophical note on scope:
--   Phase 1 was scoped "additive-only". This file technically removes
--   a schema artifact, so it nudges that boundary. It's included in
--   phase1-additive anyway because:
--     (a) the artifact being dropped was created in Phase 1 (file 009),
--     (b) no user data is touched,
--     (c) it keeps all Inventory-related schema changes in one dir.
--
-- Depends on: 009 (created the index). 018 (previous Phase 1 addition).
-- Enables:    POST /api/entities with multiple property rows per workspace,
--             which the Inventory UI (feat/inventory-ui) requires.
--
-- Idempotent: Yes. DROP INDEX IF EXISTS.
-- Reversible: re-create the index:
--             CREATE UNIQUE INDEX IF NOT EXISTS entities_one_default_per_workspace_uq
--               ON entities(workspace_id) WHERE entity_type = 'property';
--             (only makes sense if you want to lock workspaces to one
--             property each, which is not the intended product model.)
-- =====================================================================

DROP INDEX IF EXISTS entities_one_default_per_workspace_uq;

DO $$
DECLARE
  v_index_gone INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_index_gone
  FROM pg_indexes
  WHERE indexname = 'entities_one_default_per_workspace_uq';
  IF v_index_gone = 0 THEN
    RAISE NOTICE '019: entities_one_default_per_workspace_uq index dropped (or was not present).';
  ELSE
    RAISE WARNING '019: entities_one_default_per_workspace_uq still exists — drop did not take effect.';
  END IF;
END $$;

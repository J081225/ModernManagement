-- =====================================================================
-- Phase 1 — 009_backfill_entities.sql
-- =====================================================================
-- Purpose:
--   Create exactly one entity per workspace as the default "property"
--   placeholder. Users can later rename, split, or add more entities.
--
-- Depends on: 008 (workspaces backfilled).
-- Enables:    010 (agreements.entity_id lookup), 012
--             (service_requests.entity_id lookup).
--
-- Idempotent: Yes. Uses partial unique index to prevent duplicates.
-- Reversible: DELETE FROM entities WHERE entity_type='property' AND ...;
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS entities_one_default_per_workspace_uq
  ON entities(workspace_id)
  WHERE entity_type = 'property';

INSERT INTO entities (workspace_id, name, entity_type)
SELECT
  w.id,
  w.name || ' — Default' AS name,
  'property' AS entity_type
FROM workspaces w
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  ws_count INTEGER;
  ent_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO ws_count FROM workspaces;
  SELECT COUNT(*) INTO ent_count FROM entities;
  RAISE NOTICE 'Backfill 009: workspaces=% entities=%', ws_count, ent_count;
END $$;

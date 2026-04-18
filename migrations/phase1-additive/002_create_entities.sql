-- =====================================================================
-- Phase 1 — 002_create_entities.sql
-- =====================================================================
-- Purpose:
--   Create the `entities` table — the mid-level grouping inside a
--   workspace. For property management, one entity = one property/
--   building. For other verticals: offices, listings, sites, etc.
--
-- Depends on: 001_create_workspaces.sql
-- Enables:    003 (agreements.entity_id), 006 (service_requests.entity_id),
--             009 (backfill_entities).
--
-- Idempotent: Yes. Safe to re-run.
-- Reversible: DROP TABLE IF EXISTS entities CASCADE;
-- =====================================================================

CREATE TABLE IF NOT EXISTS entities (
  id            SERIAL PRIMARY KEY,
  workspace_id  INTEGER NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  entity_type   TEXT NOT NULL DEFAULT 'property',
  address       TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS entities_workspace_id_idx ON entities(workspace_id);
CREATE INDEX IF NOT EXISTS entities_entity_type_idx  ON entities(entity_type);

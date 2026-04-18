-- =====================================================================
-- Phase 1 — 008_backfill_workspaces.sql
-- =====================================================================
-- Purpose:
--   Create one workspace per existing user. Name defaults to the user's
--   username. Vertical type defaults to 'property_management'.
--
-- Depends on: 001 (workspaces table exists), existing users table.
-- Enables:    009 (backfill_entities), 010 (backfill_agreements), and
--             workspace_id population in 011/012.
--
-- Idempotent: Yes. ON CONFLICT DO NOTHING against the (user_id) partial
--             unique guard implemented below. Re-running is a no-op.
--
-- Reversible: DELETE FROM workspaces WHERE created_at > '<timestamp>';
-- =====================================================================

-- Partial unique index prevents double-creating a workspace for the same
-- owner user during re-runs. We do NOT add this as a hard constraint
-- forever because future multi-workspace users are possible.
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_one_per_owner_backfill_uq
  ON workspaces(owner_user_id)
  WHERE vertical_type = 'property_management';

INSERT INTO workspaces (owner_user_id, name, vertical_type)
SELECT
  u.id,
  COALESCE(NULLIF(u.username, ''), 'My Workspace') AS name,
  'property_management' AS vertical_type
FROM users u
ON CONFLICT DO NOTHING;

-- Sanity reporting (does not fail the migration; just prints)
DO $$
DECLARE
  user_count INTEGER;
  ws_count   INTEGER;
BEGIN
  SELECT COUNT(*) INTO user_count FROM users;
  SELECT COUNT(*) INTO ws_count FROM workspaces;
  RAISE NOTICE 'Backfill 008: users=% workspaces=%', user_count, ws_count;
END $$;

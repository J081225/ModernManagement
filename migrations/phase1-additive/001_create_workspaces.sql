-- =====================================================================
-- Phase 1 — 001_create_workspaces.sql
-- =====================================================================
-- Purpose:
--   Create the top-level tenancy table `workspaces`. Every user today has
--   an implicit workspace (user_id === workspace). This table makes that
--   relationship explicit and carries `vertical_type` so downstream code
--   can choose vertical-specific labels.
--
-- Depends on: users table (existing)
-- Enables:    002 (entities), 003 (agreements), 004 (vertical_configs),
--             008 (backfill_workspaces), and all other new tables with
--             workspace_id columns.
--
-- Idempotent: Yes. Safe to re-run.
-- Reversible: DROP TABLE IF EXISTS workspaces CASCADE;
-- =====================================================================

-- Column naming: `owner_user_id` (not `user_id`) on workspaces. Other
-- tables keep `user_id` unchanged — only `workspaces` adopts the
-- `owner_user_id` name to make the "current owner, future many-users-
-- per-workspace" semantic explicit now while the column is cheap to
-- name. See plan §9.2.
CREATE TABLE IF NOT EXISTS workspaces (
  id             SERIAL PRIMARY KEY,
  owner_user_id  INTEGER NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  vertical_type  TEXT NOT NULL DEFAULT 'property_management',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspaces_owner_user_id_idx ON workspaces(owner_user_id);
CREATE INDEX IF NOT EXISTS workspaces_vertical_type_idx ON workspaces(vertical_type);

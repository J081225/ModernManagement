-- =====================================================================
-- E1 — 033_vertical_canonical.sql
-- =====================================================================
-- Purpose:
--   Establish 'vertical' (hyphen form) as the canonical workspace
--   vertical column and add a CHECK constraint allowing the two
--   currently-supported verticals: property-management and
--   professional-services.
--
-- Pre-E1 state (verified against the live schema):
--   - workspaces.vertical exists from migration 026 (NOT NULL,
--     DEFAULT 'property-management').
--   - There is NO workspaces.vertical_type column. The handoff brief
--     described one inherited from migration 023, but 023 only added
--     subscription_tier (since dropped by 031) and Twilio/business
--     identity columns. No backfill is required.
--   - idx_workspaces_vertical exists from migration 026. The
--     CREATE INDEX IF NOT EXISTS below is a no-op safety net.
--
-- This migration:
--   1. Adds CHECK (vertical IN ('property-management',
--      'professional-services')). New verticals require a future
--      migration that ALTERs this constraint.
--   2. Re-asserts the vertical index for safety (no-op if present).
--
-- Future cleanup (deferred):
--   When confidence is high that no callers reference legacy vertical
--   naming anywhere, a future session can audit and confirm. There is
--   no vertical_type column to drop; this comment is a marker only.
-- =====================================================================

-- Step 1: Add CHECK constraint for known verticals.
-- Wrapped in DO block so re-running the migration is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'workspaces_vertical_check'
      AND table_name = 'workspaces'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_vertical_check
      CHECK (vertical IN ('property-management', 'professional-services'));
  END IF;
END $$;

-- Step 2: Index for vertical-scoped queries.
-- Already created by migration 026; this is a safety net.
CREATE INDEX IF NOT EXISTS idx_workspaces_vertical ON workspaces(vertical);

DO $$
DECLARE
  v_check_count INTEGER;
  v_idx_count   INTEGER;
  v_pm_count    INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_check_count
  FROM information_schema.table_constraints
  WHERE constraint_name = 'workspaces_vertical_check'
    AND table_name = 'workspaces';

  SELECT COUNT(*) INTO v_idx_count
  FROM pg_indexes WHERE indexname = 'idx_workspaces_vertical';

  SELECT COUNT(*) INTO v_pm_count
  FROM workspaces WHERE vertical = 'property-management';

  RAISE NOTICE '033: vertical CHECK constraint: % of 1, vertical index: % of 1, property-management workspaces: %.',
    v_check_count, v_idx_count, v_pm_count;
END $$;

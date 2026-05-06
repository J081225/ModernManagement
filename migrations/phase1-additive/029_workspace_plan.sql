-- Add plan column to workspaces. All existing workspaces default to 'team'
-- (most generous tier) so nothing breaks before enforcement ships.
-- Future sessions will set this explicitly during signup based on what
-- the customer chose at checkout.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'team';

-- Add CHECK constraint to enforce valid plan values at the database level
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'workspaces_plan_check'
    AND table_name = 'workspaces'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_plan_check
      CHECK (plan IN ('trial', 'solo', 'team', 'enterprise'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspaces_plan ON workspaces(plan);

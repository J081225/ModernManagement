-- =====================================================================
-- E11 — 039_plan_check_constraint_ps.sql
-- =====================================================================
-- Expand the workspaces_plan_check CHECK constraint to allow Professional
-- Services plan names (starter, pro, premium) alongside the existing
-- Property Management plan names (trial, solo, team, enterprise).
--
-- Pre-E11: the constraint only allowed PM values, so workspace creation
-- with plan='starter' (or 'pro' / 'premium') would fail at INSERT time
-- with a constraint violation. PS signup needs the constraint relaxed.
--
-- Postgres DDL note: dropping and recreating a CHECK constraint is
-- atomic and doesn't lock the table for read queries. It briefly takes
-- an ACCESS EXCLUSIVE lock to swap the definition — fast on a constraint
-- change (no full-table scan required since the new constraint is a
-- superset of the old one; existing rows already satisfy it).
--
-- Reversible by dropping and recreating with the original 4-value list.
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'workspaces_plan_check'
       AND table_name = 'workspaces'
  ) THEN
    ALTER TABLE workspaces DROP CONSTRAINT workspaces_plan_check;
  END IF;

  ALTER TABLE workspaces ADD CONSTRAINT workspaces_plan_check
    CHECK (plan = ANY (ARRAY[
      'trial'::text,
      'solo'::text,
      'team'::text,
      'enterprise'::text,
      'starter'::text,
      'pro'::text,
      'premium'::text
    ]));
END $$;

DO $$
DECLARE
  v_constraint_present INTEGER;
  v_def TEXT;
BEGIN
  SELECT COUNT(*) INTO v_constraint_present
    FROM information_schema.table_constraints
   WHERE constraint_name = 'workspaces_plan_check'
     AND table_name = 'workspaces';
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'workspaces_plan_check';
  RAISE NOTICE '039: workspaces_plan_check present=%, def=%', v_constraint_present, v_def;
END $$;

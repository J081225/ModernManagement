-- LP2a follow-up / pricing-collapse completeness: workspaces_plan_check
-- still allowed only the RETIRED tier ids (trial/solo/team/enterprise/
-- starter/pro/premium), so plan='professional' — the one live plan since
-- the 2026-08-16 collapse (f59dd30) — violated the constraint. Found live:
-- the Northside Barbers demo-workspace INSERT rolled back on it, which
-- also means any PS signup storing 'professional' would have failed at
-- orchestration. Legacy values stay allowed (existing rows carry them;
-- lib/plans.getPlan maps them all to Professional at read time).
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_plan_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_plan_check
  CHECK (plan = ANY (ARRAY[
    'trial'::text, 'professional'::text,
    -- retired ids, kept for existing rows:
    'solo'::text, 'team'::text, 'enterprise'::text,
    'starter'::text, 'pro'::text, 'premium'::text
  ]));

-- BG1 — 056_budget_goals.sql
--
-- Workspace-scoped budget goals (finances-investigation §6). No
-- endpoint yet — BG6 builds owner entry; this exists so the summary
-- layer can read a target when one exists. Same cents boundary as 055.

CREATE TABLE IF NOT EXISTS budget_goals (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'revenue',   -- 'revenue' | 'savings'
  label        TEXT,
  target_cents INTEGER NOT NULL,
  period       TEXT NOT NULL DEFAULT 'month',      -- 'month' | 'quarter' | 'once'
  active       BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_goals_workspace_active
  ON budget_goals(workspace_id) WHERE active = TRUE;

-- Usage tracking tables for plan-aware feature gating.
-- Counters reset based on the period_start column rather than via
-- separate maintenance jobs — this means the helper functions in
-- lib/usage.js use upserts keyed on (workspace, user, period_start)
-- so a fresh day or month automatically gets a new row.

-- AI commands per user per day
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  command_count INTEGER NOT NULL DEFAULT 0,
  last_command_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT ai_usage_daily_unique UNIQUE (workspace_id, user_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_workspace
  ON ai_usage_daily(workspace_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_daily_user
  ON ai_usage_daily(user_id, period_start DESC);

-- Reports per workspace per month
CREATE TABLE IF NOT EXISTS report_usage_monthly (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  report_count INTEGER NOT NULL DEFAULT 0,
  last_report_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  CONSTRAINT report_usage_monthly_unique UNIQUE (workspace_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_report_usage_monthly_workspace
  ON report_usage_monthly(workspace_id, period_start DESC);

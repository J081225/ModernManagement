-- Reports table — saves AI-generated reports as first-class records.
-- The home page Quick Snapshot Report stays ephemeral (not saved here);
-- only explicit reports created via the AI command bar or the Reports
-- page get persisted.

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'general',
  prompt TEXT,
  content TEXT NOT NULL,
  data_snapshot JSONB,
  parameters JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_workspace ON reports(workspace_id);
CREATE INDEX IF NOT EXISTS idx_reports_workspace_created ON reports(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_workspace_type ON reports(workspace_id, type);

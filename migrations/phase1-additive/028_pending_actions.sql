-- Pending actions queue: AI tool calls that require human approval before
-- execution. When a tool tagged requiresApproval is invoked by the AI,
-- the server stores the call here instead of executing it. The user
-- approves or rejects via the Home page approval queue or the inline
-- buttons in the AI response.

CREATE TABLE IF NOT EXISTS pending_actions (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  input JSONB NOT NULL,
  ai_summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_workspace_status
  ON pending_actions(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_actions_workspace_created
  ON pending_actions(workspace_id, created_at DESC);

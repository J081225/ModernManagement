-- =====================================================================
-- E9 — 038_command_history.sql
-- =====================================================================
-- Persistent chat history for the Command Center (the always-visible AI
-- chat bar added in E9). Each row is one message — either from the user
-- (role='user') or the AI (role='assistant'). The UI renders them as
-- chat bubbles in chronological order.
--
-- Scoped by BOTH user_id AND workspace_id because the same user can own
-- multiple workspaces (the workspace selector picks the newest one per
-- earlier helper change). History is per-user-per-workspace, not global.
--
-- tool_calls_summary is an optional comma-separated list of tool names
-- the AI invoked for that turn (only set on role='assistant' rows where
-- the AI used tools). The UI surfaces it as a small annotation under the
-- bubble — pure transparency, no behavior change.
-- =====================================================================

CREATE TABLE IF NOT EXISTS command_history (
  id                 SERIAL PRIMARY KEY,
  workspace_id       INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               TEXT NOT NULL,
  content            TEXT NOT NULL,
  tool_calls_summary TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'command_history_role_check'
       AND table_name = 'command_history'
  ) THEN
    ALTER TABLE command_history
      ADD CONSTRAINT command_history_role_check
      CHECK (role IN ('user', 'assistant', 'system'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_command_history_workspace_user_created
  ON command_history(workspace_id, user_id, created_at DESC);

DO $$
DECLARE
  v_table_present INTEGER;
  v_check_present INTEGER;
  v_idx_present   INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_table_present FROM information_schema.tables
    WHERE table_name = 'command_history';
  SELECT COUNT(*) INTO v_check_present FROM information_schema.table_constraints
    WHERE constraint_name = 'command_history_role_check'
      AND table_name = 'command_history';
  SELECT COUNT(*) INTO v_idx_present FROM pg_indexes
    WHERE indexname = 'idx_command_history_workspace_user_created';
  RAISE NOTICE '038: command_history table: % of 1, role CHECK: % of 1, index: % of 1.',
    v_table_present, v_check_present, v_idx_present;
END $$;

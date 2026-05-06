-- Add vertical tag to workspaces. All existing workspaces are
-- property management; the default reflects that. Future verticals
-- (professional services, etc.) will set this column explicitly at
-- workspace creation time.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS vertical TEXT NOT NULL DEFAULT 'property-management';

CREATE INDEX IF NOT EXISTS idx_workspaces_vertical ON workspaces(vertical);

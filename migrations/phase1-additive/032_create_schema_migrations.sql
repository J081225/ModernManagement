-- D8 production hardening: tracking table for auto-running migration system.
--
-- Records which migration files have been applied so the runner doesn't
-- re-apply them on every startup.
--
-- This migration MUST be applied manually by the user via Neon SQL Editor
-- BEFORE the migration runner code in lib/migrations.js can take over.
-- After this table exists, the runner reads from it on every startup
-- and applies only new migrations.
--
-- After applying this migration, the user must backfill the table with the
-- filenames of migrations already applied to the live database. See the
-- header comment of lib/migrations.js for the backfill SQL template.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_via TEXT NOT NULL DEFAULT 'manual'
);

CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
  ON schema_migrations(applied_at DESC);

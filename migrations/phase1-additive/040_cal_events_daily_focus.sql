-- =====================================================================
-- E12 — 040_cal_events_daily_focus.sql
-- =====================================================================
-- Add 'daily_focus' to the cal_events_event_type_check CHECK constraint.
--
-- The daily-focus feature creates one AI-generated calendar event per
-- workspace per day — a concrete profit/productivity suggestion. The
-- event needs a distinct event_type so the "does today's nudge already
-- exist?" lookup is reliable (a title-prefix match would be fragile).
--
-- Pre-040: migration 034 set the constraint to
--   CHECK (event_type IN ('general','appointment','time_off','personal'))
-- An INSERT with event_type='daily_focus' would fail the constraint.
--
-- Postgres DDL note: dropping and recreating a CHECK constraint takes a
-- brief ACCESS EXCLUSIVE lock but no full-table scan — the new constraint
-- is a strict superset of the old one, so existing rows already satisfy
-- it. Reversible: drop and recreate without 'daily_focus'.
-- =====================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'cal_events_event_type_check'
       AND table_name = 'cal_events'
  ) THEN
    ALTER TABLE cal_events DROP CONSTRAINT cal_events_event_type_check;
  END IF;

  ALTER TABLE cal_events ADD CONSTRAINT cal_events_event_type_check
    CHECK (event_type IN ('general', 'appointment', 'time_off', 'personal', 'daily_focus'));
END $$;

-- Index to make the per-workspace-per-day existence check fast.
CREATE INDEX IF NOT EXISTS idx_cal_events_daily_focus
  ON cal_events(workspace_id, date)
  WHERE event_type = 'daily_focus';

DO $$
DECLARE
  v_def TEXT;
  v_idx INTEGER;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint WHERE conname = 'cal_events_event_type_check';
  SELECT COUNT(*) INTO v_idx FROM pg_indexes
    WHERE indexname = 'idx_cal_events_daily_focus';
  RAISE NOTICE '040: cal_events_event_type_check def=%, daily_focus index=% of 1.', v_def, v_idx;
END $$;

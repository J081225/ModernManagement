-- =====================================================================
-- E2 — 034_calendar_extension.sql
-- =====================================================================
-- Calendar extension to support appointments and richer events.
--
-- Pre-E2: cal_events has minimal columns (user_id, date TEXT, title) — no
-- time-of-day, no duration, no workspace_id. PM workspaces have been writing
-- all-day events to it.
--
-- E2 adds:
--   workspace_id    - workspace scoping
--   starts_at       - real start timestamp
--   ends_at         - real end timestamp
--   is_all_day      - boolean for events with no specific time
--   event_type      - 'general', 'appointment', 'time_off', 'personal'
--   appointment_id  - reverse link when this event was auto-created from an
--                     appointment. The FK is added by 035 once the
--                     appointments table exists.
--
-- All new columns are nullable (or have defaults); existing rows are
-- backfilled to all-day events tied to the owning workspace. The legacy
-- `date` TEXT column is preserved — add_calendar_event.js still writes it,
-- and the AI calendar context tools currently read it.
-- =====================================================================

ALTER TABLE cal_events ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE cal_events ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE cal_events ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
ALTER TABLE cal_events ADD COLUMN IF NOT EXISTS is_all_day BOOLEAN DEFAULT TRUE;
ALTER TABLE cal_events ADD COLUMN IF NOT EXISTS event_type TEXT DEFAULT 'general';
ALTER TABLE cal_events ADD COLUMN IF NOT EXISTS appointment_id INTEGER;

-- Backfill workspace_id from cal_events.user_id via workspaces.owner_user_id.
-- Rows whose owner_user_id has no workspace remain NULL — that's fine, they
-- simply won't appear in workspace-scoped queries.
UPDATE cal_events ce
   SET workspace_id = w.id
  FROM workspaces w
 WHERE ce.workspace_id IS NULL
   AND w.owner_user_id = ce.user_id;

-- Backfill starts_at / ends_at from the legacy `date` TEXT column.
-- Only attempt the cast for rows whose `date` value matches YYYY-MM-DD —
-- prevents the migration from blowing up on free-form values that may have
-- been inserted by hand or by older code paths.
UPDATE cal_events
   SET starts_at = (date::date)::timestamptz,
       ends_at   = ((date::date) + INTERVAL '1 day')::timestamptz,
       is_all_day = TRUE,
       event_type = COALESCE(event_type, 'general')
 WHERE starts_at IS NULL
   AND date IS NOT NULL
   AND date ~ '^\d{4}-\d{2}-\d{2}$';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'cal_events_event_type_check'
       AND table_name = 'cal_events'
  ) THEN
    ALTER TABLE cal_events
      ADD CONSTRAINT cal_events_event_type_check
      CHECK (event_type IN ('general', 'appointment', 'time_off', 'personal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cal_events_workspace_starts_at
  ON cal_events(workspace_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_cal_events_appointment_id
  ON cal_events(appointment_id) WHERE appointment_id IS NOT NULL;

DO $$
DECLARE
  v_new_cols   INTEGER;
  v_backfilled INTEGER;
  v_unparsed   INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_new_cols
  FROM information_schema.columns
  WHERE table_name = 'cal_events'
    AND column_name IN ('workspace_id','starts_at','ends_at','is_all_day','event_type','appointment_id');

  SELECT COUNT(*) INTO v_backfilled FROM cal_events WHERE starts_at IS NOT NULL;
  SELECT COUNT(*) INTO v_unparsed
    FROM cal_events
    WHERE starts_at IS NULL
      AND date IS NOT NULL
      AND date !~ '^\d{4}-\d{2}-\d{2}$';

  RAISE NOTICE '034: cal_events new columns: % of 6, rows with starts_at: %, rows skipped due to unparseable date: %.',
    v_new_cols, v_backfilled, v_unparsed;
END $$;

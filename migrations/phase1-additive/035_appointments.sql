-- =====================================================================
-- E2 — 035_appointments.sql
-- =====================================================================
-- Adds appointments + appointment_threads tables and the two workspace
-- settings the appointment engine reads (appointment_auto_confirm and
-- appointment_auto_respond). Defaults appointment_auto_respond=TRUE for
-- existing PS workspaces. PM workspaces stay opted out.
--
-- Depends on 034_calendar_extension.sql (cal_events.appointment_id column)
-- and migration 033 (vertical CHECK constraint).
-- =====================================================================

-- Workspace settings columns
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS appointment_auto_confirm BOOLEAN DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS appointment_auto_respond BOOLEAN DEFAULT FALSE;

-- Default appointment_auto_respond to TRUE for PS workspaces (PM stays FALSE)
UPDATE workspaces
   SET appointment_auto_respond = TRUE
 WHERE vertical = 'professional-services'
   AND appointment_auto_respond IS DISTINCT FROM TRUE;

-- Appointments table
CREATE TABLE IF NOT EXISTS appointments (
  id                       SERIAL PRIMARY KEY,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id               INTEGER, -- nullable for walk-ins; soft FK to user-scoped contacts
  cal_event_id             INTEGER REFERENCES cal_events(id) ON DELETE SET NULL,

  title                    TEXT NOT NULL,
  notes_internal           TEXT,
  notes_customer           TEXT,

  starts_at                TIMESTAMPTZ NOT NULL,
  duration_minutes         INTEGER NOT NULL DEFAULT 60,
  ends_at                  TIMESTAMPTZ NOT NULL,

  status                   TEXT NOT NULL DEFAULT 'requested',
  customer_confirmed       BOOLEAN DEFAULT FALSE,
  reminder_sent_at         TIMESTAMPTZ,

  quoted_price_cents       INTEGER,
  final_price_cents        INTEGER,
  amount_paid_cents        INTEGER DEFAULT 0,
  payment_method           TEXT,
  payment_collected_at     TIMESTAMPTZ,

  source                   TEXT NOT NULL DEFAULT 'staff_command_bar',
  created_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ai_confidence_at_creation NUMERIC(3,2),

  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),
  canceled_at              TIMESTAMPTZ,
  canceled_by              TEXT,
  canceled_reason          TEXT,
  completed_at             TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='appointments_status_check' AND table_name='appointments') THEN
    ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
      CHECK (status IN ('requested','confirmed','in_progress','completed','canceled','no_show'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='appointments_source_check' AND table_name='appointments') THEN
    ALTER TABLE appointments ADD CONSTRAINT appointments_source_check
      CHECK (source IN ('ai_inbound_sms','ai_inbound_email','ai_inbound_voicemail',
                        'staff_command_bar','public_booking','walk_in'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_appointments_workspace_starts_at ON appointments(workspace_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_workspace_status   ON appointments(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_appointments_contact_id         ON appointments(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_cal_event_id       ON appointments(cal_event_id) WHERE cal_event_id IS NOT NULL;

-- Now that appointments exists, link cal_events.appointment_id as a real FK
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='cal_events_appointment_id_fkey' AND table_name='cal_events') THEN
    ALTER TABLE cal_events ADD CONSTRAINT cal_events_appointment_id_fkey
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Appointment threads table
CREATE TABLE IF NOT EXISTS appointment_threads (
  id                       SERIAL PRIMARY KEY,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id               INTEGER,
  appointment_id           INTEGER REFERENCES appointments(id) ON DELETE CASCADE,

  state                    TEXT NOT NULL DEFAULT 'gathering',
  inbound_channel          TEXT NOT NULL,
  customer_phone           TEXT,
  customer_email           TEXT,

  context_summary          TEXT,
  last_ai_message_at       TIMESTAMPTZ,
  last_customer_message_at TIMESTAMPTZ,
  message_count            INTEGER DEFAULT 0,

  escalated_at             TIMESTAMPTZ,
  escalation_reason        TEXT,

  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),
  closed_at                TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='appointment_threads_state_check' AND table_name='appointment_threads') THEN
    ALTER TABLE appointment_threads ADD CONSTRAINT appointment_threads_state_check
      CHECK (state IN ('gathering','proposing_times','awaiting_confirmation','complete','escalated_to_staff','closed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='appointment_threads_channel_check' AND table_name='appointment_threads') THEN
    ALTER TABLE appointment_threads ADD CONSTRAINT appointment_threads_channel_check
      CHECK (inbound_channel IN ('sms','email','voicemail'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_appointment_threads_workspace_state   ON appointment_threads(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_appointment_threads_customer_phone   ON appointment_threads(workspace_id, customer_phone) WHERE customer_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointment_threads_appointment_id   ON appointment_threads(appointment_id) WHERE appointment_id IS NOT NULL;

DO $$
DECLARE
  v_appts_table  INTEGER;
  v_threads_table INTEGER;
  v_ws_settings  INTEGER;
  v_ps_count     INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_appts_table FROM information_schema.tables WHERE table_name='appointments';
  SELECT COUNT(*) INTO v_threads_table FROM information_schema.tables WHERE table_name='appointment_threads';
  SELECT COUNT(*) INTO v_ws_settings FROM information_schema.columns
    WHERE table_name='workspaces' AND column_name IN ('appointment_auto_confirm','appointment_auto_respond');
  SELECT COUNT(*) INTO v_ps_count FROM workspaces WHERE vertical='professional-services';

  RAISE NOTICE '035: appointments table: % of 1, appointment_threads table: % of 1, workspace settings: % of 2, PS workspaces: %.',
    v_appts_table, v_threads_table, v_ws_settings, v_ps_count;
END $$;

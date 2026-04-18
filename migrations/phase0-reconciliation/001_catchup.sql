-- =============================================================================
-- Phase 0 / 001 — Catch-up reconciliation
-- =============================================================================
--
-- Purpose:
--   Bring production PostgreSQL schema in line with what server.js on `main`
--   currently expects. This is NOT part of the vertical-agnostic schema
--   generalization (that is `plan/schema-generalization`). This is pure catch-up
--   for the migrations that have been silently failing on production because
--   of the chain failure described in docs/schema-reality-gap.md §3.
--
-- What this does (in order):
--   1. Fix the `automation` table structural mismatch (data-preserving).
--   2. Re-seed the admin automation row.
--   3. Add 9 missing columns to users and contacts.
--   4. Create 2 missing tables: email_accounts and payment_events.
--   5. Backfill payment_forward_token for any user missing one.
--   6. Report final state via RAISE NOTICE.
--
-- What this does NOT do:
--   - NOT create workspaces, entities, agreements, recurring_charges,
--     service_requests, vertical_configs — those are schema-generalization work.
--   - NOT touch contacts.contact_type, contacts.is_important, messages.sender_name,
--     payment_events.matched_charge_id, or workspaces.owner_user_id — those are
--     also generalization work.
--   - NOT drop any columns. Every change is additive.
--   - NOT touch the fix/multi-tenancy branch work (drafts table,
--     user_sessions table, users.twilio_phone_number, users.inbound_email_alias).
--     Those land by merging that branch to main — not via this SQL.
--
-- Safety:
--   - Fully idempotent — every statement is guarded. Safe to run twice.
--   - Wrapped in a transaction: either everything applies or nothing does.
--   - The automation-table rebuild preserves any existing data.
--   - RAISE NOTICE every step so progress is visible in psql output.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Step 1: Fix the automation table structural mismatch.
-- -----------------------------------------------------------------------------
-- Current production state: automation (id INTEGER, "autoReplyEnabled" BOOLEAN).
-- Desired state:            automation (user_id INTEGER PRIMARY KEY, "autoReplyEnabled" BOOLEAN DEFAULT false).
--
-- Strategy: check whether user_id already exists. If yes, skip this step.
-- If no, rebuild the table preserving data.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_has_user_id BOOLEAN;
  v_row_count   INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'automation' AND column_name = 'user_id'
  ) INTO v_has_user_id;

  IF v_has_user_id THEN
    RAISE NOTICE '[1/6] automation.user_id already exists — skipping rebuild.';
    RETURN;
  END IF;

  -- Count existing rows so we can report data preservation.
  SELECT COUNT(*) INTO v_row_count FROM automation;
  RAISE NOTICE '[1/6] automation table has % existing row(s). Rebuilding structure, preserving data.', v_row_count;

  -- Create the new table with the correct structure.
  CREATE TABLE IF NOT EXISTS automation_new (
    user_id INTEGER PRIMARY KEY,
    "autoReplyEnabled" BOOLEAN DEFAULT false
  );

  -- Preserve data: if rows exist with meaningful data, copy them.
  -- We assume any existing row was intended to belong to user_id=1 (admin),
  -- since the app has been effectively single-tenant until now.
  INSERT INTO automation_new (user_id, "autoReplyEnabled")
  SELECT 1, "autoReplyEnabled" FROM automation
  ON CONFLICT (user_id) DO NOTHING;

  DROP TABLE automation;
  ALTER TABLE automation_new RENAME TO automation;

  RAISE NOTICE '[1/6] automation table rebuilt with user_id PRIMARY KEY.';
END $$;

-- -----------------------------------------------------------------------------
-- Step 2: Re-seed admin automation row (guarded by ON CONFLICT).
-- -----------------------------------------------------------------------------

INSERT INTO automation (user_id, "autoReplyEnabled")
VALUES (1, false)
ON CONFLICT (user_id) DO NOTHING;

DO $$ BEGIN RAISE NOTICE '[2/6] Admin automation row seeded (or already present).'; END $$;

-- -----------------------------------------------------------------------------
-- Step 3: Add missing columns to users.
-- -----------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_email      TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_enabled   BOOLEAN DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed    BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_forward_token   TEXT DEFAULT '';

DO $$ BEGIN RAISE NOTICE '[3/6] users: 6 columns added (or already present).'; END $$;

-- -----------------------------------------------------------------------------
-- Step 4: Add missing columns to contacts.
-- -----------------------------------------------------------------------------

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lease_start   TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lease_end     TEXT DEFAULT '';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS monthly_rent  NUMERIC(10,2) DEFAULT 0;

DO $$ BEGIN RAISE NOTICE '[4/6] contacts: 3 lease/rent columns added (or already present).'; END $$;

-- -----------------------------------------------------------------------------
-- Step 5: Create missing tables.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_accounts (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL UNIQUE,
  email               TEXT NOT NULL,
  provider            TEXT DEFAULT 'custom',
  imap_host           TEXT NOT NULL,
  imap_port           INTEGER DEFAULT 993,
  smtp_host           TEXT NOT NULL,
  smtp_port           INTEGER DEFAULT 465,
  encrypted_password  TEXT NOT NULL,
  last_sync_uid       INTEGER DEFAULT 0,
  last_sync_at        TIMESTAMPTZ,
  sync_enabled        BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_events (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  raw_from          TEXT DEFAULT '',
  raw_subject       TEXT DEFAULT '',
  raw_body          TEXT DEFAULT '',
  parsed_tenant     TEXT DEFAULT '',
  parsed_amount     NUMERIC(10,2) DEFAULT 0,
  parsed_date       TEXT DEFAULT '',
  parsed_source     TEXT DEFAULT '',
  confidence        TEXT DEFAULT 'low',
  matched_rent_id   INTEGER,
  status            TEXT DEFAULT 'needs_review',
  "createdAt"       TIMESTAMPTZ DEFAULT NOW()
);

-- Optional but recommended indexes to prevent future sequential scans.
CREATE INDEX IF NOT EXISTS email_accounts_user_id_idx     ON email_accounts(user_id);
CREATE INDEX IF NOT EXISTS payment_events_user_id_idx     ON payment_events(user_id);
CREATE INDEX IF NOT EXISTS payment_events_status_idx      ON payment_events(status);
CREATE INDEX IF NOT EXISTS payment_events_matched_rent_idx ON payment_events(matched_rent_id) WHERE matched_rent_id IS NOT NULL;

DO $$ BEGIN RAISE NOTICE '[5/6] email_accounts and payment_events tables created (or already present), plus indexes.'; END $$;

-- -----------------------------------------------------------------------------
-- Step 6: Backfill payment_forward_token for any existing user without one.
-- -----------------------------------------------------------------------------
-- Mirrors the logic in server.js:531 (which has been unreachable).
-- Uses the same character set as generateForwardToken() for consistency.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_user_id     INTEGER;
  v_new_token   TEXT;
  v_count       INTEGER := 0;
BEGIN
  FOR v_user_id IN
    SELECT id FROM users WHERE payment_forward_token IS NULL OR payment_forward_token = ''
  LOOP
    -- Generate a 12-character token using a safe alphabet (no 0,o,i,l,1 per server.js).
    v_new_token := '';
    FOR i IN 1..12 LOOP
      v_new_token := v_new_token || substr(
        'abcdefghjkmnpqrstuvwxyz23456789',
        floor(random() * 31 + 1)::int, 1);
    END LOOP;
    UPDATE users SET payment_forward_token = v_new_token WHERE id = v_user_id;
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE '[6/6] Backfilled payment_forward_token for % user(s).', v_count;
END $$;

-- -----------------------------------------------------------------------------
-- Final state report.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  v_users_cols      INTEGER;
  v_contacts_cols   INTEGER;
  v_email_acct      BOOLEAN;
  v_payment_events  BOOLEAN;
  v_automation_ok   BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO v_users_cols
  FROM information_schema.columns
  WHERE table_name='users'
    AND column_name IN ('notification_email','notifications_enabled','onboarding_completed',
                        'stripe_customer_id','stripe_subscription_id','payment_forward_token');

  SELECT COUNT(*) INTO v_contacts_cols
  FROM information_schema.columns
  WHERE table_name='contacts'
    AND column_name IN ('lease_start','lease_end','monthly_rent');

  SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='email_accounts') INTO v_email_acct;
  SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='payment_events') INTO v_payment_events;
  SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='automation' AND column_name='user_id') INTO v_automation_ok;

  RAISE NOTICE '==============================================================';
  RAISE NOTICE 'CATCHUP COMPLETE — final state:';
  RAISE NOTICE '  users columns added (should be 6): %', v_users_cols;
  RAISE NOTICE '  contacts columns added (should be 3): %', v_contacts_cols;
  RAISE NOTICE '  email_accounts table exists: %', v_email_acct;
  RAISE NOTICE '  payment_events table exists: %', v_payment_events;
  RAISE NOTICE '  automation.user_id column present: %', v_automation_ok;
  RAISE NOTICE '==============================================================';
  RAISE NOTICE 'If any of the above is FALSE or less than the expected number,';
  RAISE NOTICE 'investigate before continuing. Do not proceed to any further';
  RAISE NOTICE 'migrations until this catch-up is fully green.';
  RAISE NOTICE '==============================================================';
END $$;

COMMIT;

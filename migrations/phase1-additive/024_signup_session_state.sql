-- =====================================================================
-- Phase 1 — 024_signup_session_state.sql
-- =====================================================================
-- Purpose:
--   Schema for Phase B sub-step B2: Stripe Checkout integration. Adds
--   three columns to `workspaces` for subscription tracking and
--   signup-flow attribution, plus two new tables that bridge the
--   multi-minute Stripe redirect flow:
--     - signup_drafts: server-side draft state that survives the
--       Stripe Checkout redirect (which leaves our origin and returns
--       via success/cancel URLs). The B1 sessionStorage approach
--       can't be relied on alone because we need the data on the
--       SERVER when the webhook fires (the user's browser may have
--       closed the tab before the webhook arrives).
--     - stripe_events: idempotent log of webhooks received from
--       Stripe. B2 stores them; B4 orchestrator consumes them to
--       drive account / workspace / Twilio creation.
--
--   First consumers (Phase B sub-step B2):
--     - workspaces.stripe_subscription_id: written by B4 after the
--       Checkout session settles into a real subscription.
--     - workspaces.created_during_signup: written by B4 when the
--       new signup flow creates a workspace (distinguishes from
--       manual A3a-style admin setup or future admin-created
--       workspaces).
--     - workspaces.welcome_email_sent_at: written by B4 when the
--       welcome email dispatches. Idempotency guard against
--       duplicate sends if the webhook is retried.
--     - signup_drafts: written by POST /api/signup/create-checkout-
--       session; read by B4 webhook handler via Stripe's
--       client_reference_id.
--     - stripe_events: written by POST /api/stripe/webhook; read by
--       B4 orchestrator (with processed_at as the consumer marker).
--
--   Future consumers (Phase D — admin tools):
--     - stripe_events retention policy: this table grows
--       monotonically. Add a daily cleanup job that deletes
--       processed_at IS NOT NULL events older than 90 days, or
--       moves them to a cold-storage archive. Tracked as a Phase D
--       item; no enforcement in B2.
--
-- signup_drafts.draft_data SECURITY NOTE:
--   The JSONB column contains a `password_hash` field (bcrypt-hashed
--   at /api/signup/create-checkout-session time). Plaintext password
--   is NEVER stored — it's hashed before INSERT. Treat this column
--   with the same care as users.password_hash for backup, export,
--   and log-redaction purposes. Don't dump raw draft_data values to
--   server logs; redact the password_hash field before any
--   console.log / console.error of the row.
--
-- Indexes:
--   - signup_drafts_expires_at_idx: supports the 24-hour TTL filter
--     on read (only fresh drafts are valid for B4 consumption).
--   - stripe_events_unprocessed_idx: PARTIAL index on received_at
--     WHERE processed_at IS NULL. B4 orchestrator queries "give me
--     the next N unprocessed events" — this index makes that scan
--     fast even as the table grows.
--   - stripe_events.stripe_event_id UNIQUE: prevents duplicate
--     inserts on Stripe webhook retries. Stripe sends the same
--     event ID when retrying a delivery — ON CONFLICT DO NOTHING
--     in the handler turns retries into no-ops.
--
-- Scope note:
--   The `phase1-additive` directory was originally inventory-scoped.
--   020-023 extended it for AI safety + multi-customer schema; 024
--   continues for Phase B Stripe integration. The directory name is
--   a sticky historical label at this point — file content matters
--   more than the path. See 020 header for full context.
--
-- Depends on:  workspaces table (pre-Phase-1, confirmed present on
--              staging-phase1-20260420 and production via existing
--              getWorkspaceId() callers and migration 023's column
--              additions).
-- Enables:     POST /api/signup/create-checkout-session and
--              POST /api/stripe/webhook (B2 endpoints, next commit
--              on this branch). B4 orchestrator (account creation +
--              welcome email + Twilio provisioning, future session).
--
-- Idempotent:  Yes. ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT
--              EXISTS, CREATE INDEX IF NOT EXISTS. Re-runs are no-ops.
-- Reversible:  Per-column ALTER TABLE workspaces DROP COLUMN IF
--              EXISTS for the three new columns; DROP TABLE IF
--              EXISTS signup_drafts; DROP TABLE IF EXISTS
--              stripe_events; DROP INDEX IF EXISTS for both
--              explicit indexes.
--              CAVEATS:
--                - Dropping signup_drafts loses any in-flight
--                  signups within the 24-hour window (rare, but
--                  affected users would need to retry).
--                - Dropping stripe_events loses webhook history;
--                  replay missed events via the Stripe dashboard
--                  or `stripe events resend` CLI if needed.
-- =====================================================================

-- workspaces: signup-flow + subscription attribution columns
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS created_during_signup  BOOLEAN DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS welcome_email_sent_at  TIMESTAMPTZ;

-- signup_drafts: server-side state that survives the Stripe redirect.
-- draft_data.password_hash is bcrypt-hashed — same security treatment
-- as users.password_hash. Plaintext password is NEVER stored here.
CREATE TABLE IF NOT EXISTS signup_drafts (
  id          TEXT PRIMARY KEY,
  draft_data  JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);
CREATE INDEX IF NOT EXISTS signup_drafts_expires_at_idx
  ON signup_drafts (expires_at);

-- stripe_events: idempotent webhook log. B2 INSERTs on every relevant
-- webhook (handler-filtered to checkout.session.* / customer.subscription.*
-- / invoice.payment_*). B4 reads, processes, and sets processed_at to
-- mark consumed. Phase D should add a retention policy — see header.
CREATE TABLE IF NOT EXISTS stripe_events (
  id              SERIAL PRIMARY KEY,
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type      TEXT NOT NULL,
  event_data      JSONB NOT NULL,
  received_at     TIMESTAMPTZ DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS stripe_events_unprocessed_idx
  ON stripe_events (received_at) WHERE processed_at IS NULL;

DO $$
DECLARE
  v_ws_cols       INTEGER;
  v_drafts_table  INTEGER;
  v_events_table  INTEGER;
  v_drafts_idx    INTEGER;
  v_events_idx    INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_ws_cols
  FROM information_schema.columns
  WHERE table_name = 'workspaces'
    AND column_name IN (
      'stripe_subscription_id', 'created_during_signup',
      'welcome_email_sent_at'
    );

  SELECT COUNT(*) INTO v_drafts_table
  FROM information_schema.tables WHERE table_name = 'signup_drafts';

  SELECT COUNT(*) INTO v_events_table
  FROM information_schema.tables WHERE table_name = 'stripe_events';

  SELECT COUNT(*) INTO v_drafts_idx
  FROM pg_indexes WHERE indexname = 'signup_drafts_expires_at_idx';

  SELECT COUNT(*) INTO v_events_idx
  FROM pg_indexes WHERE indexname = 'stripe_events_unprocessed_idx';

  RAISE NOTICE '024: workspaces new cols: % of 3, signup_drafts table: % of 1, stripe_events table: % of 1, signup_drafts idx: % of 1, stripe_events partial idx: % of 1.',
    v_ws_cols, v_drafts_table, v_events_table, v_drafts_idx, v_events_idx;
END $$;

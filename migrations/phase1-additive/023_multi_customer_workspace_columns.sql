-- =====================================================================
-- Phase 1 — 023_multi_customer_workspace_columns.sql
-- =====================================================================
-- Purpose:
--   Schema foundation for multi-customer SaaS support. Adds nine
--   columns to `workspaces` for the workspace's identity (Twilio
--   number, business name, area-code preference) and subscription
--   state (tier, status, lifecycle timestamps). Also re-declares
--   `users.stripe_customer_id` for explicit schema documentation
--   (the column already exists from server.js inline migrate; this
--   declaration is a no-op via IF NOT EXISTS).
--
--   First consumer (Phase A, sub-step A2): the rewritten webhook
--   routing dispatches incoming SMS / voice by the workspace's
--   `twilio_phone_number` filtered on `subscription_status='active'`,
--   replacing the legacy single-tenant `users.twilio_phone_number`
--   lookup.
--
--   Future consumers (Phases B / C / D, future sessions):
--     - Stripe integration writes subscription_tier /
--       subscription_status / canceled_at
--     - Twilio API provisioning writes twilio_phone_sid /
--       twilio_provisioned_at on signup
--     - Cancellation flow writes twilio_released_at when the number
--       is returned to Twilio
--     - Onboarding wizard writes business_name / area_code_preference
--
-- Indexes:
--   - workspaces_twilio_phone_uq: PARTIAL UNIQUE on
--     (twilio_phone_number) WHERE twilio_phone_number IS NOT NULL.
--     Prevents two workspaces from claiming the same Twilio number
--     (data-integrity guard for the new routing path). NULL values
--     are excluded so workspaces without a number coexist freely.
--   - workspaces_subscription_status_idx: regular b-tree on
--     subscription_status to support the routing-time gate
--     "WHERE subscription_status = 'active' AND twilio_phone_number = $1".
--
-- Scope note:
--   The `phase1-additive` directory was originally inventory-scoped.
--   020/021/022 extended it for the AI auto-reply safety layer; 023
--   extends it for multi-customer infrastructure. The directory name
--   is a sticky historical label at this point — file content matters
--   more than the path.
--
-- Subscription status values (informational — enforced at the app
-- layer only, no CHECK constraint per Phase 1 §9.11 convention):
--   Phase A:    'active' is the only value the routing gate accepts.
--               Anything else (NULL, '', etc.) treats the workspace
--               as ineligible for inbound message routing.
--   Phase B:    Stripe integration introduces 'past_due', 'canceled',
--               'trial', and the canonical set is defined there.
--
-- Depends on:  pre-Phase-1 workspaces table (created externally
--              before this repo's first migration; confirmed present
--              on staging-phase1-20260420 and production via the
--              getWorkspaceId() helper at server.js:97 and the 16
--              inventory endpoints that depend on it).
-- Enables:     Phase A sub-step A2 webhook routing rewrite. Also the
--              data side of A3a (manual workspace setup script for
--              Jay's account), which writes initial values into these
--              columns on production before A2's code deploys.
--
-- Idempotent:  Yes. ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
--              EXISTS. Re-runs are no-ops.
-- Reversible:  Per-column ALTER TABLE workspaces DROP COLUMN IF
--              EXISTS plus DROP INDEX IF EXISTS for both indexes.
--              Safe in the schema sense; drops would clobber any
--              data written into the new columns (Twilio numbers,
--              subscription state). Real-prod rollback after data
--              is written should export the affected workspaces
--              rows to JSON / CSV first.
-- =====================================================================

-- workspaces: identity + subscription columns (all nullable, no defaults)
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_phone_number    TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_phone_sid       TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_provisioned_at  TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_released_at     TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_name          TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS area_code_preference   TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_tier      TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS subscription_status    TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS canceled_at            TIMESTAMPTZ;

-- users: stripe customer id. Already exists from server.js inline
-- migrate at startup (~line 535). Re-declared here for explicit
-- schema documentation; ADD COLUMN IF NOT EXISTS makes this a no-op
-- against current DBs, and ensures a fresh DB has it after running
-- only this file.
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT DEFAULT '';

-- Partial unique index: one workspace per Twilio number. Excludes
-- NULLs so workspaces without an assigned number coexist.
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_twilio_phone_uq
  ON workspaces (twilio_phone_number)
  WHERE twilio_phone_number IS NOT NULL;

-- Regular index for the routing-time gate.
CREATE INDEX IF NOT EXISTS workspaces_subscription_status_idx
  ON workspaces (subscription_status);

DO $$
DECLARE
  v_ws_cols      INTEGER;
  v_user_col     INTEGER;
  v_uq_idx       INTEGER;
  v_status_idx   INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_ws_cols
  FROM information_schema.columns
  WHERE table_name = 'workspaces'
    AND column_name IN (
      'twilio_phone_number', 'twilio_phone_sid', 'twilio_provisioned_at',
      'twilio_released_at', 'business_name', 'area_code_preference',
      'subscription_tier', 'subscription_status', 'canceled_at'
    );

  SELECT COUNT(*) INTO v_user_col
  FROM information_schema.columns
  WHERE table_name = 'users' AND column_name = 'stripe_customer_id';

  SELECT COUNT(*) INTO v_uq_idx
  FROM pg_indexes WHERE indexname = 'workspaces_twilio_phone_uq';

  SELECT COUNT(*) INTO v_status_idx
  FROM pg_indexes WHERE indexname = 'workspaces_subscription_status_idx';

  RAISE NOTICE '023: workspaces new columns: % of 9, users.stripe_customer_id: % of 1, twilio_phone_uq idx: % of 1, subscription_status idx: % of 1.',
    v_ws_cols, v_user_col, v_uq_idx, v_status_idx;
END $$;

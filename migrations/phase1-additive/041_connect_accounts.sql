-- =====================================================================
-- E13 — 041_connect_accounts.sql
-- =====================================================================
-- Foundation for Stripe Connect (Express) onboarding. TEST MODE only at
-- this point — these columns track whether a workspace has wired up a
-- connected account capable of accepting card payments. NO charges or
-- payment intents flow through any code referencing these columns yet;
-- that's a future session.
--
-- Columns added to workspaces:
--   stripe_connect_account_id  — acct_xxx returned by stripe.accounts.create
--                                ({type:'express'}); null until the owner
--                                kicks off onboarding.
--   connect_status             — 'not_started' | 'pending' | 'ready' | 'restricted'.
--                                Derived from the connected Account's
--                                charges_enabled + details_submitted flags
--                                by lib/connect-lifecycle.deriveConnectStatus.
--   connect_charges_enabled    — mirrors Account.charges_enabled.
--   connect_details_submitted  — mirrors Account.details_submitted.
--   connect_updated_at         — last time we synced from Stripe.
--
-- The partial index on stripe_connect_account_id supports the webhook
-- lookup path (account.updated arrives with an account id; we look up
-- the workspace by it). Partial WHERE NOT NULL keeps the index small.
-- =====================================================================

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_connect_account_id TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS connect_status            TEXT      NOT NULL DEFAULT 'not_started';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS connect_charges_enabled   BOOLEAN   NOT NULL DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS connect_details_submitted BOOLEAN   NOT NULL DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS connect_updated_at        TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'workspaces_connect_status_check'
       AND table_name = 'workspaces'
  ) THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_connect_status_check
      CHECK (connect_status IN ('not_started', 'pending', 'ready', 'restricted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspaces_stripe_connect_account_id
  ON workspaces(stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

DO $$
DECLARE
  v_cols   INTEGER;
  v_check  INTEGER;
  v_idx    INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_name = 'workspaces'
     AND column_name IN (
       'stripe_connect_account_id', 'connect_status', 'connect_charges_enabled',
       'connect_details_submitted', 'connect_updated_at'
     );
  SELECT COUNT(*) INTO v_check
    FROM information_schema.table_constraints
   WHERE constraint_name = 'workspaces_connect_status_check'
     AND table_name = 'workspaces';
  SELECT COUNT(*) INTO v_idx
    FROM pg_indexes WHERE indexname = 'idx_workspaces_stripe_connect_account_id';
  RAISE NOTICE '041: connect columns: % of 5, CHECK: % of 1, index: % of 1.', v_cols, v_check, v_idx;
END $$;

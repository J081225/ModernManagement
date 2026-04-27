-- =====================================================================
-- scripts/setup_jay_workspace.sql
-- =====================================================================
-- Purpose:
--   One-shot data setup for Jay's existing workspace, run on
--   PRODUCTION via Neon SQL Editor BEFORE the Phase A sub-step A2
--   webhook routing rewrite deploys. Without these column values,
--   Jay's existing inbound SMS / voice flow goes dead the moment
--   A2 lands (the new routing requires a workspace row with both
--   twilio_phone_number set AND subscription_status='active').
--
-- Sequencing in Phase A:
--   1. Migration 023 lands (columns now exist, all NULL)        ← done
--   2. THIS SCRIPT runs on production (populates Jay's workspace)
--   3. A2 webhook code commits + Render auto-deploys
--   4. Smoke test: send a real test SMS to Jay's Twilio number
--   5. If smoke test passes: Phase A complete.
--      If it fails: revert A2 commit, redeploy.
--
-- What this script writes:
--   - twilio_phone_number = Jay's existing inbound Twilio number,
--                           in E.164 format (+1XXXXXXXXXX). Replace
--                           the placeholder below before pasting.
--   - business_name        = 'Modern Management'
--   - subscription_tier    = 'enterprise' (Jay is the operator;
--                            tier is informational only at this
--                            point — Phase B Stripe wiring will
--                            redefine).
--   - subscription_status  = 'active' (the routing gate).
--
-- Owner identification:
--   Jay's user row is identified by username = 'admin' (the seed
--   credential from server.js line 359-365). If you've changed your
--   admin username, update the SELECT in step 2 below.
--
-- Idempotent:
--   Yes. Re-running this script overwrites the same fields with the
--   same values. No-op on second run.
--
-- Reversible:
--   UPDATE workspaces
--      SET twilio_phone_number   = NULL,
--          business_name         = NULL,
--          subscription_tier     = NULL,
--          subscription_status   = NULL
--    WHERE owner_user_id = (SELECT id FROM users WHERE username = 'admin');
--
--   Reverting AFTER A2 has deployed will break Jay's inbound flow
--   (the new routing will reject his Twilio number with a
--   "no active workspace" log). Only revert as part of an A2 rollback.
-- =====================================================================

-- ---------------------------------------------------------------------
-- BEFORE PASTING: replace '+1XXXXXXXXXX' with Jay's real Twilio number.
-- The number must match exactly what's currently in
-- users.twilio_phone_number for the admin row. To check it first,
-- run this read-only query separately:
--     SELECT twilio_phone_number FROM users WHERE username = 'admin';
-- ---------------------------------------------------------------------

UPDATE workspaces
   SET twilio_phone_number  = '+1XXXXXXXXXX',
       business_name        = 'Modern Management',
       subscription_tier    = 'enterprise',
       subscription_status  = 'active'
 WHERE owner_user_id = (SELECT id FROM users WHERE username = 'admin');

-- ---------------------------------------------------------------------
-- Verification: should return exactly 1 row with all four fields set.
-- ---------------------------------------------------------------------

SELECT id              AS workspace_id,
       owner_user_id,
       twilio_phone_number,
       business_name,
       subscription_tier,
       subscription_status
  FROM workspaces
 WHERE owner_user_id = (SELECT id FROM users WHERE username = 'admin');

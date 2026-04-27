-- =====================================================================
-- Phase 1 — 020_add_users_alert_phone.sql
-- =====================================================================
-- Purpose:
--   Add `alert_phone TEXT` to `users` to capture the workspace owner's
--   personal mobile number for safety-alert SMS. This is distinct from
--   `users.twilio_phone_number`, which is the inbound Twilio number
--   the workspace owns (the number tenants text INTO) — not suitable
--   for outbound alerts to the owner themselves.
--
--   First consumer is the AI Auto-Reply Safety Layer (Layer 1).
--   When an incoming tenant message contains an emergency keyword,
--   auto-reply is suppressed and the workspace owner receives an SMS
--   alert at this number. Falls back to email via SendGrid when this
--   column is empty (degrade gracefully — see sub-step B handler).
--
-- Scope note:
--   The `phase1-additive` directory was originally scoped to the
--   Inventory work (files 002–019). 020 / 021 / 022 extend the same
--   numbering scheme on feat/inventory-ui because they ship together
--   on that branch. The CONTENT is the AI auto-reply safety layer,
--   unrelated to inventory.
--
-- Depends on:  001 (users table; pre-Phase-1).
-- Enables:     Layer 1 owner-alert SMS path (sub-step B). Lazy capture
--              via the settings page UI (sub-step C); no forced
--              onboarding step. Empty / NULL is the documented default.
--
-- Idempotent:  Yes. ADD COLUMN IF NOT EXISTS.
-- Reversible:  ALTER TABLE users DROP COLUMN IF EXISTS alert_phone;
--              (Safe: column holds only user contact metadata used for
--              outbound alerts — no operational state, no FK references.)
-- =====================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_phone TEXT;

DO $$
DECLARE
  v_column_present INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_column_present
  FROM information_schema.columns
  WHERE table_name = 'users' AND column_name = 'alert_phone';
  RAISE NOTICE '020: users.alert_phone column present (% of 1).', v_column_present;
END $$;

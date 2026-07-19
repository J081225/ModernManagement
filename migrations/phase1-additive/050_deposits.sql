-- FD3-CP6 — 050_deposits.sql
--
-- Deposit config on the workspace and deposit linkage on appointments
-- (front-desk investigation §5 gap list). Purely additive; every
-- column NULL = "never configured" and the feature ships DORMANT —
-- lib/deposits.js gates activation on live-mode Stripe, which does
-- not exist yet.
--
-- transactions.source gains 'booking_deposit' for the transaction
-- created at booking time to hang the deposit on (§5: "nothing
-- creates one at booking"). Widening a CHECK is additive — existing
-- rows are untouched (same pattern as 047).

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deposit_enabled BOOLEAN;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deposit_mode    TEXT;    -- 'percent' | 'flat'
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deposit_value   INTEGER; -- percent points (1-100) or cents

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_required_cents INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_transaction_id INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_paid_at        TIMESTAMPTZ;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('appointment_completion','walk_in','product_sale','manual','refund','booking_deposit'));

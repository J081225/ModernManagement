-- FD3-CP3 — 048_autonomy_matrix.sql
--
-- Per-category autonomy policy for the CUSTOMER-facing brain
-- (act | approve | off per category). NULL means "use the default",
-- and the code defaults reproduce today's behavior exactly
-- (bookings/contacts/tasks act, payments approve), so a workspace
-- that never opens the matrix is byte-identical.
--
-- pending_actions gains the customer's identity so an approval can
-- close the loop with the person who asked (FD3-CP3 commit 2) — the
-- approve path previously executed silently from the customer's side.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS autonomy_bookings TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS autonomy_contacts TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS autonomy_tasks    TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS autonomy_payments TEXT;

ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS customer_channel TEXT;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS appointment_thread_id INTEGER;

-- IB1 — 052_thread_owner_stamp.sql
--
-- The thread learns when the OWNER last spoke into it. Stamped by the
-- IB1 owner-outbound persistence (lib/outbound-persist.js); nothing
-- reads it yet — it is the data the future per-thread-driver
-- checkpoint will key on (inbox-investigation §7 CP4). Additive.

ALTER TABLE appointment_threads ADD COLUMN IF NOT EXISTS last_owner_message_at TIMESTAMPTZ;

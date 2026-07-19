-- IB4 — 054_thread_driver.sql
--
-- Per-thread driver state: the ONE thing FD3 left global. Additive.
--
-- THE PRECEDENCE RULE: the AI replies to an inbound iff
--   appointment_auto_respond (workspace-global) is ON
--   AND the thread is NOT ai_paused.
-- Global off still means silent everywhere — per-thread pause is a
-- scalpel within global-on, never a way to re-enable a disabled AI.
--
-- BOUNDARY: ai_paused governs the AI's ASYNC voice (SMS, voicemail
-- follow-ups, email). A live ConversationRelay phone call remains
-- AI-answered — there is no human alternative mid-call on the Twilio
-- number; unplugging the phone AI is the global switch's job.
--
-- REOPEN: a closed thread's follow-up creates a NEW thread (CP1), so
-- stickiness is explicit: findOrCreateThread inherits ai_paused (+
-- paused_at/paused_by) from the customer's most recent prior thread.
-- An owner who took a conversation over keeps it until they tap
-- "Let AI resume" — deliberate, visible in the pane, one tap to undo.

ALTER TABLE appointment_threads ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN DEFAULT FALSE;
ALTER TABLE appointment_threads ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE appointment_threads ADD COLUMN IF NOT EXISTS paused_by INTEGER;

-- 044_appointment_threads_add_voice_channel.sql
--
-- Extend the appointment_threads.inbound_channel CHECK constraint to allow
-- 'voice' as a valid channel value.
--
-- Motivation: the live AI voice prototype (Twilio ConversationRelay via
-- the /twilio-relay WebSocket handler in server.js) will, in a later
-- change, call lib/appointment-engine.processInboundMessage with
-- channel='voice' so live phone calls flow through the same appointment-
-- booking brain that SMS / email / voicemail already use. Without this
-- CHECK-constraint widening, findOrCreateThread's INSERT would violate
-- the constraint on the first live voice call to a PS workspace.
--
-- The existing values ('sms','email','voicemail') stay valid — this is a
-- pure superset addition, so no existing rows can fail the new constraint.
--
-- Safe re-run: the DROP uses IF EXISTS, and the constraint name matches
-- the one created in migration 035_appointments.sql (lines 130-134).

DO $$
BEGIN
  -- Drop the old constraint if it exists (created by migration 035).
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
              WHERE constraint_name = 'appointment_threads_channel_check'
                AND table_name = 'appointment_threads') THEN
    ALTER TABLE appointment_threads DROP CONSTRAINT appointment_threads_channel_check;
  END IF;

  -- Re-add the constraint with 'voice' included in the allowed set.
  ALTER TABLE appointment_threads ADD CONSTRAINT appointment_threads_channel_check
    CHECK (inbound_channel IN ('sms', 'email', 'voicemail', 'voice'));
END $$;

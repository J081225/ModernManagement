-- FD3-CP2 — 047_appointment_source_voice.sql
--
-- The appointments.source CHECK (035) had no voice value, so live-call
-- bookings were labeled 'ai_inbound_sms' (front-desk investigation §1
-- delta table, last row). Adds 'ai_inbound_voice'; existing rows are
-- untouched (the constraint only widens).

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_source_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_source_check
  CHECK (source IN ('ai_inbound_sms','ai_inbound_email','ai_inbound_voicemail','ai_inbound_voice',
                    'staff_command_bar','public_booking','walk_in'));

-- Run this IMMEDIATELY AFTER the multi-tenancy merge deploys to production.
-- Without this, all inbound SMS and voicemail to the admin's Twilio number
-- will be dropped (intentional: no WEBHOOK_USER_ID=1 fallback in merged code).
UPDATE users SET twilio_phone_number = '+18555350785' WHERE id = 1;

-- Verify the update succeeded:
SELECT id, username, twilio_phone_number FROM users WHERE id = 1;

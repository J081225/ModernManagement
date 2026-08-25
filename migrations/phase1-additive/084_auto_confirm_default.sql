-- 084: R4 SEAMLESS DEFAULT — autonomous booking confirmation becomes
-- the DEFAULT for NEW workspaces (announced before apply, 2026-08-25).
-- Existing workspaces keep their current setting untouched; "Owner
-- review" remains the opt-in toggle (appointment_auto_confirm=false)
-- in How your Manager works.
ALTER TABLE workspaces ALTER COLUMN appointment_auto_confirm SET DEFAULT TRUE;

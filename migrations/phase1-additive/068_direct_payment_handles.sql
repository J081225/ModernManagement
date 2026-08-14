-- VZ item 1 (pulled forward by the "How you get paid" card redesign):
-- per-workspace Venmo handle + Zelle info for MANUAL-CONFIRM direct
-- payments. These are DISPLAY / REFERENCE strings the owner reconciles
-- by hand — NOT processor credentials, NOT money-moving, no webhook.
-- Unlike the Square token columns (067) there is nothing secret here,
-- so no encryption; unlike payment_processor (066/067) there is no
-- default — NULL means "not set".
--
-- Storage ONLY. The request-integration, QR rendering, and mark-as-paid
-- machinery (VZ items 2-5) stay queued behind SQ5; this migration lands
-- just the fields the settings card persists today.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS venmo_handle TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS zelle_info   TEXT;

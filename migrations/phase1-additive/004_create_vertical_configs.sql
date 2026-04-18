-- =====================================================================
-- Phase 1 — 004_create_vertical_configs.sql
-- =====================================================================
-- Purpose:
--   Create the `vertical_configs` table and seed the `property_management`
--   vertical with its UI labels. This table is the foundation for later
--   UI label abstraction (not part of this migration).
--
-- Depends on: nothing
-- Enables:    later UI work — reads `labels` at render time.
--
-- Idempotent: Yes. Seed uses ON CONFLICT DO NOTHING.
-- Reversible: DROP TABLE IF EXISTS vertical_configs;
-- =====================================================================

CREATE TABLE IF NOT EXISTS vertical_configs (
  vertical_type TEXT PRIMARY KEY,
  labels        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Seed: property_management vertical
INSERT INTO vertical_configs (vertical_type, labels)
VALUES (
  'property_management',
  '{
    "contacts": "Tenants",
    "entities": "Properties",
    "agreements": "Leases",
    "recurring_charges": "Rent Payments",
    "service_requests": "Maintenance Tickets"
  }'::jsonb
)
ON CONFLICT (vertical_type) DO NOTHING;

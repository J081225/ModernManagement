-- =====================================================================
-- Phase 1 — 003_create_agreements.sql
-- =====================================================================
-- Purpose:
--   Create the `agreements` table — generalizes "lease" into a primitive
--   that can also represent memberships, contracts, subscriptions, etc.
--   During Phase 1 this table is populated from `contacts` rows that have
--   non-empty lease fields.
--
-- Depends on: 001 (workspaces), 002 (entities), existing `contacts` table.
-- Enables:    010 (backfill_agreements).
--
-- Column mapping (from contacts to agreements):
--   contacts.id                → agreements.contact_id
--   contacts.user_id           → agreements.workspace_id (via workspaces lookup)
--   contacts.lease_start       → agreements.start_date
--   contacts.lease_end         → agreements.end_date
--   contacts.monthly_rent      → agreements.monthly_amount
--   (constant 'lease')         → agreements.agreement_type
--
-- Idempotent: Yes. Safe to re-run.
-- Reversible: DROP TABLE IF EXISTS agreements CASCADE;
-- =====================================================================

CREATE TABLE IF NOT EXISTS agreements (
  id              SERIAL PRIMARY KEY,
  workspace_id    INTEGER NOT NULL,
  entity_id       INTEGER,
  contact_id      INTEGER NOT NULL,
  agreement_type  TEXT NOT NULL DEFAULT 'lease',
  start_date      DATE,
  end_date        DATE,
  monthly_amount  NUMERIC(10,2) DEFAULT 0,
  status          TEXT DEFAULT 'active',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agreements_workspace_id_idx ON agreements(workspace_id);
CREATE INDEX IF NOT EXISTS agreements_contact_id_idx   ON agreements(contact_id);
CREATE INDEX IF NOT EXISTS agreements_end_date_idx     ON agreements(end_date);
CREATE INDEX IF NOT EXISTS agreements_agreement_type_idx ON agreements(agreement_type);

-- Uniqueness: one active agreement per (contact_id, agreement_type) is
-- a reasonable business rule, but not enforced yet because historical
-- contacts may have had multiple overlapping leases. Revisit post-Phase 3.

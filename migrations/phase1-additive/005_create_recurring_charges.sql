-- =====================================================================
-- Phase 1 — 005_create_recurring_charges.sql
-- =====================================================================
-- Purpose:
--   Create `recurring_charges` — the generalized successor to
--   `rent_payments`. Adds `charge_type` (default 'rent'), `workspace_id`,
--   `contact_id`, and a `legacy_id` column that records the source
--   rent_payments.id for traceability during the migration.
--
-- Depends on: 001 (workspaces), existing `rent_payments` table, existing
--             `contacts` table.
-- Enables:    011 (backfill_recurring_charges), and eventually all
--             /api/rent/* route cutovers in Phase 2.
--
-- Column mapping (to be applied in 011):
--   rent_payments.id            → recurring_charges.legacy_id
--   rent_payments.user_id       → recurring_charges.user_id
--   rent_payments.resident      → recurring_charges.payer_name
--   rent_payments.unit          → recurring_charges.unit
--   rent_payments.amount        → recurring_charges.amount
--   rent_payments.due_date      → recurring_charges.due_date (cast TEXT→DATE)
--   rent_payments.status        → recurring_charges.status
--   rent_payments.notes         → recurring_charges.notes
--   rent_payments.paid_date     → recurring_charges.paid_date (cast TEXT→DATE)
--   rent_payments."createdAt"   → recurring_charges.created_at
--   (constant 'rent')           → recurring_charges.charge_type
--
-- Idempotent: Yes. Unique index on legacy_id prevents dup inserts.
-- Reversible: DROP TABLE IF EXISTS recurring_charges CASCADE;
-- =====================================================================

CREATE TABLE IF NOT EXISTS recurring_charges (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL DEFAULT 1,
  workspace_id   INTEGER,
  contact_id     INTEGER,
  charge_type    TEXT NOT NULL DEFAULT 'rent',
  payer_name     TEXT NOT NULL DEFAULT '',
  unit           TEXT DEFAULT '',
  amount         NUMERIC(10,2) NOT NULL,
  due_date       DATE,
  status         TEXT DEFAULT 'pending',
  notes          TEXT DEFAULT '',
  paid_date      DATE,
  legacy_id      INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS recurring_charges_user_id_idx      ON recurring_charges(user_id);
CREATE INDEX IF NOT EXISTS recurring_charges_workspace_id_idx ON recurring_charges(workspace_id);
CREATE INDEX IF NOT EXISTS recurring_charges_due_date_idx     ON recurring_charges(due_date);
CREATE INDEX IF NOT EXISTS recurring_charges_status_idx       ON recurring_charges(status);
CREATE INDEX IF NOT EXISTS recurring_charges_charge_type_idx  ON recurring_charges(charge_type);

-- Unique index enables ON CONFLICT (legacy_id) DO NOTHING in 011.
CREATE UNIQUE INDEX IF NOT EXISTS recurring_charges_legacy_id_uq
  ON recurring_charges(legacy_id)
  WHERE legacy_id IS NOT NULL;

-- BG2 — 057_expenses.sql
--
-- The money-out foundation (finances-investigation §2: the arc's
-- biggest new build). Workspace-scoped INTEGER CENTS per the 055
-- boundary decision — this is the real feed BG1's summary wired at 0.
--
-- Categories start as a small fixed set (lib/expenses.js
-- EXPENSE_CATEGORIES: Supplies, Payroll, Rent, Utilities, Marketing,
-- Fees, Other), extendable later; free-text description carries the
-- specifics. source says who posted it: 'manual' (owner entry, BG2),
-- 'ai_confirmed' (the brain's did-this-come-out flow, BG5),
-- 'invoice' (the paid-bill bridge, BG2 commit 5 — invoice_id set,
-- amount converted ×100 from the legacy dollar invoice at bridge
-- time). contact_id links vendors that are known contacts.

CREATE TABLE IF NOT EXISTS expenses (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category     TEXT NOT NULL DEFAULT 'Other',
  description  TEXT,
  vendor       TEXT,
  contact_id   INTEGER,
  spent_on     DATE NOT NULL,
  source       TEXT NOT NULL DEFAULT 'manual',
  invoice_id   INTEGER,
  receipt_url  TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'expenses_source_check' AND table_name = 'expenses'
  ) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_source_check
      CHECK (source IN ('manual', 'ai_confirmed', 'invoice'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_expenses_workspace_spent_on
  ON expenses(workspace_id, spent_on DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_workspace_category
  ON expenses(workspace_id, category);

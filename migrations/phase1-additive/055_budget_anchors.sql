-- BG1 — 055_budget_anchors.sql
--
-- Cash-on-hand anchors (finances-investigation §6): the owner's
-- counted baseline. HISTORY, not a column — re-anchoring INSERTS a
-- new row (the reconciliation trail is itself an insight source);
-- the current anchor is the most recent by as_of. Current cash is
-- DERIVED on read: anchor.amount_cents + money-in AFTER as_of −
-- money-out AFTER as_of (half-open at as_of — events at or before
-- the count are inside the drawer by definition; nothing
-- double-counts).
--
-- BOUNDARY DECISION (§8-CP0), binding for the whole budget arc: all
-- NEW budget money is workspace-scoped INTEGER CENTS. Legacy PM
-- tables (budget_transactions, rent_payments — user-scoped NUMERIC
-- dollars) are READ-THROUGH feeds only, converted ×100 at read and
-- labeled legacy; the new system NEVER writes or migrates them.

CREATE TABLE IF NOT EXISTS budget_anchors (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  as_of        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  set_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_anchors_workspace_asof
  ON budget_anchors(workspace_id, as_of DESC);

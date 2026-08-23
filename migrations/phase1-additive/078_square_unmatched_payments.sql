-- SQW2 (walk-in capture, lane 2). ANNOUNCED in docs/sqw-investigation.md
-- §3.5; created on the R2 "proceed" ruling (2026-08-23).
--
-- The isolated tray for Square payments the ledger refused to complete
-- (no_order_id / no_ledger_row — counter taps, Virtual Terminal sales,
-- anything not one of OUR orders). Same isolation philosophy as
-- square_refunds: this table is NEVER summed into revenue. Money enters
-- the books only when a row is recorded (one-tap or auto-record), which
-- creates an ordinary transactions + transaction_payments pair through
-- the normal seam and links back here via transaction_id.
--
-- raw_payload keeps the ENTIRE Square payment object — the evidence that
-- could previously only be read from the Render log. Every future
-- question about payload shape is answered by a row, not a log search.
CREATE TABLE IF NOT EXISTS square_unmatched_payments (
  id                   SERIAL PRIMARY KEY,
  workspace_id         INTEGER NOT NULL,
  square_payment_id    TEXT NOT NULL,
  square_order_id      TEXT,
  merchant_id          TEXT,
  location_id          TEXT,
  refusal_reason       TEXT NOT NULL,                 -- no_order_id | no_ledger_row
  amount_cents         INTEGER NOT NULL,
  tip_cents            INTEGER NOT NULL DEFAULT 0,
  total_cents          INTEGER NOT NULL,
  currency             TEXT NOT NULL DEFAULT 'USD',
  source_type          TEXT,
  entry_method         TEXT,
  card_brand           TEXT,
  last_4               TEXT,
  square_product       TEXT,
  application_id       TEXT,
  device_name          TEXT,
  receipt_number       TEXT,
  receipt_url          TEXT,
  note                 TEXT,
  paid_at              TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'unrecorded'
                         CHECK (status IN ('unrecorded', 'recorded', 'dismissed', 'refunded')),
  dismiss_reason       TEXT,
  transaction_id       INTEGER,
  recorded_by_user_id  INTEGER,
  recorded_via         TEXT CHECK (recorded_via IS NULL OR recorded_via IN ('one_tap', 'auto', 'ref_match')),
  raw_payload          JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency anchor: Square redelivers webhooks; one payment = one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sq_unmatched_payment ON square_unmatched_payments (square_payment_id);
CREATE INDEX IF NOT EXISTS idx_sq_unmatched_ws_status ON square_unmatched_payments (workspace_id, status);

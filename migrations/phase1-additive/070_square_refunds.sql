-- SQ5: real money-moving Square refunds.
--
-- (1) Capture the Square payment_id at completion so a refund can target
--     it (RefundPayment refunds a PAYMENT, not an order). Existing paid
--     rows (e.g. #6, paid before this) have NULL here — the refund path
--     resolves + VERIFIES it from Square by order_id as a fallback
--     (matching order_id + the merchant-scoped token before any refund).
ALTER TABLE transaction_payments ADD COLUMN IF NOT EXISTS square_payment_id TEXT;

-- (2) Square refund state, DELIBERATELY ISOLATED from the payment rollup.
--     finances-summary sums transaction_payments.amount_cents for revenue
--     and renders each row as a ledger line, so a refund row THERE would
--     corrupt the revenue math (money guardrail). Instead: the refund's
--     reporting artifact stays the existing record-only refund CHILD
--     transaction (source='refund', negative total) — created only when
--     the money actually moves — and THIS table tracks only the Square
--     API money-movement + idempotency. status: pending -> completed
--     (refund.updated COMPLETED) / failed. Idempotency anchor: the unique
--     square_refund_id (SP4c redelivery pattern).
CREATE TABLE IF NOT EXISTS square_refunds (
  id                          SERIAL PRIMARY KEY,
  workspace_id                INTEGER NOT NULL,
  transaction_id              INTEGER NOT NULL,
  refund_child_transaction_id INTEGER,
  square_refund_id            TEXT NOT NULL,
  square_payment_id           TEXT,
  amount_cents                INTEGER NOT NULL,
  currency                    TEXT NOT NULL DEFAULT 'USD',
  status                      TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'completed', 'failed')),
  reason                      TEXT,
  created_by_user_id          INTEGER,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_square_refunds_refund_id ON square_refunds (square_refund_id);
CREATE INDEX IF NOT EXISTS idx_square_refunds_txn ON square_refunds (transaction_id);

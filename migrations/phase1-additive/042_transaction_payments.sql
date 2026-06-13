-- =====================================================================
-- E14 — 042_transaction_payments.sql
-- =====================================================================
-- Customer-payment ledger. Each row records ONE payment against a
-- transaction — cash, card, Stripe Checkout, anything. The transactions
-- table's amount_paid_cents and status become rollups derived from this
-- ledger by lib/payment-ledger.recomputeTransactionPaidStatus, never
-- written directly anymore. Unifies the three pre-E14 payment flows
-- (complete_appointment, create_transaction, complete_transaction) so
-- there is exactly one mechanism for recording money.
--
-- Lifecycle:
--   - Cash / Venmo / Zelle / etc. (manual): row inserted with
--     status='completed' directly. Subsequent recompute reflects it.
--   - Stripe Checkout (online card): row inserted with status='pending'
--     when the Checkout Session is created. Flipped to 'completed' by
--     the checkout.session.completed (or checkout.session.async_payment_*)
--     webhook handler. The unique partial index on
--     stripe_checkout_session_id is what keeps webhook retries idempotent.
--
-- payment_type:
--   'deposit'  — partial advance taken at booking / before service.
--   'payment'  — the main payment for the service / product.
--   Distinction is for UX + reporting only; the rollup treats them
--   identically. Refunds remain modeled as child transactions
--   (parent_transaction_id) with negative totals — they are NOT a row
--   in this ledger.
--
-- payment_method values mirror the existing transactions.payment_method
-- vocabulary plus 'stripe' for the online-card path. Kept as an enum so
-- the rollup and reporting can branch confidently.
-- =====================================================================

CREATE TABLE IF NOT EXISTS transaction_payments (
  id                          SERIAL PRIMARY KEY,
  workspace_id                INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  transaction_id              INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount_cents                INTEGER NOT NULL,
  payment_type                TEXT    NOT NULL,
  payment_method              TEXT    NOT NULL,
  stripe_checkout_session_id  TEXT,
  status                      TEXT    NOT NULL DEFAULT 'completed',
  notes                       TEXT,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  created_by_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'transaction_payments_payment_type_check'
       AND table_name = 'transaction_payments'
  ) THEN
    ALTER TABLE transaction_payments ADD CONSTRAINT transaction_payments_payment_type_check
      CHECK (payment_type IN ('deposit', 'payment'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'transaction_payments_payment_method_check'
       AND table_name = 'transaction_payments'
  ) THEN
    ALTER TABLE transaction_payments ADD CONSTRAINT transaction_payments_payment_method_check
      CHECK (payment_method IN ('cash', 'card', 'venmo', 'zelle', 'gift_card', 'stripe', 'other'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'transaction_payments_status_check'
       AND table_name = 'transaction_payments'
  ) THEN
    ALTER TABLE transaction_payments ADD CONSTRAINT transaction_payments_status_check
      CHECK (status IN ('pending', 'completed', 'failed'));
  END IF;
END $$;

-- All rollup queries land here. Covers the recompute helper's hot path:
-- SELECT SUM(amount_cents) ... WHERE transaction_id = $1 AND status = 'completed'.
CREATE INDEX IF NOT EXISTS idx_transaction_payments_transaction_id
  ON transaction_payments(transaction_id);

-- Idempotency for the Stripe Checkout path: Stripe retries the same
-- session id; second INSERT must collide and bail. Partial WHERE keeps
-- the index small (manual payments have NULL session ids).
CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_payments_stripe_session_id_uq
  ON transaction_payments(stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

DO $$
DECLARE
  v_table_present INTEGER;
  v_checks        INTEGER;
  v_idxs          INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_table_present FROM information_schema.tables
    WHERE table_name = 'transaction_payments';
  SELECT COUNT(*) INTO v_checks FROM information_schema.table_constraints
    WHERE table_name = 'transaction_payments'
      AND constraint_name IN (
        'transaction_payments_payment_type_check',
        'transaction_payments_payment_method_check',
        'transaction_payments_status_check'
      );
  SELECT COUNT(*) INTO v_idxs FROM pg_indexes
    WHERE indexname IN (
      'idx_transaction_payments_transaction_id',
      'idx_transaction_payments_stripe_session_id_uq'
    );
  RAISE NOTICE '042: transaction_payments table: % of 1, CHECK constraints: % of 3, indexes: % of 2.',
    v_table_present, v_checks, v_idxs;
END $$;

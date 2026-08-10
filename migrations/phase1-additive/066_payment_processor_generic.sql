-- SQ2: generalize the payment ledger from Stripe-specific to
-- processor-agnostic, so Square (and any future processor) enters the
-- SAME transaction_payments table through one idempotency anchor.
--
-- The old stripe_checkout_session_id stays for now (a later cleanup
-- checkpoint drops it once no reader references it) — this migration
-- is purely additive so the entire existing Stripe path keeps working
-- while the code seam moves over it.

-- 1) The generic processor + reference pair.
ALTER TABLE transaction_payments
  ADD COLUMN IF NOT EXISTS processor TEXT NOT NULL DEFAULT 'stripe';

ALTER TABLE transaction_payments
  ADD COLUMN IF NOT EXISTS processor_ref TEXT;

-- 2) Backfill: every existing online row is a Stripe checkout session.
--    processor already defaults 'stripe'; carry the session id across
--    as the generic reference.
UPDATE transaction_payments
   SET processor_ref = stripe_checkout_session_id
 WHERE processor_ref IS NULL
   AND stripe_checkout_session_id IS NOT NULL;

-- 3) processor is CHECK-constrained to the known set.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transaction_payments_processor_valid') THEN
    ALTER TABLE transaction_payments
      ADD CONSTRAINT transaction_payments_processor_valid
      CHECK (processor IN ('stripe', 'square'));
  END IF;
END $$;

-- 4) The idempotency anchor: (processor, processor_ref) is unique when
--    a ref exists. This is the multi-processor successor to migration
--    042's unique index on stripe_checkout_session_id — a duplicate
--    webhook for either processor still can't double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_payments_processor_ref
  ON transaction_payments (processor, processor_ref)
  WHERE processor_ref IS NOT NULL;

-- 5) payment_method gains 'square' (dormant until SQ4 writes it) so the
--    method enum is ready when Square payments land.
DO $$
BEGIN
  ALTER TABLE transaction_payments DROP CONSTRAINT IF EXISTS transaction_payments_payment_method_check;
  ALTER TABLE transaction_payments
    ADD CONSTRAINT transaction_payments_payment_method_check
    CHECK (payment_method IN ('cash', 'card', 'venmo', 'zelle', 'gift_card', 'stripe', 'square', 'other'));
END $$;

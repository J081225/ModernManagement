-- SQW6 (launch side): "Charge in person" — the POS deep link's return
-- callback stores the Square transaction id it hands back, as the BELT
-- beside the note-based match (§6.2 of the investigation): if the
-- merchant edits or strips the note in POS before tapping, the stored
-- id still correlates the resulting payment to this transaction.
-- (VERIFY on the R10 device test: the POS API's returned transaction_id
-- is documented as the v2 ORDER id — if confirmed it equals
-- payment.order_id directly.)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS square_pos_transaction_id TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_sq_pos ON transactions (square_pos_transaction_id) WHERE square_pos_transaction_id IS NOT NULL;

-- SQW4: merchant-side refunds of walk-ins. A refund the OWNER starts in
-- Modern Management already has a square_refunds row before Square
-- confirms it (SQ5). A refund the merchant issues inside the Square app
-- / dashboard arrives with NO row — today it dies as no_refund_row.
-- SQW4 correlates it by payment_id to a recorded walk-in, creates the
-- row, and lets the EXISTING completion core settle it (three-way
-- verify, child transaction, parent ratchet, G2). initiated_by records
-- which side started it; everything else about the row is identical.
ALTER TABLE square_refunds ADD COLUMN IF NOT EXISTS initiated_by TEXT NOT NULL DEFAULT 'owner';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'square_refunds_initiated_by_valid') THEN
    ALTER TABLE square_refunds ADD CONSTRAINT square_refunds_initiated_by_valid
      CHECK (initiated_by IN ('owner', 'square'));
  END IF;
END $$;

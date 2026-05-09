-- E3: Transactions table for professional services workspaces.
--
-- Records every dollar that changes hands. Workspace-scoped, snake_case.
-- Line items stored as JSONB to allow multiple services/products per transaction
-- without a separate line_items table. Refunds are new transactions linked
-- to parent_transaction_id (audit-trail-preserving — original is never edited).
--
-- Lifecycle:
--   draft → pending → paid (or partially_paid, unpaid, refunded, voided)
--
-- Source values:
--   appointment_completion - auto-created when an appointment is marked complete
--   walk_in                - manually created for a customer not on file
--   product_sale           - manual product-only sale
--   manual                 - manual creation by Sarah for any other reason
--   refund                 - linked refund transaction (parent_transaction_id is set)

CREATE TABLE IF NOT EXISTS transactions (
  id                       SERIAL PRIMARY KEY,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id               INTEGER, -- nullable for walk-ins; soft FK to user_id-scoped contacts
  appointment_id           INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  parent_transaction_id    INTEGER REFERENCES transactions(id) ON DELETE SET NULL,

  -- Customer label for display (always populated, even for walk-ins as "Walk-in")
  customer_display_name    TEXT NOT NULL,

  -- Line items: array of { description, quantity, unit_price_cents, total_cents, type ('service'|'product'|'addon'|'fee'|'other') }
  line_items               JSONB NOT NULL DEFAULT '[]'::jsonb,

  subtotal_cents           INTEGER NOT NULL DEFAULT 0,
  tax_cents                INTEGER NOT NULL DEFAULT 0,
  tip_cents                INTEGER NOT NULL DEFAULT 0,
  discount_cents           INTEGER NOT NULL DEFAULT 0,
  total_cents              INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents        INTEGER NOT NULL DEFAULT 0,
  amount_refunded_cents    INTEGER NOT NULL DEFAULT 0,

  payment_method           TEXT, -- cash | card | venmo | zelle | gift_card | other | unpaid
  payment_received_at      TIMESTAMPTZ,

  status                   TEXT NOT NULL DEFAULT 'draft',
  notes_internal           TEXT,
  notes_customer           TEXT,

  -- Receipt tracking
  receipt_sent_via         TEXT, -- email | sms | none (where 'none' means generated but not sent)
  receipt_sent_at          TIMESTAMPTZ,
  receipt_html             TEXT, -- generated receipt HTML, persisted for resend

  -- Refund-specific
  refund_reason            TEXT,

  source                   TEXT NOT NULL DEFAULT 'manual',
  created_by_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,

  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),
  voided_at                TIMESTAMPTZ,
  voided_by_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  void_reason              TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='transactions_status_check' AND table_name='transactions') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_status_check
      CHECK (status IN ('draft','pending','paid','partially_paid','unpaid','refunded','voided'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='transactions_source_check' AND table_name='transactions') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
      CHECK (source IN ('appointment_completion','walk_in','product_sale','manual','refund'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='transactions_payment_method_check' AND table_name='transactions') THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('cash','card','venmo','zelle','gift_card','other','unpaid'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_workspace_created_at ON transactions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_workspace_status ON transactions(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_transactions_contact_id ON transactions(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_appointment_id ON transactions(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_parent_transaction_id ON transactions(parent_transaction_id) WHERE parent_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_workspace_payment_received_at ON transactions(workspace_id, payment_received_at DESC) WHERE payment_received_at IS NOT NULL;

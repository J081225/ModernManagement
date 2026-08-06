-- ST5a: the customer-facing language for the workspace's AI.
-- Ruled launch list: English (default) + Spanish ONLY — the CHECK
-- enforces the honesty rule at the database (a language we can't
-- claim can't be stored; a new language is an additive migration
-- widening this constraint, which forces the claim decision).
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS customer_language TEXT NOT NULL DEFAULT 'en';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_customer_language_valid'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_customer_language_valid
      CHECK (customer_language IN ('en', 'es'));
  END IF;
END $$;

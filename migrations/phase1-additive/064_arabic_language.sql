-- ST7a: Arabic joins the ruled language set (owner priority: Dearborn
-- MI). The CHECK widens en/es -> en/es/ar — the claim decision made
-- explicitly, per the census design (CL1 forces every canned string
-- to declare its ar variant before the suite passes again).
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_customer_language_valid;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_customer_language_valid
  CHECK (customer_language IN ('en', 'es', 'ar'));

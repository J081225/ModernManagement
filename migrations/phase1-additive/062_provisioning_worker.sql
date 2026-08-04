-- SP4a: the async provisioning worker's bookkeeping. Additive only.
--
-- twilio_next_attempt_at: the sweep's time gate — the worker claims a
-- row by moving this forward, which also makes the on-commit kick and
-- the 1-minute sweep concurrency-safe (only one claimant wins).
--
-- area_code_backup_preference: the seam deletes the signup draft at
-- commit (data minimization, unchanged), but the worker retries AFTER
-- the draft is gone — so the customer's backup area code must live on
-- the workspace alongside the existing area_code_preference, or rung 2
-- of the fallback chain would be lost to every retry.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS twilio_next_attempt_at TIMESTAMPTZ;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS area_code_backup_preference TEXT;

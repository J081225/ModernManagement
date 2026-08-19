-- LANG Phase 1 unit 3: per-conversation language. A conversation carries
-- its OWN language (set at thread creation from the session language —
-- e.g. the voice menu's DTMF pin — or the workspace primary at the
-- time). Canned strings that follow a conversation (receipts, payment
-- links) read THIS, not the workspace default, so a caller who pressed
-- 2 for Spanish gets a Spanish receipt from an English-primary shop.
-- NULL = legacy threads; readers fall back to the workspace primary.
ALTER TABLE appointment_threads ADD COLUMN IF NOT EXISTS language TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointment_threads_language_valid'
  ) THEN
    ALTER TABLE appointment_threads
      ADD CONSTRAINT appointment_threads_language_valid
      CHECK (language IS NULL OR language IN ('en', 'es', 'ar'));
  END IF;
END $$;

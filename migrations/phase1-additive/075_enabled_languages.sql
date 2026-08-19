-- Language architecture Phase 1 (Track B, 2026-08-19): customer_language
-- becomes the PRIMARY language and workspaces gain an ENABLED set.
--
--   - enabled_languages: the verified languages this workspace serves.
--     Same CHECK discipline as 063/064: only the ruled set may be stored
--     (en/es/ar — three copies of the list: DB CHECK, endpoint,
--     lib/customer-strings.LANGUAGES, pinned to each other by the suite).
--   - customer_language (unchanged column) = the PRIMARY: the default a
--     conversation starts in, and must be a member of the enabled set.
--   - Backfill: every existing workspace's set is exactly its current
--     primary — behavior-identical until an owner enables a second
--     language. The voice keypress menu (unit 2) keys off set size.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS enabled_languages TEXT[] NOT NULL DEFAULT ARRAY['en']::TEXT[];

UPDATE workspaces SET enabled_languages = ARRAY[customer_language]
  WHERE NOT (customer_language = ANY(enabled_languages));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_enabled_languages_valid'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_enabled_languages_valid
      CHECK (enabled_languages <@ ARRAY['en', 'es', 'ar']::TEXT[]);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_primary_in_enabled'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_primary_in_enabled
      CHECK (customer_language = ANY(enabled_languages));
  END IF;
END $$;

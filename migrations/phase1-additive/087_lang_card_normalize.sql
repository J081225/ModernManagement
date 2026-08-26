-- 087: LANG-CARD — the settings card is ONE "Starting language"
-- control and the mid-call switch tool covers ALL voice-ready
-- languages, so enabled_languages is no longer consulted by any
-- reader. Normalize the vestigial column to [primary] on every
-- existing row so stored state matches the new model (the 075 CHECKs
-- remain satisfied). Announced before apply, 2026-08-26.
UPDATE workspaces SET enabled_languages = ARRAY[COALESCE(customer_language, 'en')];

-- 086: GREET-BY-NAME — expression index backing the caller-number
-- contact lookup on the RING-ANSWER path (and FD1's existing booking
-- lookup, which used the same expression unindexed). Announced before
-- apply, 2026-08-25.
CREATE INDEX IF NOT EXISTS idx_contacts_user_phone10
  ON contacts (user_id, RIGHT(regexp_replace(phone, '\D', '', 'g'), 10));

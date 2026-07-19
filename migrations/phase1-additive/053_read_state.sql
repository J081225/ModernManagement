-- IB2 — 053_read_state.sql
--
-- Read-state for the inbox. THE DEFINITION: a message is UNREAD iff
-- direction = 'inbound' AND read_at IS NULL. Owner/ai/system rows are
-- never unread (you wrote or approved them); unlinked legacy rows
-- (direction IS NULL) are exempt by the definition, not eternally
-- unread. The legacy messages.status field is untouched.
--
-- The partial index serves the badge query (COUNT of conversations
-- containing unread) — it covers exactly the unread rows and nothing
-- else, so it stays tiny.
--
-- ONE-TIME AMNESTY: every historical inbound row is marked read at
-- migration time. Everything the owner has already lived with must
-- not become "47 unread" on deploy morning — unread starts counting
-- from this moment forward.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_unread
  ON messages(user_id) WHERE direction = 'inbound' AND read_at IS NULL;

UPDATE messages SET read_at = NOW()
 WHERE direction = 'inbound' AND read_at IS NULL;

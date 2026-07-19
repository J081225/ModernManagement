-- IB1 — 051_message_linkage.sql
--
-- messages learns its thread, contact, direction, and author
-- (inbox-investigation §1/§7-first: the table is flat and unlinked;
-- every conversation feature needs rows that join). Purely additive —
-- NULLs mean "written before IB1" and every existing reader renders
-- exactly as today.
--
--   direction: 'inbound' | 'outbound'
--   sent_by:   'customer' | 'ai' | 'owner' | 'system'
--     ai     = AI-authored content (engine replies, approved AI sends)
--     owner  = owner-typed content (reply boxes, broadcasts)
--     system = templated notices (approval outcomes, links, receipts)

ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id  INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS contact_id INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS direction  TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by    TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_thread_id
  ON messages(thread_id) WHERE thread_id IS NOT NULL;

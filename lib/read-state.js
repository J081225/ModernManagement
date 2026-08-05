// lib/read-state.js — IB2.
//
// THE definition (also stated in migration 053): a message is UNREAD
// iff direction = 'inbound' AND read_at IS NULL. Owner/ai/system rows
// are never unread (you wrote or approved them); unlinked legacy rows
// (direction IS NULL) are exempt, not eternally unread. The legacy
// messages.status field is untouched — its readers keep reading it.
//
// Marking happens server-side on the fetch-detail path: the act of
// seeing IS the marking; there is no separate client call to forget.
// Opening a message that belongs to a thread marks the WHOLE
// conversation's inbound rows (the list is flat, but reading is
// conversation-shaped); a threadless row (PM email, voice transcript
// before linkage) marks itself.

async function markReadOnFetch({ db, userId, message }) {
  if (!message || message.direction !== 'inbound' || message.read_at) return 0;
  try {
    let r;
    if (message.thread_id) {
      r = await db.query(
        `UPDATE messages SET read_at = NOW()
          WHERE user_id = $1 AND thread_id = $2
            AND direction = 'inbound' AND read_at IS NULL`,
        [userId, message.thread_id]
      );
    } else {
      r = await db.query(
        `UPDATE messages SET read_at = NOW()
          WHERE id = $1 AND user_id = $2
            AND direction = 'inbound' AND read_at IS NULL`,
        [message.id, userId]
      );
    }
    return r.rowCount || 0;
  } catch (err) {
    (console).error('[read-state] mark failed (message still served):', err.message);
    return 0;
  }
}

// Gmail's arithmetic: the badge counts CONVERSATIONS containing
// unread, not raw rows — a thread with three unheard texts is one
// thing to deal with. RS7 fix: the grouping grammar is EXACTLY the
// list's (conversationKeyOf: thread → contact → id), so threadless-
// but-contact-linked rows fold into one conversation per customer
// and the badge can never disagree with the list. One query, served
// by the partial index idx_messages_unread (migration 053).
async function unreadConversationCount({ db, userId }) {
  try {
    const r = await db.query(
      `SELECT COUNT(DISTINCT COALESCE('t' || thread_id::text, 'c' || contact_id::text, 'm' || id::text))::int AS n
         FROM messages
        WHERE user_id = $1 AND folder = 'inbox'
          AND direction = 'inbound' AND read_at IS NULL`,
      [userId]
    );
    return r.rows[0] ? r.rows[0].n : 0;
  } catch (err) {
    (console).error('[read-state] count failed:', err.message);
    return 0;
  }
}

// IB3: mark a whole conversation group read on open. Key grammar
// matches the grouped-list endpoint: 't<threadId>' | 'c<contactId>'
// (threadless rows of a contact) | 'm<messageId>' (unlinked single).
async function markGroupRead({ db, userId, key }) {
  try {
    const kind = String(key || '')[0];
    const id = parseInt(String(key || '').slice(1), 10);
    if (!id) return 0;
    let r;
    if (kind === 't') {
      r = await db.query(
        "UPDATE messages SET read_at = NOW() WHERE user_id = $1 AND thread_id = $2 AND direction = 'inbound' AND read_at IS NULL",
        [userId, id]
      );
    } else if (kind === 'c') {
      r = await db.query(
        "UPDATE messages SET read_at = NOW() WHERE user_id = $1 AND contact_id = $2 AND thread_id IS NULL AND direction = 'inbound' AND read_at IS NULL",
        [userId, id]
      );
    } else if (kind === 'm') {
      r = await db.query(
        "UPDATE messages SET read_at = NOW() WHERE user_id = $1 AND id = $2 AND direction = 'inbound' AND read_at IS NULL",
        [userId, id]
      );
    } else return 0;
    return r.rowCount || 0;
  } catch (err) {
    (console).error('[read-state] group mark failed (conversation still served):', err.message);
    return 0;
  }
}

module.exports = { markReadOnFetch, unreadConversationCount, markGroupRead };

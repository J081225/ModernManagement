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
// thing to deal with. Threaded rows group by thread_id; threadless
// rows each count as their own conversation. One query, served by the
// partial index idx_messages_unread (migration 053).
async function unreadConversationCount({ db, userId }) {
  try {
    const r = await db.query(
      `SELECT COUNT(DISTINCT COALESCE('t' || thread_id::text, 'm' || id::text))::int AS n
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

module.exports = { markReadOnFetch, unreadConversationCount };

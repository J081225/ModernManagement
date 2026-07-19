// lib/voice-transcript.js — FD3-CP1.
//
// Persists live voice calls into the messages table AS THEY HAPPEN —
// one row per call, appended turn by turn, so a dropped socket loses
// nothing already said. Follows the SMS convention (messages table,
// phone-keyed, folder 'inbox'); category='voice' distinguishes the
// channel. One row per call (not per turn) so a 3-minute conversation
// is one inbox entry, not forty.
//
// The thread's context_summary keeps updating separately — it has
// other readers (engine prompt, PS dashboard) — but after this module
// it is no longer the only record of what was said.
//
// Lives in lib/ (not inline in server.js) so the persistence path is
// testable without booting the HTTP server.

const PLACEHOLDER = '📞 Live call in progress…';

// Creates the call's transcript row at call setup. Returns the row id
// the WS handler appends to for the rest of the call.
async function beginCallTranscript(db, { userId, callSid, phone }) {
  const r = await db.query(
    `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone, direction, sent_by)
     VALUES ($1, $2, $3, 'voice', $4, 'new', 'inbox', $5, 'inbound', 'customer')
     RETURNING id`,
    [
      userId,
      `Caller ${phone || 'unknown'}`,
      `[CALLSID:${callSid || 'unknown'}] Call from ${phone || 'unknown'}`,
      PLACEHOLDER,
      phone || '',
    ]
  );
  return r.rows[0].id;
}

// Appends one spoken turn ("Customer: ..." / "AI: ...") — an UPDATE per
// turn, never batched, so the transcript-so-far always exists in the DB.
async function appendCallTurn(db, messageId, speaker, text) {
  if (!messageId || !text) return;
  const line = `${speaker}: ${text}`;
  await db.query(
    `UPDATE messages
        SET text = CASE WHEN text = $2 THEN $3 ELSE text || E'\n' || $3 END
      WHERE id = $1`,
    [messageId, PLACEHOLDER, line]
  );
}

// Stamps the end of the call. A call with zero spoken turns keeps its
// placeholder untouched (nothing was said worth stamping).
async function endCallTranscript(db, messageId) {
  if (!messageId) return;
  await db.query(
    `UPDATE messages SET text = text || E'\n' || '📞 Call ended.'
      WHERE id = $1 AND text <> $2`,
    [messageId, PLACEHOLDER]
  );
}

module.exports = { beginCallTranscript, appendCallTurn, endCallTranscript, PLACEHOLDER };

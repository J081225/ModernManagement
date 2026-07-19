// lib/outbound-persist.js — IB1 commit 2.
//
// ONE way to record an outbound conversation message. Look-first (a)
// found owner and system sends firing into Twilio/SendGrid and writing
// NOTHING — the conversation on file was missing every owner turn.
// Every caller follows the same contract:
//
//   * ALWAYS called AFTER the actual send succeeded — record-keeping
//     must never block the phone. Every failure in here logs and
//     returns null; this module cannot throw.
//   * Identity via the FD helpers, not new lookups:
//     resolveCallerContact (phone-first last-10-digit, email fallback)
//     and the engine's findOrCreateThread.
//   * Threads are CREATED only for sentBy 'owner' (a reply is a
//     conversation). 'system'/'ai' notices link to an existing open
//     thread if one matches, and otherwise stay unthreaded — a receipt
//     must not mint a conversation.
//   * sentBy 'owner' also stamps appointment_threads.
//     last_owner_message_at (migration 052) — data for the future
//     driver checkpoint; nothing reads it yet.

const { resolveCallerContact } = require('./customer-scope');
const { phoneDigits10 } = require('./phone');

async function persistOutboundMessage({
  db, workspace, channel, to, body, subject, sentBy, threadId, logger,
  findOrCreateThread, onOwnerTurn,
}) {
  const log = logger || console;
  try {
    if (!db || !workspace || !body) return null;
    const isEmail = channel === 'email';
    const customer_phone = isEmail ? null : to;
    const customer_email = isEmail ? to : null;

    // Contact: FD2's resolver (best-effort).
    let contact = null;
    try {
      contact = await resolveCallerContact({ db, workspace, customer_phone, customer_email });
    } catch (err) {
      log.error('[outbound-persist] contact resolve failed (row stays unlinked):', err.message);
    }

    // Thread: create for owner turns, lookup-only for system/ai notices.
    let thread = null;
    if (threadId) {
      thread = { id: threadId };
    } else if (sentBy === 'owner' && typeof findOrCreateThread === 'function') {
      try {
        thread = await findOrCreateThread({
          workspace, contact, customer_phone, customer_email,
          channel: isEmail ? 'email' : 'sms', db,
        });
      } catch (err) {
        log.error('[outbound-persist] thread resolve failed (row stays unthreaded):', err.message);
      }
    } else {
      try {
        const digits = phoneDigits10(customer_phone);
        if (digits) {
          const r = await db.query(
            `SELECT id FROM appointment_threads
              WHERE workspace_id = $1
                AND state NOT IN ('closed', 'complete')
                AND RIGHT(regexp_replace(customer_phone, '\\D', '', 'g'), 10) = $2
              ORDER BY updated_at DESC LIMIT 1`,
            [workspace.id, digits]
          );
          if (r.rows[0]) thread = r.rows[0];
        } else if (customer_email) {
          const r = await db.query(
            `SELECT id FROM appointment_threads
              WHERE workspace_id = $1
                AND state NOT IN ('closed', 'complete')
                AND LOWER(customer_email) = LOWER($2)
              ORDER BY updated_at DESC LIMIT 1`,
            [workspace.id, customer_email]
          );
          if (r.rows[0]) thread = r.rows[0];
        }
      } catch (err) {
        log.error('[outbound-persist] thread lookup failed (row stays unthreaded):', err.message);
      }
    }

    const label = (contact && contact.name) || to || 'unknown';
    const r = await db.query(
      `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone, email, direction, sent_by, thread_id, contact_id)
       VALUES ($1, $2, $3, $4, $5, 'sent', 'inbox', $6, $7, 'outbound', $8, $9, $10)
       RETURNING id`,
      [workspace.owner_user_id, label,
        subject || ((isEmail ? 'Email to ' : 'SMS to ') + label),
        isEmail ? 'email' : 'sms', body,
        customer_phone, customer_email, sentBy,
        thread ? thread.id : null, contact ? contact.id : null]
    );

    if (sentBy === 'owner' && thread && thread.id) {
      try {
        await db.query(
          `UPDATE appointment_threads
              SET last_owner_message_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND workspace_id = $2`,
          [thread.id, workspace.id]
        );
      } catch (err) {
        log.error('[outbound-persist] owner stamp failed (row persisted):', err.message);
      }
      // IB1 commit 3 hook: the engine's context learns the owner spoke.
      if (typeof onOwnerTurn === 'function') {
        try {
          await onOwnerTurn({ db, threadId: thread.id, text: body });
        } catch (err) {
          log.error('[outbound-persist] owner-context append failed (row persisted):', err.message);
        }
      }
    }

    return r.rows[0] ? r.rows[0].id : null;
  } catch (err) {
    log.error('[outbound-persist] persist failed (the send already happened):', err.message);
    return null;
  }
}

module.exports = { persistOutboundMessage };

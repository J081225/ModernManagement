// lib/conversation-language.js — LANG Phase 1 unit 3.
//
// The CONVERSATION's language outranks the workspace default for canned
// strings that follow a conversation (receipts, payment-link SMS): a
// caller who pressed 2 for Spanish gets a Spanish receipt even when the
// workspace primary is English. appointment_threads.language (076) is
// the source; NULL/legacy threads fall back to the workspace primary.
// Fail-open to the primary — a read failure must never block a send.

async function conversationLanguage(db, workspace, customerPhone, customerEmail) {
  const fallback = (workspace && workspace.customer_language) || 'en';
  try {
    const key = customerPhone || customerEmail;
    if (!key || !workspace || !workspace.id) return fallback;
    const col = customerPhone ? 'customer_phone' : 'customer_email';
    const r = await db.query(
      `SELECT language FROM appointment_threads
        WHERE workspace_id = $1 AND ${col} = $2 AND language IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [workspace.id, key]
    );
    return (r.rows[0] && r.rows[0].language) || fallback;
  } catch (err) {
    console.error('[conversation-language] read failed (fallback to primary):', err.message);
    return fallback;
  }
}

// Drop-in shape: returns the same workspace object unless the
// conversation's language differs — then a clone with customer_language
// overridden, so every downstream `workspace.customer_language` read
// follows the conversation without touching each call site.
async function workspaceForConversation(db, workspace, customerPhone, customerEmail) {
  const lang = await conversationLanguage(db, workspace, customerPhone, customerEmail);
  if (!workspace || lang === workspace.customer_language) return workspace;
  return { ...workspace, customer_language: lang };
}

module.exports = { conversationLanguage, workspaceForConversation };

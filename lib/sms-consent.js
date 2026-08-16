// lib/sms-consent.js — A2P/TCPA opt-out (STOP), opt-in (START), HELP.
//
// TCPA is STRICT LIABILITY: honoring STOP is a LAW, not a feature. This
// module is the ONE place that (1) classifies the carrier-standard
// keywords, (2) records consent state per workspace + per number, and
// (3) answers isOptedOut() for the send path. Twilio's Advanced Opt-Out
// on the Messaging Service is the carrier-level backstop; this is the
// structural, auditable in-app layer that does not depend on it.
//
// Keyword matching is LONE-WORD (the whole trimmed message collapses to
// one token) — the same standard Twilio's default opt-out uses. That is
// deliberate: "Cancel my 2pm" is an appointment request, NOT an opt-out;
// only a bare "CANCEL" is. This avoids opting a customer out of all
// messages when they meant to cancel one appointment.

const STOP_WORDS  = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const START_WORDS = ['START', 'UNSTOP'];
const HELP_WORDS  = ['HELP', 'INFO'];

// Returns 'stop' | 'start' | 'help' | null. Pure.
function classifyOptKeyword(body) {
  if (body == null) return null;
  const w = String(body).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!w) return null;
  if (STOP_WORDS.includes(w)) return 'stop';
  if (START_WORDS.includes(w)) return 'start';
  if (HELP_WORDS.includes(w)) return 'help';
  return null;
}

async function recordOptOut(db, workspaceId, phone, keyword) {
  await db.query(
    `INSERT INTO sms_opt_outs (workspace_id, phone, opted_out, opted_out_at, last_keyword, updated_at)
       VALUES ($1, $2, true, NOW(), $3, NOW())
     ON CONFLICT (workspace_id, phone)
       DO UPDATE SET opted_out = true, opted_out_at = NOW(), last_keyword = $3, updated_at = NOW()`,
    [workspaceId, phone, (keyword || 'STOP').slice(0, 40)]
  );
}

async function recordOptIn(db, workspaceId, phone, keyword) {
  await db.query(
    `INSERT INTO sms_opt_outs (workspace_id, phone, opted_out, opted_in_at, last_keyword, updated_at)
       VALUES ($1, $2, false, NOW(), $3, NOW())
     ON CONFLICT (workspace_id, phone)
       DO UPDATE SET opted_out = false, opted_in_at = NOW(), last_keyword = $3, updated_at = NOW()`,
    [workspaceId, phone, (keyword || 'START').slice(0, 40)]
  );
}

// The send-path gate. Fail-OPEN on a read error (a transient DB error or
// a pre-migration deploy window must not halt ALL messaging) — but log
// loudly; Twilio's Advanced Opt-Out is the backstop for that window.
async function isOptedOut(db, workspaceId, phone) {
  if (!workspaceId || !phone) return false;
  try {
    const r = await db.query(
      'SELECT opted_out FROM sms_opt_outs WHERE workspace_id = $1 AND phone = $2',
      [workspaceId, phone]
    );
    return !!(r.rows[0] && r.rows[0].opted_out);
  } catch (err) {
    console.error('[sms-consent] isOptedOut read failed (fail-open) for ws=' + workspaceId + ':', err.message);
    return false;
  }
}

// Carrier-required reply copy (CTIA): program identity, rates line,
// opt-out/opt-in instruction.
function stopReply(businessName) {
  return `${businessName || 'This business'}: you're unsubscribed and will get no more texts. Reply START to resubscribe.`;
}
function startReply(businessName) {
  return `${businessName || 'This business'}: you're resubscribed to appointment & account texts. Reply STOP to opt out.`;
}
function helpReply(businessName) {
  return `${businessName || 'This business'} appointment & account texts. Msg & data rates may apply. Reply STOP to opt out.`;
}

// Promotional/marketing markers. A TRANSACTIONAL A2P campaign must not
// carry promotional content — that requires a separate Marketing
// campaign with its own consent. Used to keep broadcasts to service
// notices only (ruling 7).
const PROMO_MARKERS = /\b(sale|discount|discounts|\d+\s*%\s*off|percent off|deal|deals|offer|offers|promo|promotion|coupon|limited[- ]time|book now|buy now|shop now|save \$?\d|special offer|flash sale|exclusive|sign up now|subscribe now|new arrivals?)\b/i;
function looksPromotional(text) {
  return PROMO_MARKERS.test(String(text || ''));
}

module.exports = {
  classifyOptKeyword, recordOptOut, recordOptIn, isOptedOut,
  stopReply, startReply, helpReply, looksPromotional,
  STOP_WORDS, START_WORDS, HELP_WORDS,
};

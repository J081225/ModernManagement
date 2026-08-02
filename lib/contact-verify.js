// lib/contact-verify.js — AD5 c2.
//
// Proving control of a contact channel (Law 2 extended). Two flows,
// one storage shape (contact_verifications, migration 059 — one
// active row per (user, field), sha256 at rest, single-use by DELETE):
//
// - notification_email: single-use LINK, 1-hour expiry — AD3's token
//   plumbing (lib/credentials mint/hash) on a new public page.
// - alert_phone: 6-digit code SPOKEN over an outbound Twilio voice
//   call (SMS is not live pre-A2P; voice is). 10-minute expiry, five
//   wrong guesses burn the code, new call required.
//
// The lib never touches Twilio/SendGrid — adapters place the call and
// send the mail; the raw code/token exists only in the return value.
const crypto = require('crypto');
const { mintToken, hashToken } = require('./credentials');

const EMAIL_TTL_MS = 60 * 60 * 1000;
const PHONE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_GUESSES = 5;

function _mintCode(codeGen) {
  if (codeGen) return String(codeGen()).padStart(6, '0').slice(-6);
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Replace-don't-stack: one active verification per (user, field).
async function _replaceRow(db, userId, field, targetValue, codeHash, expiresIso) {
  await db.query(
    'DELETE FROM contact_verifications WHERE user_id = $1 AND field = $2',
    [userId, field]
  );
  await db.query(
    `INSERT INTO contact_verifications (user_id, field, target_value, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, field, targetValue, codeHash, expiresIso]
  );
}

// ---- email: request a verification link ----------------------------
async function requestEmailVerification(db, userId, nowMs) {
  const { rows } = await db.query(
    'SELECT notification_email, notification_email_verified_at FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length) return { status: 404, body: { error: 'User not found' } };
  const email = (rows[0].notification_email || '').trim();
  if (!email) return { status: 400, body: { error: 'No notification email is set.' } };
  if (rows[0].notification_email_verified_at) {
    return { status: 400, body: { error: 'This email is already verified.' } };
  }
  const { token, tokenHash } = mintToken();
  const expires = new Date(nowMs + EMAIL_TTL_MS);
  await _replaceRow(db, userId, 'notification_email', email, tokenHash, expires.toISOString());
  return {
    status: 200,
    body: { success: true, expires_at: expires.toISOString() },
    changed: true,
    token,
    email,
  };
}

// ---- email: the public verify step ---------------------------------
// The page shows ONE uninformative message for every failure mode; the
// lib's reason goes to the log only (the AD3 posture).
async function verifyEmailToken(db, rawToken, nowMs) {
  const raw = String(rawToken || '');
  if (!/^[a-f0-9]{64}$/.test(raw)) return { ok: false, reason: 'invalid' };
  const tokenHash = hashToken(raw);
  const { rows } = await db.query(
    `SELECT cv.id, cv.user_id, cv.target_value, cv.expires_at, u.notification_email
       FROM contact_verifications cv
       JOIN users u ON u.id = cv.user_id
      WHERE cv.code_hash = $1 AND cv.field = 'notification_email'
      LIMIT 1`,
    [tokenHash]
  );
  if (!rows.length) return { ok: false, reason: 'invalid' };
  const row = rows[0];
  if (new Date(row.expires_at) < new Date(nowMs)) {
    return { ok: false, reason: 'expired' }; // row left for the sweep
  }
  if ((row.notification_email || '').trim() !== row.target_value) {
    // The value changed after the link was sent — this link can never
    // legitimately succeed; kill it now.
    await db.query('DELETE FROM contact_verifications WHERE id = $1', [row.id]);
    return { ok: false, reason: 'value_changed' };
  }
  await db.query(
    'UPDATE users SET notification_email_verified_at = $1 WHERE id = $2',
    [new Date(nowMs).toISOString(), row.user_id]
  );
  await db.query('DELETE FROM contact_verifications WHERE id = $1', [row.id]);
  return { ok: true, email: row.target_value };
}

// ---- phone: request the voice call ---------------------------------
async function requestPhoneVerification(db, userId, nowMs, opts = {}) {
  const { rows } = await db.query(
    'SELECT alert_phone, alert_phone_verified_at FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length) return { status: 404, body: { error: 'User not found' } };
  const phone = (rows[0].alert_phone || '').trim();
  if (!phone) return { status: 400, body: { error: 'No alert phone is set.' } };
  if (rows[0].alert_phone_verified_at) {
    return { status: 400, body: { error: 'This phone is already verified.' } };
  }
  const code = _mintCode(opts.codeGen);
  const expires = new Date(nowMs + PHONE_TTL_MS);
  await _replaceRow(db, userId, 'alert_phone', phone, hashToken(code), expires.toISOString());
  return {
    status: 200,
    body: { success: true, expires_at: expires.toISOString(), guesses_allowed: MAX_CODE_GUESSES },
    changed: true,
    code,
    phone,
  };
}

// ---- phone: the typed-code check ------------------------------------
async function submitPhoneCode(db, userId, rawCode, nowMs) {
  const { rows } = await db.query(
    `SELECT cv.id, cv.target_value, cv.code_hash, cv.expires_at, cv.attempts, u.alert_phone
       FROM contact_verifications cv
       JOIN users u ON u.id = cv.user_id
      WHERE cv.user_id = $1 AND cv.field = 'alert_phone'
      LIMIT 1`,
    [userId]
  );
  if (!rows.length) {
    return { status: 400, body: { error: 'No verification call in progress — request a call first.' } };
  }
  const row = rows[0];
  if (new Date(row.expires_at) < new Date(nowMs)) {
    return { status: 400, body: { error: 'That code expired — request a new call.' } };
  }
  if (row.attempts >= MAX_CODE_GUESSES) {
    return { status: 400, body: { error: 'Too many wrong guesses — request a new call.' } };
  }
  if ((row.alert_phone || '').trim() !== row.target_value) {
    await db.query('DELETE FROM contact_verifications WHERE id = $1', [row.id]);
    return { status: 400, body: { error: 'The phone number changed after the call — request a new call.' } };
  }
  const code = String(rawCode || '').trim();
  if (!/^\d{6}$/.test(code) || hashToken(code) !== row.code_hash) {
    const used = row.attempts + 1;
    await db.query('UPDATE contact_verifications SET attempts = $1 WHERE id = $2', [used, row.id]);
    const left = MAX_CODE_GUESSES - used;
    return {
      status: 400,
      body: {
        error: left > 0
          ? "That code didn't match. " + left + (left === 1 ? ' guess' : ' guesses') + ' left.'
          : 'Too many wrong guesses — request a new call.',
      },
    };
  }
  await db.query(
    'UPDATE users SET alert_phone_verified_at = $1 WHERE id = $2',
    [new Date(nowMs).toISOString(), userId]
  );
  await db.query('DELETE FROM contact_verifications WHERE id = $1', [row.id]);
  return { status: 200, body: { success: true }, verified: true };
}

// TwiML for the spoken code — inline, no webhook. Digits only, so
// XML-safe by construction; spoken digit-by-digit, repeated once.
function buildCodeTwiml(code) {
  const spaced = String(code).split('').join('. ') + '.';
  return '<Response>'
    + '<Say>Your Modern Management verification code is.</Say>'
    + '<Say>' + spaced + '</Say>'
    + '<Pause length="1"/>'
    + '<Say>Again. ' + spaced + '</Say>'
    + '<Pause length="1"/>'
    + '<Say>Enter this code on your account page. Goodbye.</Say>'
    + '</Response>';
}

// CP4-sweep hook (piggyback, no new timer).
async function sweepExpiredContactVerifications(db) {
  const r = await db.query(
    'DELETE FROM contact_verifications WHERE expires_at < NOW()'
  );
  return r.rowCount || 0;
}

module.exports = {
  EMAIL_TTL_MS,
  PHONE_TTL_MS,
  MAX_CODE_GUESSES,
  requestEmailVerification,
  verifyEmailToken,
  requestPhoneVerification,
  submitPhoneCode,
  buildCodeTwiml,
  sweepExpiredContactVerifications,
};

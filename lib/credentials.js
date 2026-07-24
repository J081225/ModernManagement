// lib/credentials.js — AD3.
//
// Credential-change core, extracted so the suite drives the real
// logic with fixtures (the endpoints are thin adapters — the AD2
// lib/contact-settings pattern). The four laws, enforced here:
//
// LAW 1 — re-auth: every change verifies the current password at the
//   moment of change, behind ONE shared oracle gate (5 attempts per
//   15 minutes per user, across all credential endpoints).
// LAW 2 — verification before power: a new email becomes users.email
//   (the reset key) only after the link sent to THAT address is
//   clicked; until then the old address keeps all power.
// LAW 3 — notice to the old guard: handled by the adapters on the
//   account-mail path; sends never consult notifications_enabled.
// LAW 4 — tokens are ammunition: 32 random bytes, sha256-hashed at
//   rest, 1-hour expiry, deleted on use, rate-limited minting.
//
// Failure-message policy: re-auth failures — wrong password, missing
// row, OR rate-limited — all surface the SAME generic sentence. The
// HTTP status differs (400 vs 429) so the UI can behave, but the words
// never reveal which gate fired.
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const PASSWORD_MIN = 8; // matches the signup floor and the reset flow
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_MAX = 5;
const GENERIC_REAUTH = 'Current password incorrect or attempt limit reached.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,30}$/; // mirrors signup exactly — see
// the c3 commit message: the spec's looser 3-32 ./- charset was NOT
// adopted; signup is the house rule and its charset is kept.

// Timing equalizer: when the user row is missing, we still burn one
// bcrypt.compare against this throwaway hash so the miss path costs
// what the mismatch path costs. (requireAuth makes the miss nearly
// unreachable; this closes the gap anyway.)
const DUMMY_HASH = '$2b$10$XvM4Gfe/ZE9XiYQaTzKd4eboUpXKo6HvL8XKwXX1PTrFn6W4/siau';

// Generic sliding-window gate over an injected map + clock. The AD2
// test-alert limiter is the same idea with a fixed 60s window; both
// are in-memory and reset on deploy — acceptable for courtesy limits,
// stated honestly (look-first f).
function windowGate(map, userId, nowMs, max, windowMs) {
  const kept = (map.get(userId) || []).filter((t) => nowMs - t < windowMs);
  if (kept.length >= max) {
    map.set(userId, kept);
    const retryMs = windowMs - (nowMs - kept[0]);
    return { allowed: false, retryAfterSeconds: Math.ceil(retryMs / 1000) };
  }
  kept.push(nowMs);
  map.set(userId, kept);
  return { allowed: true };
}

// The password oracle gate: 5 per 15 minutes. EVERY current-password
// check draws from this budget, whichever endpoint asks.
function attemptGate(map, userId, nowMs) {
  return windowGate(map, userId, nowMs, ATTEMPT_MAX, ATTEMPT_WINDOW_MS);
}

// Masking, defined once (the c2 spec rule): local part first char +
// "***"; domain first char + "***" + TLD. j***@g***.com. Used
// everywhere a pending or current email renders in UI or notices.
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? '***' : '';
  const domain = s.slice(at + 1);
  const lastDot = domain.lastIndexOf('.');
  const maskedDomain = lastDot > 0
    ? domain[0] + '***' + domain.slice(lastDot)
    : domain[0] + '***';
  return s[0] + '***@' + maskedDomain;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Raw token goes in the email link ONCE; only the hash is stored.
function mintToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

// Shared re-auth step: gate + bcrypt-verify. One generic sentence for
// every failure mode; 429 vs 400 is the only distinction.
// Returns { user } on success or { status, body } to send verbatim.
async function _reauth(db, userId, currentPassword, attemptsMap, nowMs) {
  const gate = attemptGate(attemptsMap, userId, nowMs);
  if (!gate.allowed) {
    return { status: 429, body: { error: GENERIC_REAUTH } };
  }
  const { rows } = await db.query(
    'SELECT id, username, password_hash, email FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length) {
    await bcrypt.compare(String(currentPassword || ''), DUMMY_HASH); // timing equalizer
    return { status: 400, body: { error: GENERIC_REAUTH } };
  }
  const ok = await bcrypt.compare(String(currentPassword || ''), rows[0].password_hash);
  if (!ok) return { status: 400, body: { error: GENERIC_REAUTH } };
  return { user: rows[0] };
}

// ---- commit 1: password change -------------------------------------
// Returns { status, body, changed?, notifyEmail? }.
async function changePassword(db, userId, body, attemptsMap, nowMs, opts = {}) {
  const rounds = opts.rounds || 10;
  const next = String(body.new_password || '');
  const confirm = String(body.confirm_password || '');
  if (next.length < PASSWORD_MIN) {
    return { status: 400, body: { error: 'New password must be at least ' + PASSWORD_MIN + ' characters.', field: 'new_password' } };
  }
  if (next !== confirm) {
    return { status: 400, body: { error: "New passwords don't match.", field: 'confirm_password' } };
  }
  const re = await _reauth(db, userId, body.current_password, attemptsMap, nowMs);
  if (!re.user) return re;
  // Changing to the same password is a no-op that would still fire
  // alarms — refuse it plainly.
  if (await bcrypt.compare(next, re.user.password_hash)) {
    return { status: 400, body: { error: 'Your new password matches your current one — nothing to change.', field: 'new_password' } };
  }
  const hash = await bcrypt.hash(next, rounds);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
  return {
    status: 200,
    body: { success: true },
    changed: true,
    notifyEmail: (re.user.email || '').trim() || null,
  };
}

// Look-first (a): sessions live in the connect-pg-simple table
// (user_sessions, sess JSON carrying userId) — so ending every OTHER
// session is one honest DELETE. Logout-everywhere would be the same
// statement without the sid exclusion.
async function endOtherSessions(db, userId, currentSid) {
  const r = await db.query(
    `DELETE FROM user_sessions
      WHERE (sess->>'userId')::int = $1
        AND sid <> $2`,
    [userId, String(currentSid || '')]
  );
  return r.rowCount || 0;
}

module.exports = {
  PASSWORD_MIN,
  ATTEMPT_WINDOW_MS,
  ATTEMPT_MAX,
  GENERIC_REAUTH,
  EMAIL_RE,
  USERNAME_RE,
  windowGate,
  attemptGate,
  maskEmail,
  hashToken,
  mintToken,
  _reauth,
  changePassword,
  endOtherSessions,
};

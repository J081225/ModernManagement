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

// maskEmail's sibling (AD6): area code visible + last two digits —
// enough to recognize your own number, nothing more. (443) ***-**99.
function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d[0] === '1') {
    return '(' + d.slice(1, 4) + ') ***-**' + d.slice(9);
  }
  return '***' + d.slice(-2);
}

// AD6 (Law 3): the ONE security-notice sender. Rides the account-mail
// path, NEVER consults notifications_enabled (you can silence pings,
// never alarms), soft-fails loudly, and a missing recipient logs the
// skip and never blocks the change that triggered it.
async function sendSecurityNotice({ sendgrid, env, logger }, to, { subject, text }) {
  const log = logger || console;
  const addr = String(to || '').trim();
  if (!addr) {
    log.error('[security-notice] no reachable email — notice skipped:', subject);
    return null;
  }
  try {
    await sendgrid.send({
      to: addr,
      from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
      replyTo: env.SENDGRID_FROM_EMAIL,
      subject,
      text,
    });
    return 'sent';
  } catch (err) {
    log.error('[security-notice] send failed (' + subject + '):', err.message);
    return null;
  }
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
  // c2: a password change while an email change is pending CANCELS the
  // pending — the owner reasserting control resets the board. One
  // UPDATE sets the new hash and clears the pending state together.
  const pend = await db.query('SELECT pending_email FROM users WHERE id = $1', [userId]);
  const pendingCancelled = Boolean(pend.rows.length && pend.rows[0].pending_email);
  await db.query(
    `UPDATE users
        SET password_hash = $1,
            pending_email = NULL,
            pending_email_token_hash = NULL,
            pending_email_expires = NULL
      WHERE id = $2`,
    [hash, userId]
  );
  return {
    status: 200,
    body: { success: true, pending_email_cancelled: pendingCancelled },
    changed: true,
    pendingCancelled,
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

// ---- commit 2: email change with verification -----------------------
// Request: re-auth, then park the new address (trimmed, LOWERCASED)
// in pending_email with a hashed single-use token, 1-hour expiry.
// users.email — the reset key — is untouched until verification
// completes (LAW 2). A fresh request overwrites any prior pending:
// one pending max. Returns the RAW token only in the return value for
// the adapter to mail; the row stores its hash.
async function requestEmailChange(db, userId, body, attemptsMap, nowMs) {
  const newEmail = String(body.new_email || '').trim().toLowerCase();
  if (newEmail.length > 254) {
    return { status: 400, body: { error: 'Email is too long', field: 'new_email' } };
  }
  if (!EMAIL_RE.test(newEmail)) {
    return { status: 400, body: { error: "That email address doesn't look valid", field: 'new_email' } };
  }
  const re = await _reauth(db, userId, body.current_password, attemptsMap, nowMs);
  if (!re.user) return re;
  if ((re.user.email || '').trim().toLowerCase() === newEmail) {
    return { status: 400, body: { error: "That's already this account's email.", field: 'new_email' } };
  }
  const { token, tokenHash } = mintToken();
  const expires = new Date(nowMs + 60 * 60 * 1000);
  await db.query(
    `UPDATE users
        SET pending_email = $1,
            pending_email_token_hash = $2,
            pending_email_expires = $3
      WHERE id = $4`,
    [newEmail, tokenHash, expires.toISOString(), userId]
  );
  return {
    status: 200,
    body: { success: true, pending_email_masked: maskEmail(newEmail), expires_at: expires.toISOString() },
    changed: true,
    token,
    oldEmail: (re.user.email || '').trim() || null,
    newEmail,
  };
}

// Verify: hash the presented token, match, check expiry, swap, clear.
// Clearing IS the single-use mechanic (LAW 4) — a second presentation
// matches nothing. The lib reports a reason for logs/tests; the PAGE
// shows one uninformative message for every failure mode.
async function verifyEmailChange(db, rawToken, nowMs) {
  const raw = String(rawToken || '');
  if (!/^[a-f0-9]{64}$/.test(raw)) return { ok: false, reason: 'invalid' };
  const tokenHash = hashToken(raw);
  const { rows } = await db.query(
    `SELECT id, email, pending_email, pending_email_expires
       FROM users
      WHERE pending_email_token_hash = $1
      LIMIT 1`,
    [tokenHash]
  );
  if (!rows.length || !rows[0].pending_email) return { ok: false, reason: 'invalid' };
  const u = rows[0];
  if (new Date(u.pending_email_expires) < new Date(nowMs)) {
    // Left in place for the sweep / a resend to replace; the page
    // still shows the same generic failure.
    return { ok: false, reason: 'expired' };
  }
  await db.query(
    `UPDATE users
        SET email = pending_email,
            pending_email = NULL,
            pending_email_token_hash = NULL,
            pending_email_expires = NULL
      WHERE id = $1`,
    [u.id]
  );
  return { ok: true, oldEmail: (u.email || '').trim() || null, newEmail: u.pending_email };
}

// Resend: rate-limited by the adapter (3 per hour, its own bucket —
// shares nothing with the password oracle); re-mints the token and
// restarts the 1-hour clock for the SAME pending address.
async function resendEmailChange(db, userId, nowMs) {
  const { rows } = await db.query(
    'SELECT pending_email FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length || !rows[0].pending_email) {
    return { status: 400, body: { error: 'No email change is pending.' } };
  }
  const { token, tokenHash } = mintToken();
  const expires = new Date(nowMs + 60 * 60 * 1000);
  await db.query(
    `UPDATE users
        SET pending_email_token_hash = $1,
            pending_email_expires = $2
      WHERE id = $3`,
    [tokenHash, expires.toISOString(), userId]
  );
  return {
    status: 200,
    body: { success: true, pending_email_masked: maskEmail(rows[0].pending_email), expires_at: expires.toISOString() },
    changed: true,
    token,
    newEmail: rows[0].pending_email,
  };
}

// Cancel requires re-auth too (LAW 1) — otherwise whoever is holding
// the session quietly cancels the alarm the real owner just received.
async function cancelEmailChange(db, userId, body, attemptsMap, nowMs) {
  const re = await _reauth(db, userId, body.current_password, attemptsMap, nowMs);
  if (!re.user) return re;
  const { rows } = await db.query(
    'SELECT pending_email FROM users WHERE id = $1',
    [userId]
  );
  if (!rows.length || !rows[0].pending_email) {
    return { status: 400, body: { error: 'No email change is pending.' } };
  }
  await db.query(
    `UPDATE users
        SET pending_email = NULL,
            pending_email_token_hash = NULL,
            pending_email_expires = NULL
      WHERE id = $1`,
    [userId]
  );
  return { status: 200, body: { success: true }, changed: true };
}

// The CP4-pattern sweep hook (piggybacked on the existing 30-minute
// interval — no new timer): expired pendings are cleared so a stale
// pending can't sit forever.
async function sweepExpiredPendingEmails(db) {
  const r = await db.query(
    `UPDATE users
        SET pending_email = NULL,
            pending_email_token_hash = NULL,
            pending_email_expires = NULL
      WHERE pending_email IS NOT NULL
        AND pending_email_expires < NOW()`
  );
  return r.rowCount || 0;
}

// Card status: masked truths only (the c2 masking rule) — the UI
// never sees full addresses it didn't type, and never learns whether
// an address exists elsewhere (moot: users.email has no unique
// constraint — look-first c).
async function credentialsStatus(db, userId) {
  const { rows } = await db.query(
    `SELECT username, email, pending_email, pending_email_expires
       FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const u = rows[0];
  return {
    username: u.username,
    email_masked: maskEmail(u.email),
    has_email: Boolean((u.email || '').trim()),
    pending: u.pending_email
      ? { email_masked: maskEmail(u.pending_email), expires_at: u.pending_email_expires }
      : null,
  };
}

// ---- commit 3: username change ---------------------------------------
// Re-authed like everything else (LAW 1, same oracle budget).
// Uniqueness failures are HONEST — username is the login key (UNIQUE
// NOT NULL) and a semi-public identifier, unlike emails.
//
// Charset decision, stated: the spec allowed 3-32 letters/digits/._-
// but signup mints /^[a-z0-9_]{3,30}$/ and login matches the stored
// name EXACTLY (case-sensitive, trimmed — look-first g). This flow
// keeps SIGNUP'S charset — a strict subset of the spec's — so every
// changeable name is a name signup could mint. Under a lowercase-only
// charset the LOWER() uniqueness check below is equivalent to login's
// exact matching for all mintable names, and strictly protective
// against any legacy mixed-case row (refusing a name whose case-fold
// collides can never mint an account login can't reach; allowing it
// under exact-match semantics could confuse two visually-identical
// logins). Divergence from the spec's looser charset is deliberate
// and reported, not silent.
async function changeUsername(db, userId, body, attemptsMap, nowMs) {
  const newUsername = String(body.new_username || '').trim();
  if (!USERNAME_RE.test(newUsername)) {
    return {
      status: 400,
      body: { error: 'Usernames are 3-30 characters: lowercase letters, numbers, underscores.', field: 'new_username' },
    };
  }
  const re = await _reauth(db, userId, body.current_password, attemptsMap, nowMs);
  if (!re.user) return re;
  if (re.user.username === newUsername) {
    return { status: 400, body: { error: "That's already your username.", field: 'new_username' } };
  }
  const dup = await db.query(
    'SELECT 1 FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2 LIMIT 1',
    [newUsername, userId]
  );
  if (dup.rows.length) {
    return { status: 400, body: { error: 'That username is taken.', field: 'new_username' } };
  }
  try {
    await db.query('UPDATE users SET username = $1 WHERE id = $2', [newUsername, userId]);
  } catch (err) {
    // unique-constraint race: two requests passed the check together —
    // the loser gets the same honest message, not a 500.
    if (String(err.code) === '23505') {
      return { status: 400, body: { error: 'That username is taken.', field: 'new_username' } };
    }
    throw err;
  }
  return {
    status: 200,
    body: { success: true, username: newUsername },
    changed: true,
    newUsername,
    notifyEmail: (re.user.email || '').trim() || null,
  };
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
  maskPhone,
  sendSecurityNotice,
  hashToken,
  mintToken,
  _reauth,
  changePassword,
  endOtherSessions,
  requestEmailChange,
  verifyEmailChange,
  resendEmailChange,
  cancelEmailChange,
  sweepExpiredPendingEmails,
  credentialsStatus,
  changeUsername,
};

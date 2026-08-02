// lib/contact-settings.js — AD2 c4.
//
// The ONE settings save path, extracted from PUT /api/settings so the
// suite can drive the real logic with fixtures (the endpoint is a thin
// adapter — same route, same semantics, no second path).
//
// Rules, stated once:
// - trim everything; caps: email 254, phone 32 (raw input)
// - email shape-checked with the codebase's established regex idiom
// - alert_phone normalized to E.164 via lib/phone (FD1) or rejected
// - alert_phone updates only when the key is present in the body —
//   the onboarding flow sends only email + enabled and must not
//   clobber the phone
// - cleared fields store NULL, never ''. Every reader treats both as
//   absent (lib/owner-alert trims; sendNotificationEmail
//   short-circuits on falsy), so this is honesty, not behavior change.
const { normalizePhone } = require('./phone');
// AD4 (Law 1, ruling A): changing an already-set contact field re-auths
// through the SAME shared helper and oracle budget as the credential
// flows — one gate, one budget, everywhere a password is checked.
const { _reauth, GENERIC_REAUTH } = require('./credentials');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateContactSettings(body) {
  const hasAlertPhone = Object.prototype.hasOwnProperty.call(body, 'alert_phone');
  const rawEmail = String(body.notification_email || '').trim();
  if (rawEmail.length > 254) {
    return { error: 'Notification email is too long', field: 'notification_email' };
  }
  if (rawEmail && !EMAIL_RE.test(rawEmail)) {
    return { error: "That email address doesn't look valid", field: 'notification_email' };
  }
  const values = {
    notificationEmail: rawEmail || null,
    notificationsEnabled: body.notifications_enabled !== false,
    hasAlertPhone,
  };
  if (hasAlertPhone) {
    const rawPhone = String(body.alert_phone || '').trim();
    if (rawPhone.length > 32) {
      return { error: 'Alert phone is too long', field: 'alert_phone' };
    }
    values.alertPhone = rawPhone ? normalizePhone(rawPhone) : null;
    if (rawPhone && !values.alertPhone) {
      return { error: 'Alert phone needs at least 10 digits', field: 'alert_phone' };
    }
  }
  return { values };
}

// Returns { status, body } for the adapter to send verbatim.
//
// AD4 (Law 1, ruling A): a request that would CHANGE an already-set
// notification_email or alert_phone must carry the correct
// current_password. First-set (NULL/'' -> value) and toggle-only saves
// pass without one — that keeps onboarding working. Clearing a set
// value IS a change (it redirects pings to the fallback chain).
// Ruling B: every AD4 rejection — wrong password, missing password, or
// the shared gate firing — is 403 with AD3's one generic sentence; the
// AD3 endpoints keep their shipped 400/429 shape untouched.
// attemptsMap is the SAME map the credential endpoints use: one oracle,
// one 5-per-15-min budget, and every check here draws from it.
async function saveContactSettings(db, userId, body, attemptsMap, nowMs) {
  const v = validateContactSettings(body || {});
  if (v.error) return { status: 400, body: { error: v.error, field: v.field } };
  const { notificationEmail, notificationsEnabled, hasAlertPhone, alertPhone } = v.values;

  const stored = await db.query(
    'SELECT notification_email, alert_phone FROM users WHERE id = $1',
    [userId]
  );
  if (!stored.rows.length) return { status: 404, body: { error: 'User not found' } };
  const curEmail = (stored.rows[0].notification_email || '').trim();
  const curPhone = (stored.rows[0].alert_phone || '').trim();
  // Exact-after-trim comparison, deliberately strict: any byte change
  // to a set value (including a case edit or a clear) is a change.
  const emailChangesSet = Boolean(curEmail) && (notificationEmail || '') !== curEmail;
  const phoneChangesSet = hasAlertPhone && Boolean(curPhone) && (alertPhone || '') !== curPhone;
  if (emailChangesSet || phoneChangesSet) {
    const re = await _reauth(
      db, userId, (body || {}).current_password,
      attemptsMap || new Map(),
      nowMs === undefined ? Date.now() : nowMs
    );
    if (!re.user) return { status: 403, body: { error: GENERIC_REAUTH } };
  }
  // AD5 (Law 2): ANY change to a value — first-set, edit, or clear —
  // resets its verified_at in the SAME update, so a new value never
  // inherits the old value's trust for even one row-read. An unchanged
  // value keeps its stamp.
  const emailValueChanges = (notificationEmail || '') !== curEmail;
  const phoneValueChanges = hasAlertPhone && (alertPhone || '') !== curPhone;
  if (hasAlertPhone) {
    const { rows } = await db.query(
      `UPDATE users
         SET notification_email = $1,
             notifications_enabled = $2,
             alert_phone = $3,
             notification_email_verified_at = CASE WHEN $5 THEN NULL ELSE notification_email_verified_at END,
             alert_phone_verified_at = CASE WHEN $6 THEN NULL ELSE alert_phone_verified_at END
       WHERE id = $4
       RETURNING notification_email, notifications_enabled, alert_phone`,
      [notificationEmail, notificationsEnabled, alertPhone, userId, emailValueChanges, phoneValueChanges]
    );
    return { status: 200, body: rows[0] };
  }
  const { rows } = await db.query(
    `UPDATE users
       SET notification_email = $1,
           notifications_enabled = $2,
           notification_email_verified_at = CASE WHEN $4 THEN NULL ELSE notification_email_verified_at END
     WHERE id = $3
     RETURNING notification_email, notifications_enabled`,
    [notificationEmail, notificationsEnabled, userId, emailValueChanges]
  );
  return { status: 200, body: rows[0] };
}

// The test-alert courtesy limiter: one per minute per user. Pure
// decision over an injected map + clock so the suite can drive it.
function testAlertGate(lastMap, userId, nowMs) {
  const last = lastMap.get(userId) || 0;
  const waitMs = 60 * 1000 - (nowMs - last);
  if (waitMs > 0) {
    return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
  }
  lastMap.set(userId, nowMs);
  return { allowed: true };
}

module.exports = { validateContactSettings, saveContactSettings, testAlertGate, EMAIL_RE };

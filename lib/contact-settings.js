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
async function saveContactSettings(db, userId, body) {
  const v = validateContactSettings(body || {});
  if (v.error) return { status: 400, body: { error: v.error, field: v.field } };
  const { notificationEmail, notificationsEnabled, hasAlertPhone, alertPhone } = v.values;
  if (hasAlertPhone) {
    const { rows } = await db.query(
      `UPDATE users
         SET notification_email = $1,
             notifications_enabled = $2,
             alert_phone = $3
       WHERE id = $4
       RETURNING notification_email, notifications_enabled, alert_phone`,
      [notificationEmail, notificationsEnabled, alertPhone, userId]
    );
    return { status: 200, body: rows[0] };
  }
  const { rows } = await db.query(
    `UPDATE users
       SET notification_email = $1,
           notifications_enabled = $2
     WHERE id = $3
     RETURNING notification_email, notifications_enabled`,
    [notificationEmail, notificationsEnabled, userId]
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

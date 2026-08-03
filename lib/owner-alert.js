// lib/owner-alert.js — FD3-CP4.
//
// The ONE owner-notification routing, extracted from server.js's
// sendOwnerEmergencyAlert (parity audit §1.11: the page-admin settings
// feed users.alert_phone / notification_email / notifications_enabled;
// this is the code that reads them). SMS to alert_phone first, else
// email to notification_email falling back to the account email. New
// callers (the FD3-CP4 approval ping) reuse this instead of growing a
// second routing.
//
// opts.respectEnabled: when true, users.notifications_enabled = false
// silences the alert — non-emergency pings honor the owner's setting.
// The emergency path passes false and always sends.
//
// Soft-fails only; returns 'sms' | 'email' | null (what actually went
// out) so callers can log honestly.
// AD8 (f): the email leg feeds the mail-outage streak monitor.
const mailHealth = require('./mail-health');
async function sendOwnerAlert({ db, twilio, sendgrid, env, logger }, userId, { smsBody, emailSubject, emailText, respectEnabled }) {
  const log = logger || console;
  try {
    const { rows } = await db.query(
      'SELECT id, alert_phone, notification_email, email, notifications_enabled, alert_phone_verified_at, notification_email_verified_at FROM users WHERE id = $1',
      [userId]
    );
    if (!rows.length) {
      log.error('[owner-alert] no user row for userId=', userId);
      return null;
    }
    const user = rows[0];
    if (respectEnabled && user.notifications_enabled === false) return null;

    // AD5 (Law 2): an UNVERIFIED value is treated exactly as an absent
    // one — including on the emergency path (ruling: law wins; an
    // attacker-planted phone must never receive, and the email
    // fallback below carries emergencies). Grandfathered rows were
    // stamped verified by migration 059.
    const phone = user.alert_phone_verified_at ? (user.alert_phone || '').trim() : '';
    if (phone && twilio) {
      try {
        await twilio.messages.create({
          from: env.TWILIO_PHONE_NUMBER,
          to: phone,
          body: smsBody,
        });
        return 'sms';
      } catch (err) {
        log.error('[owner-alert] SMS send failed:', err.message, '— falling back to email');
      }
    }

    // AD5: unverified notification_email is skipped the same way; the
    // account email (users.email, the reset key — its own AD3-verified
    // change flow) needs no contact verification.
    const toEmail = (user.notification_email_verified_at && user.notification_email && user.notification_email.trim())
      || (user.email && user.email.trim())
      || '';
    if (toEmail && sendgrid) {
      try {
        await sendgrid.send({
          to: toEmail,
          from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
          subject: emailSubject,
          text: emailText || smsBody,
        });
        mailHealth.recordSuccess();
        return 'email';
      } catch (err) {
        log.error('[owner-alert] email send also failed:', err.message);
        mailHealth.recordFailure({ source: 'owner-alert', reason: err.message });
      }
    }

    log.error('[owner-alert] no reachable channel for userId=', userId);
    return null;
  } catch (err) {
    log.error('[owner-alert] outer error:', err.message);
    return null;
  }
}

module.exports = { sendOwnerAlert };

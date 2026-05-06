// Phase B B4 part 1: signup orchestrator. Triggered by Stripe's
// checkout.session.completed webhook. Provisions the user, workspace,
// and Twilio number; sends welcome email; on failure, alerts the
// operator (admin user's alert_phone or notification email) and marks
// the stripe_events row with the error so manual cleanup is possible.
//
// Design: synchronous (called inline from the webhook handler).
// Idempotent via SELECT ... FOR UPDATE on stripe_events.processed_at.
// Pool is passed in by the caller (server.js) — keeps this module
// free of pg-pool initialization concerns.
//
// On success the signup_drafts row is DELETED (data minimization;
// password_hash no longer needed once the user row exists).

const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');
const twilio = require('twilio');

const {
  searchAvailableNumbers,
  purchaseNumber,
  configureNumberWebhooks,
  releaseNumber,
} = require('./twilio-provisioning');

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

let _twilioClient = null;
function getTwilioClient() {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;  // operator alerts will degrade to email-only
  _twilioClient = twilio(sid, token);
  return _twilioClient;
}

// Mirrors generateForwardToken in server.js — duplicated to keep the
// orchestrator a leaf module with no server.js dependency. Drift is
// tolerable since both sides produce a 12-char unique slug.
function generateForwardToken() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------------------------------------------------------------------
// Welcome email — HTML + text bodies
// ---------------------------------------------------------------------

function welcomeEmailSubject() {
  return 'Welcome to Modern Management — your workspace is ready';
}

function welcomeEmailHtml({ businessName, username, twilioPhone, plan, billing, baseUrl }) {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1) + ' / ' +
    (billing === 'annual' ? 'Annual' : 'Monthly');
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><title>Welcome</title></head>',
    '<body style="margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#2d3748;">',
    '<div style="max-width:540px;margin:0 auto;padding:24px 16px;">',
    '<div style="background:white;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.04);">',
    '<h1 style="margin:0 0 8px;font-size:1.4em;color:#2d3748;">Welcome to Modern Management</h1>',
    '<p style="color:#64748b;margin:0 0 20px;">Hi ' + escapeHtml(businessName) + ' &mdash; your workspace is live.</p>',
    // Prominent phone callout
    '<div style="background:linear-gradient(135deg,#fff7ed,#ffedd5);border:1px solid #fed7aa;border-radius:10px;padding:18px;margin:22px 0;">',
    '<div style="font-size:0.78em;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;">Your business phone number</div>',
    '<div style="font-size:1.6em;font-weight:800;color:#c2410c;letter-spacing:-0.3px;">' + escapeHtml(twilioPhone) + '</div>',
    '<div style="font-size:0.85em;color:#9a3412;margin-top:8px;line-height:1.4;">Share this number with your tenants for SMS and voice. Modern Management\'s AI handles routine inquiries; you get notified for the rest.</div>',
    '</div>',
    // What happens next
    '<h2 style="font-size:1em;color:#2d3748;margin:24px 0 8px;">What happens next</h2>',
    '<p style="font-size:0.9em;color:#475569;line-height:1.6;">When tenants text or call your new number, Modern Management\'s AI reads the message, drafts a reply, and either sends it automatically (if you\'ve enabled auto-reply) or queues it in your inbox for review. Emergency-keyword messages (fire, gas leak, threats, injuries) always require your manual review and we\'ll notify you by SMS.</p>',
    // Sign in
    '<h2 style="font-size:1em;color:#2d3748;margin:24px 0 8px;">Sign in</h2>',
    '<p style="font-size:0.9em;color:#475569;line-height:1.6;">Visit <a href="' + escapeHtml(baseUrl) + '/login" style="color:#ff6b6b;">' + escapeHtml(baseUrl) + '/login</a> with username <strong>' + escapeHtml(username) + '</strong> and the password you set during signup.</p>',
    '<p style="font-size:0.85em;color:#64748b;margin-top:4px;">Your plan: <strong>' + escapeHtml(planLabel) + '</strong>. Manage billing in Settings.</p>',
    // Getting started
    '<h2 style="font-size:1em;color:#2d3748;margin:24px 0 8px;">Getting started</h2>',
    '<ul style="font-size:0.9em;color:#475569;line-height:1.7;padding-left:22px;margin:0;">',
    '<li>Add your first property in Inventory.</li>',
    '<li>Add tenants in Contacts.</li>',
    '<li>Set your alert phone in Admin &rarr; Notification Settings to get SMS alerts for emergency tenant messages.</li>',
    '</ul>',
    '<p style="font-size:0.85em;color:#94a3b8;margin-top:24px;padding-top:18px;border-top:1px solid #e2e8f0;">Need help? Reply to this email and we\'ll get back to you.</p>',
    '</div></div></body></html>',
  ].join('');
}

function welcomeEmailText({ businessName, username, twilioPhone, plan, billing, baseUrl }) {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1) + ' / ' +
    (billing === 'annual' ? 'Annual' : 'Monthly');
  return [
    'Welcome to Modern Management',
    '',
    'Hi ' + businessName + ' — your workspace is live.',
    '',
    'YOUR BUSINESS PHONE NUMBER:',
    '  ' + twilioPhone,
    '',
    'Share this number with your tenants for SMS and voice. Modern Management\'s AI handles routine inquiries; you get notified for the rest.',
    '',
    'WHAT HAPPENS NEXT',
    'When tenants text or call your new number, Modern Management\'s AI reads the message, drafts a reply, and either sends it automatically (if you\'ve enabled auto-reply) or queues it in your inbox for review. Emergency-keyword messages (fire, gas leak, threats, injuries) always require your manual review and we\'ll notify you by SMS.',
    '',
    'SIGN IN',
    'Visit ' + baseUrl + '/login with username "' + username + '" and the password you set during signup.',
    'Your plan: ' + planLabel + '. Manage billing in Settings.',
    '',
    'GETTING STARTED',
    '* Add your first property in Inventory.',
    '* Add tenants in Contacts.',
    '* Set your alert phone in Admin > Notification Settings to get SMS alerts for emergency tenant messages.',
    '',
    'Need help? Reply to this email and we\'ll get back to you.',
  ].join('\n');
}

async function sendWelcomeEmail({ to, businessName, username, twilioPhone, plan, billing, baseUrl }) {
  await sgMail.send({
    to,
    from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
    replyTo: process.env.SENDGRID_FROM_EMAIL,
    subject: welcomeEmailSubject(),
    text: welcomeEmailText({ businessName, username, twilioPhone, plan, billing, baseUrl }),
    html: welcomeEmailHtml({ businessName, username, twilioPhone, plan, billing, baseUrl }),
  });
}

// ---------------------------------------------------------------------
// Operator failure alert: SMS to admin's alert_phone, email fallback.
// Mirrors the pattern from sendOwnerEmergencyAlert in server.js.
// ---------------------------------------------------------------------

async function notifyOperatorOfFailure(pool, message, context) {
  let admin;
  try {
    const { rows } = await pool.query(
      'SELECT alert_phone, notification_email, email FROM users WHERE username = $1',
      ['admin']
    );
    if (!rows.length) {
      console.error('[orchestrator-alert] admin row missing — cannot notify operator');
      return;
    }
    admin = rows[0];
  } catch (err) {
    console.error('[orchestrator-alert] admin lookup failed:', err.message);
    return;
  }

  const sms = 'Modern Management ALERT: Signup orchestration failed. ' + message;
  const phone = (admin.alert_phone || '').trim();
  const tw = getTwilioClient();
  if (phone && tw) {
    try {
      await tw.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
        body: sms.slice(0, 320),
      });
      console.log('[orchestrator-alert] SMS sent to operator');
    } catch (err) {
      console.error('[orchestrator-alert] SMS failed, falling back to email:', err.message);
    }
  }

  const toEmail = (admin.notification_email && admin.notification_email.trim()) ||
                  (admin.email && admin.email.trim()) || '';
  if (toEmail) {
    try {
      await sgMail.send({
        to: toEmail,
        from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
        subject: 'URGENT: Signup orchestration failure',
        text: sms + '\n\nContext:\n' + JSON.stringify(context, null, 2),
      });
      console.log('[orchestrator-alert] Email sent to', toEmail);
    } catch (err) {
      console.error('[orchestrator-alert] Email failed:', err.message);
    }
  }

  if (!phone && !toEmail) {
    console.error('[orchestrator-alert] No alert_phone or email on file for admin — operator NOT actively notified');
  }
}

// ---------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------

// processCheckoutCompletedEvent(event, pool)
//   event: the Stripe event object as received by the webhook
//   pool:  the pg Pool instance (passed by server.js so we share connections)
// Returns: { ok: boolean, ...info }
async function processCheckoutCompletedEvent(event, pool) {
  const eventId = event && event.id;
  const session = event && event.data && event.data.object;
  if (!eventId || !session) {
    return { ok: false, reason: 'malformed_event' };
  }
  const draftId = session.client_reference_id ||
                  (session.metadata && session.metadata.draft_id);
  if (!draftId) {
    console.error('[orchestrator] No draft_id in event', eventId);
    return { ok: false, reason: 'no_draft_id' };
  }

  const client = await pool.connect();
  let purchasedSidForCleanup = null;
  try {
    await client.query('BEGIN');

    // Lock the stripe_events row to prevent concurrent processing.
    // SELECT FOR UPDATE blocks any other handler running this same
    // event id; once we COMMIT (or ROLLBACK), the second handler
    // wakes up, sees processed_at IS NOT NULL (or row missing), and
    // bails cleanly via the check below.
    const { rows: lockRows } = await client.query(
      `SELECT id, processed_at FROM stripe_events
        WHERE stripe_event_id = $1
        FOR UPDATE`,
      [eventId]
    );
    if (!lockRows.length) {
      // Webhook handler is supposed to INSERT before calling us.
      // If it didn't, bail cleanly (don't synthesize a row here —
      // would be an integrity violation if the event later races in).
      await client.query('ROLLBACK');
      return { ok: false, reason: 'event_not_stored' };
    }
    if (lockRows[0].processed_at) {
      await client.query('ROLLBACK');
      return { ok: true, reason: 'already_processed', skipped: true };
    }

    // Read the draft (still within TTL).
    const { rows: draftRows } = await client.query(
      `SELECT draft_data FROM signup_drafts
        WHERE id = $1 AND expires_at > NOW()`,
      [draftId]
    );
    if (!draftRows.length) {
      throw new Error('Draft ' + draftId + ' not found or expired');
    }
    const draft = draftRows[0].draft_data;

    // Generate per-user routing tokens.
    const forwardToken = generateForwardToken();
    const inboundEmailAlias = 'user-' + generateForwardToken() + '@inbound.modernmanagementapp.com';

    // INSERT user. If username/email collided after the create-checkout-
    // session pre-check, the unique constraint will throw — handled by
    // the outer catch.
    const { rows: userRows } = await client.query(
      `INSERT INTO users (
         username, password_hash, email, plan,
         payment_forward_token, inbound_email_alias,
         alert_phone, stripe_customer_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        draft.username,
        draft.password_hash,
        draft.email,
        draft.plan,
        forwardToken,
        inboundEmailAlias,
        draft.alert_phone || null,
        session.customer || null,
      ]
    );
    const userId = userRows[0].id;

    // Default automation row (matches /api/signup pattern).
    await client.query(
      `INSERT INTO automation (user_id, "autoReplyEnabled")
       VALUES ($1, false)
       ON CONFLICT DO NOTHING`,
      [userId]
    );

    // INSERT workspace. The `name` column is the original pre-Phase-1
    // identifier; we use the same value as business_name so existing
    // code that reads `name` keeps working.
    //
    // Session D7: writes `plan` (canonical, migration 029) instead of the
    // retired `subscription_tier` column (dropped by migration 031). This
    // also fixes a latent bug — the previous code wrote subscription_tier
    // but left `plan` to its 'team' default, relying on a follow-up
    // customer.subscription.updated webhook to correct it. Now the plan
    // is set correctly on initial INSERT.
    const { rows: wsRows } = await client.query(
      `INSERT INTO workspaces (
         owner_user_id, name, business_name, area_code_preference,
         plan, subscription_status,
         stripe_subscription_id, created_during_signup
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, TRUE)
       RETURNING id`,
      [
        userId,
        draft.business_name,
        draft.business_name,
        draft.area_code || null,
        draft.plan,
        session.subscription || null,
      ]
    );
    const workspaceId = wsRows[0].id;

    // Twilio: search → purchase → configure. If anything fails, the
    // ROLLBACK in the outer catch undoes the user/workspace inserts;
    // we additionally try to release the number we may have purchased.
    let twilioPhone = null;
    let twilioSid = null;
    try {
      let candidates = [];
      if (draft.area_code) {
        candidates = await searchAvailableNumbers(draft.area_code, 5);
      }
      if (!candidates.length && draft.area_code_backup) {
        console.log('[orchestrator] primary area code ' + draft.area_code + ' empty; trying backup ' + draft.area_code_backup);
        candidates = await searchAvailableNumbers(draft.area_code_backup, 5);
      }
      if (!candidates.length) {
        throw new Error('No Twilio numbers available in primary or backup area code (primary=' + (draft.area_code || 'none') + ', backup=' + (draft.area_code_backup || 'none') + ')');
      }

      const purchased = await purchaseNumber(candidates[0].phone_number);
      twilioPhone = purchased.phone_number;
      twilioSid = purchased.phone_sid;
      purchasedSidForCleanup = twilioSid;

      const baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
      await configureNumberWebhooks(twilioSid, baseUrl);
    } catch (twilioErr) {
      throw new Error('Twilio provisioning failed: ' + twilioErr.message);
    }

    // Persist Twilio state on the workspace.
    await client.query(
      `UPDATE workspaces
          SET twilio_phone_number   = $1,
              twilio_phone_sid      = $2,
              twilio_provisioned_at = NOW()
        WHERE id = $3`,
      [twilioPhone, twilioSid, workspaceId]
    );

    // Mark the event processed BEFORE deleting the draft, so any
    // crash between these two steps would leave a re-processable
    // draft (safer than processed-but-draft-still-present).
    await client.query(
      `UPDATE stripe_events SET processed_at = NOW() WHERE stripe_event_id = $1`,
      [eventId]
    );

    // Data minimization: draft has served its purpose.
    await client.query(`DELETE FROM signup_drafts WHERE id = $1`, [draftId]);

    await client.query('COMMIT');
    purchasedSidForCleanup = null;  // committed — cleanup no longer applies

    console.log('[orchestrator] success: user_id=' + userId + ', workspace_id=' + workspaceId + ', twilio=' + twilioPhone);

    // Post-commit: welcome email. Non-fatal — workspace exists and
    // user can sign in even if SendGrid is down. Failure is logged
    // and welcome_email_sent_at stays NULL for future re-send.
    const baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
    try {
      await sendWelcomeEmail({
        to: draft.email,
        businessName: draft.business_name,
        username: draft.username,
        twilioPhone: twilioPhone,
        plan: draft.plan,
        billing: draft.billing,
        baseUrl,
      });
      await pool.query(
        `UPDATE workspaces SET welcome_email_sent_at = NOW() WHERE id = $1`,
        [workspaceId]
      );
      console.log('[orchestrator] welcome email sent to', draft.email);
    } catch (emailErr) {
      console.error('[orchestrator] welcome email failed (non-fatal):', emailErr.message);
    }

    return {
      ok: true,
      user_id: userId,
      workspace_id: workspaceId,
      twilio_phone_number: twilioPhone,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }

    // Best-effort release: if we purchased a number before the failure,
    // release it back to Twilio so we don't accrue rental.
    if (purchasedSidForCleanup) {
      try {
        await releaseNumber(purchasedSidForCleanup);
        console.error('[orchestrator] released purchased number ' + purchasedSidForCleanup + ' after failure');
      } catch (relErr) {
        console.error('[orchestrator] FAILED to release number ' + purchasedSidForCleanup + ' after failure (manual cleanup needed):', relErr.message);
      }
    }

    console.error('[orchestrator] failed for event ' + eventId + ':', err.message);

    // Stamp the error onto stripe_events.event_data for forensics.
    try {
      await pool.query(
        `UPDATE stripe_events
            SET event_data = jsonb_set(event_data, '{_orchestrator_error}', to_jsonb($2::text))
          WHERE stripe_event_id = $1`,
        [eventId, err.message]
      );
    } catch (e) { /* log only */ console.error('[orchestrator] could not stamp error on event:', e.message); }

    // Notify operator (SMS via Twilio + email via SendGrid).
    try {
      await notifyOperatorOfFailure(pool, err.message, {
        event_id: eventId,
        draft_id: draftId,
        stripe_session_id: session.id,
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        purchased_sid_to_check: purchasedSidForCleanup,
        error: err.message,
      });
    } catch (notifyErr) {
      console.error('[orchestrator] operator notification failed:', notifyErr.message);
    }

    return { ok: false, reason: 'orchestration_failed', error: err.message };
  } finally {
    client.release();
  }
}

module.exports = { processCheckoutCompletedEvent };

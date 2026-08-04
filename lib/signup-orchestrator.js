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
  searchAnyAvailableNumber,
  purchaseNumber,
  configureNumberWebhooks,
  releaseNumber,
} = require('./twilio-provisioning');
const verticals = require('./verticals');
// AD8 (c): the ONE owner-alert chain — operator failures ride it too.
const { sendOwnerAlert } = require('./owner-alert');

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

// SP2: the phone block renders the TRUTH. Under async provisioning
// (SP4) the welcome mail can leave before the number lands — a missing
// number is a STATE, never a blank, "null", or a share-this-number
// promise with nothing to share. One helper, all four builders.
function phoneBlockContent(twilioPhone, shareLine) {
  if (twilioPhone) return { value: twilioPhone, help: shareLine };
  return {
    value: 'Being set up',
    help: 'Your dedicated number is still being provisioned — it will appear on your ' +
      'account page shortly, and texts and calls will route the moment it does.',
  };
}

// E11: vertical-aware subject. PS gets a service-business-flavored line;
// PM keeps the original subject unchanged.
function welcomeEmailSubject(vertical) {
  if (vertical === 'professional-services') {
    return 'Welcome to Modern Management — your AI assistant is ready';
  }
  return 'Welcome to Modern Management — your workspace is ready';
}

function welcomeEmailHtml({ businessName, username, twilioPhone, plan, billing, baseUrl, vertical }) {
  // E11: branch on vertical for PS-flavored copy. PM body unchanged.
  if (vertical === 'professional-services') {
    return welcomeEmailHtmlPS({ businessName, username, twilioPhone, plan, baseUrl });
  }
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1) + ' / ' +
    (billing === 'annual' ? 'Annual' : 'Monthly');
  const pb = phoneBlockContent(twilioPhone, 'Share this number with your tenants for SMS and voice. Modern Management\'s AI handles routine inquiries; you get notified for the rest.');
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
    '<div style="font-size:1.6em;font-weight:800;color:#c2410c;letter-spacing:-0.3px;">' + escapeHtml(pb.value) + '</div>',
    '<div style="font-size:0.85em;color:#9a3412;margin-top:8px;line-height:1.4;">' + escapeHtml(pb.help) + '</div>',
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

function welcomeEmailText({ businessName, username, twilioPhone, plan, billing, baseUrl, vertical }) {
  if (vertical === 'professional-services') {
    return welcomeEmailTextPS({ businessName, username, twilioPhone, plan, baseUrl });
  }
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1) + ' / ' +
    (billing === 'annual' ? 'Annual' : 'Monthly');
  const pb = phoneBlockContent(twilioPhone, 'Share this number with your tenants for SMS and voice. Modern Management\'s AI handles routine inquiries; you get notified for the rest.');
  return [
    'Welcome to Modern Management',
    '',
    'Hi ' + businessName + ' — your workspace is live.',
    '',
    'YOUR BUSINESS PHONE NUMBER:',
    '  ' + pb.value,
    '',
    pb.help,
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

// ---------------------------------------------------------------------
// E11 — Welcome email, Professional Services variant.
// Service-business-flavored copy: customers + appointments instead of
// tenants + units. Same prominent phone callout and "what happens next"
// pattern as PM, but the tone and next-steps point at services, products,
// and customer text handling rather than rent and maintenance.
// ---------------------------------------------------------------------

function welcomeEmailHtmlPS({ businessName, username, twilioPhone, plan, baseUrl }) {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1) + ' / Monthly';
  const pb = phoneBlockContent(twilioPhone, 'Share this number with your customers for texts and calls. Your AI handles routine booking questions and triages anything that needs you.');
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><title>Welcome</title></head>',
    '<body style="margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#2d3748;">',
    '<div style="max-width:540px;margin:0 auto;padding:24px 16px;">',
    '<div style="background:white;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.04);">',
    '<h1 style="margin:0 0 8px;font-size:1.4em;color:#2d3748;">Welcome to Modern Management</h1>',
    '<p style="color:#64748b;margin:0 0 20px;">Hi ' + escapeHtml(businessName) + ' &mdash; your AI assistant is ready.</p>',
    // Prominent phone callout
    '<div style="background:linear-gradient(135deg,#fff7ed,#ffedd5);border:1px solid #fed7aa;border-radius:10px;padding:18px;margin:22px 0;">',
    '<div style="font-size:0.78em;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;">Your business phone number</div>',
    '<div style="font-size:1.6em;font-weight:800;color:#c2410c;letter-spacing:-0.3px;">' + escapeHtml(pb.value) + '</div>',
    '<div style="font-size:0.85em;color:#9a3412;margin-top:8px;line-height:1.4;">' + escapeHtml(pb.help) + '</div>',
    '</div>',
    // What happens next
    '<h2 style="font-size:1em;color:#2d3748;margin:24px 0 8px;">What happens next</h2>',
    '<p style="font-size:0.9em;color:#475569;line-height:1.6;">When customers text or call your new number, your AI reads the message, checks your calendar and your services menu, and either replies automatically or queues a draft for your review. You stay in control — every action that goes to a customer waits for your tap unless you turn auto-respond on.</p>',
    // Sign in
    '<h2 style="font-size:1em;color:#2d3748;margin:24px 0 8px;">Sign in</h2>',
    '<p style="font-size:0.9em;color:#475569;line-height:1.6;">Visit <a href="' + escapeHtml(baseUrl) + '/login" style="color:#ff6b6b;">' + escapeHtml(baseUrl) + '/login</a> with username <strong>' + escapeHtml(username) + '</strong> and the password you set during signup.</p>',
    '<p style="font-size:0.85em;color:#64748b;margin-top:4px;">Your plan: <strong>' + escapeHtml(planLabel) + '</strong>. Manage billing in Settings.</p>',
    // Getting started — PS flavor
    '<h2 style="font-size:1em;color:#2d3748;margin:24px 0 8px;">Getting started</h2>',
    '<ul style="font-size:0.9em;color:#475569;line-height:1.7;padding-left:22px;margin:0;">',
    '<li>Build your menu. Add the services and products you offer in Services &amp; Products.</li>',
    '<li>Add your customers in Contacts &mdash; one by one or via CSV import.</li>',
    '<li>Connect your phone number to your AI: open Admin and turn on auto-respond when you\'re ready to let the AI reply on its own.</li>',
    '</ul>',
    '<p style="font-size:0.85em;color:#94a3b8;margin-top:24px;padding-top:18px;border-top:1px solid #e2e8f0;">Need help? Reply to this email &mdash; I\'m here for you.<br>&mdash; Jay</p>',
    '</div></div></body></html>',
  ].join('');
}

function welcomeEmailTextPS({ businessName, username, twilioPhone, plan, baseUrl }) {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1) + ' / Monthly';
  const pb = phoneBlockContent(twilioPhone, 'Share this number with your customers for texts and calls. Your AI handles routine booking questions and triages anything that needs you.');
  return [
    'Welcome to Modern Management',
    '',
    'Hi ' + businessName + ' — your AI assistant is ready.',
    '',
    'YOUR BUSINESS PHONE NUMBER:',
    '  ' + pb.value,
    '',
    pb.help,
    '',
    'WHAT HAPPENS NEXT',
    'When customers text or call your new number, your AI reads the message, checks your calendar and your services menu, and either replies automatically or queues a draft for your review. You stay in control — every action that goes to a customer waits for your tap unless you turn auto-respond on.',
    '',
    'SIGN IN',
    'Visit ' + baseUrl + '/login with username "' + username + '" and the password you set during signup.',
    'Your plan: ' + planLabel + '. Manage billing in Settings.',
    '',
    'GETTING STARTED',
    '* Build your menu. Add the services and products you offer in Services & Products.',
    '* Add your customers in Contacts — one by one or via CSV import.',
    "* Connect your phone number to your AI: open Admin and turn on auto-respond when you're ready to let the AI reply on its own.",
    '',
    "Need help? Reply to this email — I'm here for you.",
    '— Jay',
  ].join('\n');
}

async function sendWelcomeEmail({ to, businessName, username, twilioPhone, plan, billing, baseUrl, vertical }) {
  await sgMail.send({
    to,
    from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
    replyTo: process.env.SENDGRID_FROM_EMAIL,
    subject: welcomeEmailSubject(vertical),
    text: welcomeEmailText({ businessName, username, twilioPhone, plan, billing, baseUrl, vertical }),
    html: welcomeEmailHtml({ businessName, username, twilioPhone, plan, billing, baseUrl, vertical }),
  });
}

// ---------------------------------------------------------------------
// Operator failure alert: SMS to admin's alert_phone, email fallback.
// Mirrors the pattern from sendOwnerEmergencyAlert in server.js.
// ---------------------------------------------------------------------

// AD8 (c): this was the last inline copy of the alert_phone SMS ->
// notification_email -> account-email routing. It now rides the ONE
// chain (lib/owner-alert.sendOwnerAlert), which carries AD5's
// verification gating and AD6's shared sender for free.
// respectEnabled:false — an operator failure is an alarm, always
// sent (the emergency posture). The current operator's channels are
// grandfather-verified, so gating changes nothing today and is
// correct going forward.
async function notifyOperatorOfFailure(pool, message, context) {
  let adminId;
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      ['admin']
    );
    if (!rows.length) {
      console.error('[orchestrator-alert] admin row missing — cannot notify operator');
      return;
    }
    adminId = rows[0].id;
  } catch (err) {
    console.error('[orchestrator-alert] admin lookup failed:', err.message);
    return;
  }

  const smsBody = ('Modern Management ALERT: Signup orchestration failed. ' + message).slice(0, 320);
  const sent = await sendOwnerAlert(
    { db: pool, twilio: getTwilioClient(), sendgrid: sgMail, env: process.env, logger: console },
    adminId,
    {
      smsBody,
      emailSubject: 'URGENT: Signup orchestration failure',
      emailText: 'Modern Management ALERT: Signup orchestration failed. ' + message +
        '\n\nContext:\n' + JSON.stringify(context, null, 2),
      respectEnabled: false,
    }
  );
  if (sent) {
    console.log('[orchestrator-alert]', sent, 'sent to operator');
  } else {
    console.error('[orchestrator-alert] operator NOT reached (no verified channel or send failed)');
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
    //
    // Session E1: writes `vertical` from session.metadata.vertical (set
    // by /api/signup/create-checkout-session). validateVertical() falls
    // back to the default ('property-management') for any unknown or
    // missing value, so legacy callers and missing metadata are safe.
    //
    // Session E11: ALSO writes the legacy `vertical_type` column (snake_case
    // values like 'professional_services') alongside `vertical` (hyphenated).
    // They're not kept in sync automatically, but the partial unique index
    // `workspaces_one_per_owner_backfill_uq` is defined as
    // `UNIQUE (owner_user_id) WHERE vertical_type = 'property_management'`,
    // so a PS workspace whose vertical_type is unset would collide with
    // a PM workspace under the same owner. Writing both columns avoids
    // that collision and keeps PS signups working when a user already
    // owns a PM workspace.
    const verticalSlug = verticals.validateVertical(
      (session.metadata && session.metadata.vertical) || verticals.DEFAULT_VERTICAL
    );
    const verticalLegacy = verticalSlug === 'professional-services'
      ? 'professional_services'
      : 'property_management';
    // Decide initial subscription_status from the Checkout Session's
    // payment_status:
    //   'paid'                — first invoice settled; activate.
    //   'no_payment_required' — trial signup or 100%-off coupon; Stripe
    //                            considers the session done and the
    //                            subscription is valid (status='trialing'
    //                            or 'active'); activate.
    //   'unpaid'              — async/SCA/ACH payment is genuinely
    //                            pending; INSERT as 'incomplete' and let
    //                            a later customer.subscription.updated
    //                            event promote the workspace once Stripe
    //                            confirms settlement.
    const initialSubscriptionStatus =
      (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')
        ? 'active'
        : 'incomplete';
    const { rows: wsRows } = await client.query(
      `INSERT INTO workspaces (
         owner_user_id, name, business_name, area_code_preference,
         plan, vertical, vertical_type, subscription_status,
         stripe_subscription_id, created_during_signup
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
       RETURNING id`,
      [
        userId,
        draft.business_name,
        draft.business_name,
        draft.area_code || null,
        draft.plan,
        verticalSlug,
        verticalLegacy,
        initialSubscriptionStatus,
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
      // Rung 1: customer's primary area code
      if (draft.area_code) {
        candidates = await searchAvailableNumbers(draft.area_code, 5);
      }
      // Rung 2: customer's backup area code
      if (!candidates.length && draft.area_code_backup) {
        console.log('[orchestrator] primary area code ' + draft.area_code + ' empty; trying backup ' + draft.area_code_backup);
        candidates = await searchAvailableNumbers(draft.area_code_backup, 5);
      }
      // Rung 3: platform-configured fallback area code (env var). Wrapped so
      // a misconfigured env value (e.g. non-3-digit) doesn't abort signup —
      // we log and fall through to rung 4.
      if (!candidates.length && process.env.TWILIO_FALLBACK_AREA_CODE) {
        console.log('[orchestrator] user area codes empty; trying TWILIO_FALLBACK_AREA_CODE=' + process.env.TWILIO_FALLBACK_AREA_CODE);
        try {
          candidates = await searchAvailableNumbers(process.env.TWILIO_FALLBACK_AREA_CODE, 5);
        } catch (fallbackErr) {
          console.error('[orchestrator] TWILIO_FALLBACK_AREA_CODE search errored (continuing to any-US fallback):', fallbackErr.message);
        }
      }
      // Rung 4: any US local number with SMS+Voice. Last line of defense so
      // the customer never gets a failed signup after a successful Stripe
      // payment just because their requested area codes were dry.
      if (!candidates.length) {
        console.log('[orchestrator] all area-code searches empty; trying any US local number with SMS+Voice');
        candidates = await searchAnyAvailableNumber(5);
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

    // Persist Twilio state on the workspace. SP3: twilio_status flips
    // to 'active' in the SAME statement that writes the number — one
    // write, no window where the two can diverge (the AD5 trust-reset
    // principle), and the 061 CHECK holds by construction.
    await client.query(
      `UPDATE workspaces
          SET twilio_phone_number   = $1,
              twilio_phone_sid      = $2,
              twilio_provisioned_at = NOW(),
              twilio_status         = 'active',
              twilio_last_error     = NULL
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
        // E11: pass the vertical so the email template renders the
        // right copy (subject + body + HTML all branch on this).
        vertical: verticalSlug,
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

// SP2: the welcome-email builders are exported so the null-phone suite
// drives all four render paths (they're pure string builders).
module.exports = { processCheckoutCompletedEvent, welcomeEmailHtml, welcomeEmailText };

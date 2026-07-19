require('dotenv').config();

// --- Sentry error monitoring ---
// Must be initialized as early as possible, before any other requires that
// might throw, so Sentry can instrument them. Graceful no-op if SENTRY_DSN
// is not set (e.g. local development without monitoring).
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    // Sampling: 100% of errors captured, 10% of successful transactions
    // traced for performance monitoring. Tuned for the Sentry free tier
    // (~5k events/month) at current production scale.
    sampleRate: 1.0,
    tracesSampleRate: 0.1,
  });
  console.log('Sentry initialized (environment: ' + (process.env.NODE_ENV || 'production') + ')');
}

const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk').default;
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);
// LEGACY: STRIPE_SECRET_KEY is no longer referenced after D7's route
// retirement. The `stripe` client below is unused as of D8. Kept for now
// (the `null` fallback makes a missing env var non-fatal). Future env-var
// consolidation can remove both the env var and this client. Do NOT add
// new code that uses this client — use `stripeSignup` (STRIPE_TEST_SECRET_KEY)
// for all new Stripe work.
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Phase B B2: separate Stripe client for the new signup flow. Uses
// STRIPE_TEST_SECRET_KEY (test mode) so the legacy /api/billing/*
// paths — which still use the original `stripe` client above — stay
// untouched. Env-var rename / consolidation happens in Phase B5
// before production launch.
const stripeSignup = process.env.STRIPE_TEST_SECRET_KEY
  ? new Stripe(process.env.STRIPE_TEST_SECRET_KEY)
  : null;

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Phase B B4: signup orchestrator. Triggered from /api/stripe/webhook
// when a checkout.session.completed event arrives. Pool is passed at
// call time so this module stays leaf (no server.js dependency).
const { processCheckoutCompletedEvent } = require('./lib/signup-orchestrator');

// Session E1: vertical registry. Backs /api/verticals and /signup/vertical,
// validates the vertical slug coming in via /api/signup/create-checkout-session
// before forwarding it to Stripe metadata.
const verticals = require('./lib/verticals');

// Session E2: appointment engine. Handles inbound SMS / voicemail for
// PS workspaces with appointment_auto_respond=true. Runs ADDITIVELY in
// /api/sms/incoming and /api/voice/transcription — when it returns
// handled=false, the existing emergency-detection / auto-reply paths
// fire as before.
const appointmentEngine = require('./lib/appointment-engine');
const voiceTranscript = require('./lib/voice-transcript');

// Session D3: subscription lifecycle event processors. Handle
// customer.subscription.updated, customer.subscription.deleted, and
// invoice.payment_failed so workspaces.subscription_status tracks
// Stripe's source-of-truth state instead of staying 'active' forever.
const subscriptionLifecycle = require('./lib/subscription-lifecycle');

// E13: Stripe Connect (Express) onboarding state sync. Test mode only —
// this module does NOT handle any charge / payment-intent code, just
// keeps workspaces.connect_status in lockstep with the connected
// account's Stripe state.
const connectLifecycle = require('./lib/connect-lifecycle');

// E14: customer-payment ledger + recompute (sole writer of
// transactions.amount_paid_cents) and the webhook handler that flips
// pending ledger rows to completed when Stripe Checkout confirms a
// direct charge on the connected account.
const paymentLedger = require('./lib/payment-ledger');

// E14 Stage 1: shared payment-request helper. Backs the modal button
// today (POST /api/transactions/:id/request-payment) and is the entry
// point a future AI tool will use to propose payment-request batches.
// All Stripe + ledger + SMS logic lives here, so the AI path and the
// button path are guaranteed identical (including the double-send guard).
const paymentRequests = require('./lib/payment-requests');

// Session E3: receipt formatting + delivery (email > SMS > save) for the
// transactions table. Used by the complete_transaction AI tool and by the
// /api/transactions/:id/send-receipt endpoint below.
const receipts = require('./lib/receipts');

// Session B1: populate the AI tool registry at startup. Tool modules
// in lib/tools/ self-register when imported. The registry is dormant
// until Session B2 wires it into /api/command — until then this is a
// no-op for runtime behavior but exposes the tools for verification.
require('./lib/tools');

// Session D1: central pricing/capability config. Loaded at startup so
// future enforcement paths can require('./lib/plans') from anywhere.
// No enforcement happens in D1 — this is foundation only.
const plans = require('./lib/plans');

// Session D2: usage tracking helpers (best-effort upsert counters).
// /api/command increments per successful AI request; report-creation
// paths increment once per saved report.
const usage = require('./lib/usage');

// Session D4: plan enforcement layer. Bundles plans + usage with
// workspace-fetch + status-check semantics. Route handlers call into
// this module to gate AI commands, report generation, and resource
// creation on subscription status, feature flags, and usage caps.
const planEnforcement = require('./lib/plan-enforcement');

// Session D7: central app config. Single source of truth for the
// Anthropic model name (used to be hardcoded in 8 call sites here).
const config = require('./lib/config');

// Session D8: validate critical env vars at startup. Fail loudly if any
// are missing so misconfigured deployments error before serving traffic
// rather than failing later when the missing credential is first used.
//
// The list intentionally excludes legacy STRIPE_SECRET_KEY (D7 retirement)
// and optional toggles (NODE_ENV, ENABLE_DEBUG_ENDPOINTS, APP_URL, PORT,
// PUBLIC_BASE_URL, MAINTENANCE_PHONE, NOTIFICATION_EMAIL, SENTRY_DSN,
// ADMIN_USERNAME, ADMIN_PASSWORD).
function validateRequiredEnv() {
  const required = [
    'DATABASE_URL',
    'SESSION_SECRET',
    'ANTHROPIC_API_KEY',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'SENDGRID_API_KEY',
    'SENDGRID_FROM_EMAIL',
    'STRIPE_TEST_SECRET_KEY',     // new-flow Stripe client
    'STRIPE_TEST_WEBHOOK_SECRET', // new-flow Stripe webhook signature secret
  ];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length > 0) {
    console.error('[startup] FATAL: Missing required env vars:', missing.join(', '));
    console.error('[startup] Server cannot start without these. Configure them in your environment, then restart.');
    process.exit(1);
  }
  console.log('[startup] Env validation passed.');
}
validateRequiredEnv();

// SESSION_SECRET is required — refuse to start with a weak default.
// Belt-and-suspenders: validateRequiredEnv() above also catches this,
// but the explicit message here gives the user the generate-one command.
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set.');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

// PWA Stage B: web-push config. VAPID keys are optional — if any of the
// three vars is missing the module is left unconfigured and push is a
// no-op (the server still boots, the subscribe endpoint still records
// rows, but no actual sends happen until the keys are set).
const webpush = require('web-push');
let pushConfigured = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  pushConfigured = true;
  console.log('[push] web-push configured.');
} else {
  console.warn('[push] VAPID env vars missing — push disabled.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const app = express();
// Trust the first proxy hop (Render's load balancer) so req.ip
// returns the real client IP for audit-log writes (sub-step D).
// Without this, req.ip captures the proxy's address (typically
// 127.0.0.1 / 10.x.x.x) and audit trails are useless.
app.set('trust proxy', 1);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 4000;

// Phase B B7: rate limiters for public signup + auth endpoints.
// Per-IP, in-memory store (resets on server restart). For multi-instance
// production deploys, swap to a Redis-backed store. For Render single-instance
// deploys this is fine. trust proxy:1 is already set above so req.ip resolves
// to the real client IP behind Render's load balancer.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const standardOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  // Identify by the real client IP (works because of trust proxy:1).
  // ipKeyGenerator handles IPv4 + IPv6 normalization (per express-rate-limit v8 docs).
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  // 429 response body — JSON, not HTML, since these endpoints serve JSON.
  handler: (req, res, _next, options) => {
    console.warn('[rate-limit] ' + req.method + ' ' + req.path + ' blocked for ip=' + req.ip);
    res.status(options.statusCode).json({
      error: options.message || 'Too many requests. Please slow down and try again shortly.',
    });
  },
};

const signupCheckLimiter = rateLimit({
  ...standardOpts,
  windowMs: 60 * 1000,           // 1 minute
  max: 60,                       // 60 per minute per IP
  message: 'Too many checks. Please wait a minute and try again.',
});

const signupCheckoutLimiter = rateLimit({
  ...standardOpts,
  windowMs: 60 * 60 * 1000,      // 1 hour
  max: 20,                       // 20 per hour per IP
  message: 'Too many signup attempts. Please wait an hour and try again.',
});

const passwordResetRequestLimiter = rateLimit({
  ...standardOpts,
  windowMs: 60 * 60 * 1000,      // 1 hour
  max: 10,                       // 10 per hour per IP
  message: 'Too many password reset requests. Please wait an hour and try again.',
});
const BCRYPT_ROUNDS = 10;

app.use(cors());
// Raw body needed for Stripe webhook signature verification — must be before bodyParser
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
// Phase B B2: signup-flow Stripe webhook (separate from /api/billing/webhook
// which serves the legacy live-mode flow). Same raw-body requirement.
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
// Required on Render (and any reverse proxy that terminates HTTPS) so
// Express knows the connection is secure and will actually set the
// Secure cookie flag. Without this, cookie: { secure: true } silently
// drops the session cookie in production.
app.set('trust proxy', 1);
app.use(session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Serve public static files (landing, login, signup pages)
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// --- Auth helpers ---
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
function requireAuthPage(req, res, next) {
  if (req.session && req.session.authenticated && req.session.userId) return next();
  res.redirect('/login');
}

// Validates the X-Twilio-Signature header on inbound Twilio webhook
// POSTs (SMS + voice). Runs BEFORE the route handler so a bad signature
// is rejected with 403 before any DB work or TwiML response happens.
//
// URL derivation: Twilio signs the exact URL it called. We prefer
// PUBLIC_BASE_URL when set (belt-and-suspenders for edge cases where
// x-forwarded-* is stripped or rewritten by an intermediate proxy);
// otherwise we reconstruct from req.protocol + req.get('host') +
// req.originalUrl. `trust proxy` = 1 is set above so req.protocol and
// req.get('host') already honor Render's X-Forwarded-* headers.
//
// Escape hatch: TWILIO_VALIDATE_WEBHOOKS=false disables validation
// with a loud warning per request. Default is enabled. Intended as a
// one-env-var rollback if live traffic breaks after deploy — flip it
// back to remove the bypass.
function validateTwilioSignature(req, res, next) {
  if (process.env.TWILIO_VALIDATE_WEBHOOKS === 'false') {
    console.warn('[twilio-validate] BYPASS — TWILIO_VALIDATE_WEBHOOKS=false; accepting', req.originalUrl, 'without signature check');
    return next();
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('[twilio-validate] TWILIO_AUTH_TOKEN not set — cannot validate', req.originalUrl);
    return res.status(500).type('text/plain').send('Server misconfigured');
  }
  const signature = req.header('x-twilio-signature');
  if (!signature) {
    console.warn('[twilio-validate] Missing X-Twilio-Signature header on', req.originalUrl, 'from', req.ip);
    return res.status(403).type('text/plain').send('Forbidden');
  }
  const base = process.env.PUBLIC_BASE_URL
    ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')
    : (req.protocol + '://' + req.get('host'));
  const publicUrl = base + req.originalUrl;
  const ok = twilio.validateRequest(authToken, signature, publicUrl, req.body || {});
  if (!ok) {
    console.warn('[twilio-validate] Bad signature for', publicUrl, 'from', req.ip);
    return res.status(403).type('text/plain').send('Forbidden');
  }
  next();
}

// --- Workspace helper ---
// Every authenticated user owns exactly one workspace (1:1 seeded by
// Phase 1 migration 008). getWorkspaceId() looks up that workspace id
// for the caller and caches it on the request to avoid repeat queries
// within a single request. Used by Inventory endpoints (/api/entities,
// /api/offerings, /api/engagements) to scope all reads/writes to the
// caller's workspace. Returns null if the user somehow has no workspace
// (should never happen post-Phase-1; callers should treat null as 500).
async function getWorkspaceId(req) {
  if (req._workspaceId != null) return req._workspaceId;
  const { rows } = await pool.query(
    'SELECT id FROM workspaces WHERE owner_user_id = $1 ORDER BY id DESC LIMIT 1',
    [req.session.userId]
  );
  req._workspaceId = rows[0]?.id ?? null;
  return req._workspaceId;
}

// --- Page routes ---

// Session E2.5: parent landing (multi-vertical chooser). Replaces the old
// PM-focused landing.html at /. The previous file is preserved at
// /landing-legacy for reference but is no longer linked from anywhere
// public-facing; it can be removed in a future cleanup.
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/workspace');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Session E2.5: vertical-specific landing pages.
app.get('/property-management', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/workspace');
  res.sendFile(path.join(__dirname, 'public', 'property-management.html'));
});
app.get('/professional-services', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/workspace');
  res.sendFile(path.join(__dirname, 'public', 'professional-services.html'));
});

// Session E2.5: legacy single-vertical landing kept reachable for reference.
// Not linked from any public surface. Safe to remove in a future cleanup.
app.get('/landing-legacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/workspace');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/signup', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/workspace');
  // Phase B B1: now serves the multi-screen signup form from views/.
  // The legacy single-screen public/signup.html is left on disk as a
  // backup but no longer routed.
  res.sendFile(path.join(__dirname, 'views', 'signup.html'));
});

// Session E1: vertical-selection page. New customers can land here to
// pick their vertical (Property Management or Professional Services)
// before continuing to /signup. The signup form itself reads the
// chosen slug from ?vertical=... in the URL.
app.get('/signup/vertical', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/workspace');
  res.sendFile(path.join(__dirname, 'views', 'signup-vertical.html'));
});

// Phase B B2: Stripe Checkout success-redirect destination. Stripe
// appends ?session_id={CHECKOUT_SESSION_ID}&draft_id=<id> to this
// URL (configured in success_url at session-create time). The page
// itself is a placeholder until B4 wires actual account creation.
app.get('/signup/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'signup-success.html'));
});

// Phase B B2: Stripe Checkout cancel-redirect destination. Receives
// ?draft_id=<id>. Page invites user back to /signup with sessionStorage
// already preserving their entered data (same-origin survives the
// Stripe round-trip).
app.get('/signup/canceled', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'signup-canceled.html'));
});

// Phase B B6: password reset pages (public — no auth).
app.get('/forgot-password', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'forgot-password.html'));
});
app.get('/reset-password', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});
app.get('/workspace', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'app.html'));
});
app.get('/styleguide', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'styleguide.html'));
});

// --- Marketing sub-pages ---
app.get('/sms-consent', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'sms-consent.html')));
app.get('/how-it-works', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'how-it-works.html')));
app.get('/why-ai', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'why-ai.html')));
app.get('/terms', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/security', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'security.html')));
app.get('/changelog', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'changelog.html')));
app.get('/features/ai', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'ai.html')));
app.get('/features/inbox', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'inbox.html')));
app.get('/features/rent-and-leases', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'rent-and-leases.html')));
app.get('/features/broadcasts-and-contacts', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'broadcasts-and-contacts.html')));
app.get('/features/maintenance', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'maintenance.html')));
app.get('/features/budget', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'budget.html')));
app.get('/features/tasks', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'tasks.html')));
app.get('/features/reports', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'reports.html')));
app.get('/features/calendar', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'calendar.html')));
app.get('/features/knowledge-base', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'knowledge-base.html')));

// --- Database setup & migrations ---
// Safe migration helper — logs errors but never crashes the server
async function migrate(sql, label) {
  try {
    await pool.query(sql);
  } catch (err) {
    console.warn(`Migration skipped [${label}]:`, err.message);
  }
}

// --- Payment forwarding helpers ---
// Short URL-safe random token (no ambiguous chars)
function generateForwardToken() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0,o,i,l,1
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// --- Credential encryption for stored app passwords ---
// Uses AES-256-GCM with a key derived from SESSION_SECRET
function _getEncryptionKey() {
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET required for encryption');
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest();
}
function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}
function decryptSecret(ciphertext) {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// --- Auto-detect IMAP/SMTP settings for major providers ---
function detectEmailProvider(email) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  const providers = {
    'gmail.com':       { name: 'gmail',    imap: 'imap.gmail.com',         smtp: 'smtp.gmail.com' },
    'googlemail.com':  { name: 'gmail',    imap: 'imap.gmail.com',         smtp: 'smtp.gmail.com' },
    'outlook.com':     { name: 'outlook',  imap: 'outlook.office365.com',  smtp: 'smtp.office365.com' },
    'hotmail.com':     { name: 'outlook',  imap: 'outlook.office365.com',  smtp: 'smtp.office365.com' },
    'live.com':        { name: 'outlook',  imap: 'outlook.office365.com',  smtp: 'smtp.office365.com' },
    'office365.com':   { name: 'outlook',  imap: 'outlook.office365.com',  smtp: 'smtp.office365.com' },
    'yahoo.com':       { name: 'yahoo',    imap: 'imap.mail.yahoo.com',    smtp: 'smtp.mail.yahoo.com' },
    'icloud.com':      { name: 'icloud',   imap: 'imap.mail.me.com',       smtp: 'smtp.mail.me.com' },
    'me.com':          { name: 'icloud',   imap: 'imap.mail.me.com',       smtp: 'smtp.mail.me.com' },
    'aol.com':         { name: 'aol',      imap: 'imap.aol.com',           smtp: 'smtp.aol.com' },
    'zoho.com':        { name: 'zoho',     imap: 'imap.zoho.com',          smtp: 'smtp.zoho.com' },
    'proton.me':       { name: 'proton',   imap: '127.0.0.1',              smtp: '127.0.0.1' }, // ProtonMail requires bridge
  };
  if (providers[domain]) return { ...providers[domain], imap_port: 993, smtp_port: 465, domain };
  return { name: 'custom', imap: `imap.${domain}`, smtp: `smtp.${domain}`, imap_port: 993, smtp_port: 465, domain };
}

// --- Test an IMAP connection without saving ---
async function testImapConnection({ email, password, imap_host, imap_port }) {
  const client = new ImapFlow({
    host: imap_host,
    port: imap_port || 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false
  });
  try {
    await client.connect();
    const mailboxes = await client.list();
    await client.logout();
    return { success: true, mailboxCount: mailboxes.length };
  } catch (err) {
    try { await client.close(); } catch (_) {}
    return { success: false, error: err.message };
  }
}

// --- Send an email using a connected account's SMTP ---
async function sendViaConnectedAccount(userId, { to, subject, text, html, replyTo }) {
  const { rows } = await pool.query('SELECT * FROM email_accounts WHERE user_id=$1', [userId]);
  if (!rows.length) return { success: false, error: 'No connected email account' };
  const acct = rows[0];
  const password = decryptSecret(acct.encrypted_password);
  const transporter = nodemailer.createTransport({
    host: acct.smtp_host,
    port: acct.smtp_port,
    secure: acct.smtp_port === 465,
    auth: { user: acct.email, pass: password }
  });
  try {
    const info = await transporter.sendMail({
      from: acct.email,
      to, subject, text, html,
      replyTo: replyTo || acct.email
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('SMTP send error:', err.message);
    return { success: false, error: err.message };
  }
}

// --- Sync new mail from a connected IMAP account into messages table ---
async function syncEmailAccount(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM email_accounts WHERE user_id=$1 AND sync_enabled=true`,
    [userId]
  );
  if (!rows.length) return { synced: 0, skipped: true };
  const acct = rows[0];
  const password = decryptSecret(acct.encrypted_password);

  const client = new ImapFlow({
    host: acct.imap_host,
    port: acct.imap_port,
    secure: true,
    auth: { user: acct.email, pass: password },
    logger: false
  });

  let synced = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const lastUid = acct.last_sync_uid || 0;
      // Fetch messages with UID > lastUid
      const search = lastUid > 0 ? { uid: `${lastUid + 1}:*` } : { seen: false };
      let maxUid = lastUid;
      for await (const msg of client.fetch(search, { envelope: true, source: true, uid: true })) {
        if (msg.uid <= lastUid) continue;
        maxUid = Math.max(maxUid, msg.uid);
        const env = msg.envelope || {};
        const fromAddr = env.from?.[0] || {};
        const from = fromAddr.address || 'unknown';
        const name = fromAddr.name || from;
        const subject = env.subject || '(No subject)';
        // Extract plain text from raw source
        const src = msg.source ? msg.source.toString('utf8') : '';
        const body = extractTextFromEmail(src).slice(0, 8000);

        // Skip payment-forwarded self-emails
        if (from.includes('payments+')) continue;

        await pool.query(
          `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, email)
           VALUES ($1,$2,$3,'email',$4,'new','inbox',$5)`,
          [userId, name, subject, body || '(No body)', from]
        );
        synced++;
      }
      if (maxUid > lastUid) {
        await pool.query(
          `UPDATE email_accounts SET last_sync_uid=$1, last_sync_at=NOW() WHERE id=$2`,
          [maxUid, acct.id]
        );
      } else {
        await pool.query(`UPDATE email_accounts SET last_sync_at=NOW() WHERE id=$1`, [acct.id]);
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { synced };
  } catch (err) {
    console.error(`IMAP sync error for user ${userId}:`, err.message);
    try { await client.close(); } catch (_) {}
    return { synced, error: err.message };
  }
}

// Very naive plain-text extraction from raw RFC822 email
function extractTextFromEmail(raw) {
  if (!raw) return '';
  // Find end of headers
  const sep = raw.indexOf('\r\n\r\n');
  const body = sep >= 0 ? raw.slice(sep + 4) : raw;
  // Strip HTML if present, collapse whitespace
  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Background sync: every 5 minutes, sync all connected accounts
async function runPeriodicEmailSync() {
  try {
    const { rows } = await pool.query(
      `SELECT user_id FROM email_accounts WHERE sync_enabled=true`
    );
    for (const r of rows) {
      await syncEmailAccount(r.user_id).catch(err => console.error('sync worker error:', err.message));
    }
  } catch (err) {
    console.error('Periodic sync error:', err.message);
  }
}
setInterval(runPeriodicEmailSync, 5 * 60 * 1000); // 5 minutes

// Phase B B5: cleanup of expired signup_drafts. Drafts have a 24h
// expires_at default (migration 024). The orchestrator's draft lookup
// already filters on expires_at > NOW(), so expired rows are functionally
// invisible — but they hold bcrypt password hashes and should not linger.
// Runs every 6 hours; cheap query (single DELETE on an indexed column).
async function runSignupDraftCleanup() {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM signup_drafts WHERE expires_at < NOW()'
    );
    if (rowCount > 0) {
      console.log(`[draft-cleanup] Deleted ${rowCount} expired signup draft(s)`);
    }
  } catch (err) {
    console.error('[draft-cleanup] error:', err.message);
  }
}
setInterval(runSignupDraftCleanup, 6 * 60 * 60 * 1000); // every 6 hours
// Run once at startup so the table doesn't accumulate cruft during
// long-running dev sessions or after a deploy.
runSignupDraftCleanup();

// Phase B B6: cleanup of used or expired password reset tokens.
async function runPasswordResetTokenCleanup() {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM password_reset_tokens WHERE expires_at < NOW() OR used_at IS NOT NULL`
    );
    if (rowCount > 0) {
      console.log(`[reset-token-cleanup] Deleted ${rowCount} used/expired password reset token(s)`);
    }
  } catch (err) {
    console.error('[reset-token-cleanup] error:', err.message);
  }
}
setInterval(runPasswordResetTokenCleanup, 6 * 60 * 60 * 1000); // every 6 hours
runPasswordResetTokenCleanup();

// FD3-CP1: conversation lifecycle. A conversation ends when the
// channel says so — voice: socket close; voicemail: right after
// processing; SMS: the inactivity sweep below. Ending a conversation
// closes its thread and fires onConversationEnd exactly once (the
// state <> 'closed' guard makes double-fires — e.g. messy socket
// close+error pairs — a no-op).
//
// Closed threads REOPEN naturally: findOrCreateThread skips
// 'closed'/'complete' threads, so a customer texting back next week is
// the same relationship starting a fresh conversation.
function onConversationEnd(threadId, channel) {
  // FD3-CP7: the reflection pass. Fire-and-forget BY DESIGN — the
  // conversation is already over, so no failure in here may affect
  // anything: runReflectionPass catches internally, and this catch
  // is the belt for a synchronous throw. Callers (thread close, the
  // idle sweep, the voice socket teardown) never await it.
  console.log('[conversation-end] thread=' + threadId + ' channel=' + channel);
  try {
    const { runReflectionPass } = require('./lib/reflection');
    const { wsToday } = require('./lib/time-helpers');
    runReflectionPass({
      db: pool, anthropic, model: config.ANTHROPIC_MODEL,
      threadId, channel, logger: console, wsToday,
    }).catch((err) => {
      console.error('[reflection] pass rejected (conversation unaffected):', err.message);
    });
  } catch (err) {
    console.error('[reflection] launch failed (conversation unaffected):', err.message);
  }
}
async function closeConversationThread(threadId, channel) {
  if (!threadId) return;
  try {
    const r = await pool.query(
      "UPDATE appointment_threads SET state = 'closed', updated_at = NOW() WHERE id = $1 AND state <> 'closed' RETURNING id",
      [threadId]
    );
    if (r.rows.length) onConversationEnd(threadId, channel);
  } catch (err) {
    console.error('[conversation-end] close failed:', err.message);
  }
}
// SMS (and any lingering) threads idle past this window are considered
// over. Chosen from the data: conversations complete in minute-scale
// bursts, same-day follow-ups should continue the same thread, and the
// live table held a thread stuck "active" for 14 days — 6 hours closes
// yesterday's conversation by evening without splitting an afternoon
// reply. One instance per process (module top-level, same pattern as
// the cleanup runners above); the UPDATE is state-scoped so it is
// workspace-safe by construction.
const CONVERSATION_IDLE_HOURS = 6;
async function runConversationInactivitySweep() {
  try {
    const r = await pool.query(
      "UPDATE appointment_threads SET state = 'closed', updated_at = NOW() " +
      "WHERE state NOT IN ('closed', 'complete') AND updated_at < NOW() - INTERVAL '" + CONVERSATION_IDLE_HOURS + " hours' " +
      "RETURNING id, inbound_channel"
    );
    for (const row of r.rows) onConversationEnd(row.id, row.inbound_channel || 'sms');
  } catch (err) {
    console.error('[conversation-sweep] error:', err.message);
  }
}
setInterval(runConversationInactivitySweep, 30 * 60 * 1000); // every 30 minutes
runConversationInactivitySweep();

// FD3-CP4: queued requests expire honestly. Customer-originated
// pending actions (rows carrying a customer identity from the
// engine's queue path, CP3) expire after APPROVAL_TTL_HOURS — the
// customer is told in their channel and the owner gets a task, so
// the miss is visible, not silent. Owner-originated rows (no
// customer columns) expire quietly at OWNER_PENDING_TTL_DAYS.
// Same idempotency pattern as the conversation sweep above: one
// instance per process, and the status='pending' guard on the UPDATE
// means each row flips exactly ONCE — notifications iterate only the
// RETURNING rows, so a re-run (or a second instance) can never
// double-notify. notifyPendingActionCustomer is a hoisted function
// declaration defined with the approval endpoints below.
const APPROVAL_TTL_HOURS = 4;
const OWNER_PENDING_TTL_DAYS = 7;
async function runPendingActionExpirySweep() {
  try {
    const { rows: expired } = await pool.query(
      "UPDATE pending_actions SET status = 'expired', resolved_at = NOW() " +
      "WHERE status = 'pending' " +
      "  AND (customer_phone IS NOT NULL OR customer_email IS NOT NULL) " +
      "  AND created_at < NOW() - INTERVAL '" + APPROVAL_TTL_HOURS + " hours' " +
      "RETURNING *"
    );
    for (const pending of expired) {
      await notifyPendingActionCustomer(
        pending,
        pending.workspace_id,
        "We couldn't confirm this in time — give us a call and we'll sort it directly."
      );
      try {
        const customer = pending.customer_phone || pending.customer_email || 'unknown customer';
        await pool.query(
          'INSERT INTO tasks (user_id, title, category, "dueDate", notes) VALUES ($1, $2, ' + "'other'" + ', $3, $4)',
          [pending.user_id,
            ('Expired: ' + (pending.ai_summary || pending.tool_name) + ', ' + customer).slice(0, 200),
            new Date().toISOString().slice(0, 10),
            'A customer request sat ' + APPROVAL_TTL_HOURS + ' hours without a decision and expired. ' +
            'The customer was told to call. Original request: ' + (pending.ai_summary || pending.tool_name)]
        );
      } catch (err) {
        console.error('[pending-expiry] owner task insert failed for action', pending.id, ':', err.message);
      }
    }
    if (expired.length) {
      console.log('[pending-expiry] expired', expired.length, 'customer-originated action(s), customers notified');
    }
    const quiet = await pool.query(
      "UPDATE pending_actions SET status = 'expired', resolved_at = NOW() " +
      "WHERE status = 'pending' " +
      "  AND customer_phone IS NULL AND customer_email IS NULL " +
      "  AND created_at < NOW() - INTERVAL '" + OWNER_PENDING_TTL_DAYS + " days'"
    );
    // FD3-CP7: suggestions expire quietly at 7 days — dismissed-flagged
    // (not deleted) so they stay in reflection's dedupe memory. Same
    // idempotency shape as above: the IS NULL guard flips each row once.
    const staleSug = await pool.query(
      `UPDATE tasks SET dismissed_at = NOW()
        WHERE suggested = true AND done = false AND dismissed_at IS NULL
          AND "createdAt" < NOW() - INTERVAL '7 days'`
    );
    if (staleSug.rowCount) {
      console.log('[pending-expiry] quietly expired', staleSug.rowCount, 'stale suggestion(s)');
    }
    if (quiet.rowCount) {
      console.log('[pending-expiry] quietly expired', quiet.rowCount, 'owner-originated action(s)');
    }
  } catch (err) {
    console.error('[pending-expiry] sweep failed:', err.message);
  }
}
setInterval(runPendingActionExpirySweep, 30 * 60 * 1000); // every 30 minutes
runPendingActionExpirySweep();

async function initDB() {
  // Verify DB connection is alive before doing anything
  await pool.query('SELECT 1');

  // Users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email TEXT DEFAULT '',
      plan TEXT DEFAULT 'free',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Seed admin user from env vars if no users exist
  const { rows: userRows } = await pool.query('SELECT COUNT(*) FROM users');
  if (userRows[0].count === '0') {
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'modernmgmt2026';
    const hash = await bcrypt.hash(adminPass, BCRYPT_ROUNDS);
    await pool.query(
      'INSERT INTO users (username, password_hash, plan) VALUES ($1, $2, $3)',
      [adminUser, hash, 'admin']
    );
    console.log('Admin user seeded.');
  }

  // Messages table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      resident TEXT,
      subject TEXT,
      category TEXT,
      text TEXT,
      status TEXT DEFAULT 'new',
      folder TEXT DEFAULT 'inbox',
      email TEXT,
      phone TEXT,
      "createdAt" TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await migrate(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1`, 'messages.user_id');

  const { rows: msgRows } = await pool.query('SELECT COUNT(*) FROM messages WHERE user_id=1');
  if (msgRows[0].count === '0') {
    await pool.query(`INSERT INTO messages (user_id, resident, subject, category, text, status, folder) VALUES
      (1, 'Alex Rivera', 'Maintenance: Leaky faucet', 'maintenance', 'My kitchen faucet is leaking and spraying water.', 'new', 'inbox'),
      (1, 'Mira Chen', 'Renewal question', 'renewal', 'When should I confirm renewal terms?', 'new', 'inbox')`);
  }

  // Contacts table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      name TEXT,
      type TEXT,
      unit TEXT,
      email TEXT,
      phone TEXT,
      notes TEXT
    )
  `);
  await migrate(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1`, 'contacts.user_id');

  const { rows: conRows } = await pool.query('SELECT COUNT(*) FROM contacts WHERE user_id=1');
  if (conRows[0].count === '0') {
    await pool.query(`INSERT INTO contacts (user_id, name, type, unit, email, phone, notes) VALUES
      (1, 'Alex Rivera', 'resident', '101', 'alex.rivera@email.com', '555-201-1111', 'Lease ends June 2026. Prefers email contact.'),
      (1, 'Mira Chen', 'resident', '204', 'mira.chen@email.com', '555-201-2222', 'Has two pets. Renewal pending.'),
      (1, 'Jordan Lee', 'resident', '305', 'jordan.lee@email.com', '555-201-3333', 'Monthly lease. Works night shifts.')`);
  }

  // Tasks table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      title TEXT,
      category TEXT,
      "dueDate" TEXT,
      notes TEXT,
      done BOOLEAN DEFAULT false,
      suggested BOOLEAN DEFAULT false,
      "aiReason" TEXT DEFAULT ''
    )
  `);
  await migrate(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1`, 'tasks.user_id');
  await migrate(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS suggested BOOLEAN DEFAULT false`, 'tasks.suggested');
  await migrate(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "aiReason" TEXT DEFAULT ''`, 'tasks.aiReason');
  // FD3-CP7: dismissed suggestions keep their row (hidden everywhere)
  // so reflection can dedupe against recent dismissals — a deleted row
  // can't stop its own re-suggestion.
  await migrate(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ`, 'tasks.dismissed_at');

  const { rows: taskRows } = await pool.query('SELECT COUNT(*) FROM tasks WHERE user_id=1');
  if (taskRows[0].count === '0') {
    await pool.query(`INSERT INTO tasks (user_id, title, category, "dueDate", notes, done) VALUES
      (1, 'Alert vendors of insurance renewal', 'vendor', '2026-04-10', 'Contact AcePlumbing and GreenLawn before policy expires.', false),
      (1, 'Follow up on lease renewals', 'lease', '2026-04-15', 'Alex Rivera and Mira Chen leases up in 60 days.', false)`);
  }

  // Maintenance tickets table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_tickets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      unit TEXT DEFAULT '',
      resident TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      priority TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'open',
      outcome TEXT DEFAULT '',
      requires_action BOOLEAN DEFAULT false,
      action_notes TEXT DEFAULT '',
      emergency_sms_sent BOOLEAN DEFAULT false,
      "createdAt" TIMESTAMPTZ DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await migrate(`ALTER TABLE maintenance_tickets ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1`, 'maintenance_tickets.user_id');

  // Calendar events table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cal_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      date TEXT,
      title TEXT
    )
  `);
  await migrate(`ALTER TABLE cal_events ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1`, 'cal_events.user_id');

  const { rows: evtRows } = await pool.query('SELECT COUNT(*) FROM cal_events WHERE user_id=1');
  if (evtRows[0].count === '0') {
    await pool.query(`INSERT INTO cal_events (user_id, date, title) VALUES (1, '2026-04-10', 'Maintenance inspection')`);
  }

  // Budget transactions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS budget_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL,
      category TEXT,
      description TEXT,
      amount NUMERIC(10,2) NOT NULL,
      date TEXT,
      notes TEXT,
      "createdAt" TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await migrate(`ALTER TABLE budget_transactions ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1`, 'budget_transactions.user_id');

  const { rows: budRows } = await pool.query('SELECT COUNT(*) FROM budget_transactions WHERE user_id=1');
  if (budRows[0].count === '0') {
    await pool.query(`INSERT INTO budget_transactions (user_id, type, category, description, amount, date, notes) VALUES
      (1, 'income',  'Rent Received',  'Unit 101 — April rent',       1800.00, '2026-04-01', ''),
      (1, 'income',  'Rent Received',  'Unit 204 — April rent',       1600.00, '2026-04-01', ''),
      (1, 'income',  'Rent Received',  'Unit 305 — April rent',       1600.00, '2026-04-01', ''),
      (1, 'income',  'Late Fee',       'Unit 305 late payment fee',    75.00,  '2026-04-03', ''),
      (1, 'expense', 'Maintenance',    'Plumbing repair — Unit 101',  320.00,  '2026-04-02', 'AcePlumbing Co.'),
      (1, 'expense', 'Landscaping',    'Monthly lawn care',           450.00,  '2026-04-01', 'GreenLawn Services'),
      (1, 'expense', 'Utilities',      'Common area electricity',     210.00,  '2026-04-01', ''),
      (1, 'expense', 'Insurance',      'Monthly property insurance',  380.00,  '2026-04-01', '')`);
  }

  // Automation table (per user)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automation (
      user_id INTEGER PRIMARY KEY,
      "autoReplyEnabled" BOOLEAN DEFAULT false
    )
  `);
  // Ensure admin row exists — wrapped in migrate() so any future schema drift
  // (e.g. missing user_id column) is logged but does not abort initDB() and
  // cascade into missing later migrations. See /docs/schema-reality-gap.md.
  await migrate(
    `INSERT INTO automation (user_id, "autoReplyEnabled") VALUES (1, false) ON CONFLICT DO NOTHING`,
    'automation.admin_seed'
  );

  // Lease tracking columns on contacts
  await migrate(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lease_start TEXT DEFAULT ''`, 'contacts.lease_start');
  await migrate(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lease_end TEXT DEFAULT ''`, 'contacts.lease_end');
  await migrate(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS monthly_rent NUMERIC(10,2) DEFAULT 0`, 'contacts.monthly_rent');

  // Notification settings columns on users table
  await migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_email TEXT DEFAULT ''`, 'users.notification_email');
  await migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN DEFAULT true`, 'users.notifications_enabled');

  // Onboarding + Stripe columns
  await migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false`, 'users.onboarding_completed');
  await migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT DEFAULT ''`, 'users.stripe_customer_id');
  await migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT DEFAULT ''`, 'users.stripe_subscription_id');

  // Payment forwarding token (Option 1: email parsing)
  await migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_forward_token TEXT DEFAULT ''`, 'users.payment_forward_token');

  // Multi-tenant inbound routing columns
  await migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT`, 'users.twilio_phone_number');
  await migrate(`ALTER TABLE users ADD COLUMN IF NOT EXISTS inbound_email_alias TEXT`, 'users.inbound_email_alias');

  // Drafts table (replaces in-memory array — user-scoped, persistent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drafts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      message_id INTEGER,
      content TEXT DEFAULT '',
      status TEXT DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Connected email accounts (IMAP/SMTP, per user)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      email TEXT NOT NULL,
      provider TEXT DEFAULT 'custom',
      imap_host TEXT NOT NULL,
      imap_port INTEGER DEFAULT 993,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER DEFAULT 465,
      encrypted_password TEXT NOT NULL,
      last_sync_uid INTEGER DEFAULT 0,
      last_sync_at TIMESTAMPTZ,
      sync_enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Payment events table — incoming emails parsed by AI, matched or queued
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      raw_from TEXT DEFAULT '',
      raw_subject TEXT DEFAULT '',
      raw_body TEXT DEFAULT '',
      parsed_tenant TEXT DEFAULT '',
      parsed_amount NUMERIC(10,2) DEFAULT 0,
      parsed_date TEXT DEFAULT '',
      parsed_source TEXT DEFAULT '',
      confidence TEXT DEFAULT 'low',
      matched_rent_id INTEGER,
      status TEXT DEFAULT 'needs_review',
      "createdAt" TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Backfill forward tokens and inbound aliases for existing users
  const { rows: noTokenUsers } = await pool.query(
    `SELECT id FROM users WHERE payment_forward_token IS NULL OR payment_forward_token=''`
  );
  for (const u of noTokenUsers) {
    const token = generateForwardToken();
    await pool.query(`UPDATE users SET payment_forward_token=$1 WHERE id=$2`, [token, u.id]);
  }
  const { rows: noAliasUsers } = await pool.query(
    `SELECT id FROM users WHERE inbound_email_alias IS NULL OR inbound_email_alias=''`
  );
  for (const u of noAliasUsers) {
    const alias = `user-${generateForwardToken()}@inbound.modernmanagementapp.com`;
    await pool.query(`UPDATE users SET inbound_email_alias=$1 WHERE id=$2`, [alias, u.id]);
  }

  // Rent payments table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rent_payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      resident TEXT NOT NULL,
      unit TEXT DEFAULT '',
      amount NUMERIC(10,2) NOT NULL,
      due_date TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT DEFAULT '',
      paid_date TEXT DEFAULT '',
      "createdAt" TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await migrate(`ALTER TABLE rent_payments ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1`, 'rent_payments.user_id');
  await migrate(`ALTER TABLE rent_payments ADD COLUMN IF NOT EXISTS paid_date TEXT DEFAULT ''`, 'rent_payments.paid_date');

  // Invoices table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      vendor TEXT NOT NULL,
      description TEXT DEFAULT '',
      amount NUMERIC(10,2) NOT NULL,
      date TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT DEFAULT '',
      "createdAt" TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await migrate(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1`, 'invoices.user_id');

  // Knowledge base table (per-user policies, procedures, uploaded docs)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'policy',
      content TEXT DEFAULT '',
      "createdAt" TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Seed default policies for admin if empty
  const { rows: kbRows } = await pool.query('SELECT COUNT(*) FROM knowledge WHERE user_id=1');
  if (kbRows[0].count === '0') {
    await pool.query(`INSERT INTO knowledge (user_id, title, type, content) VALUES
      (1, 'Renewal Guidelines', 'policy', 'Send 90-day renewal reminders; verify 30-day notice for rent increases.'),
      (1, 'Maintenance Escalation', 'procedure', 'For emergency leaks, dispatch within 2 hours and notify resident within 30 min.')`);
  }

  // Broadcasts table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      channel TEXT NOT NULL,
      subject TEXT DEFAULT '',
      body TEXT NOT NULL,
      recipient_filter TEXT DEFAULT 'all',
      recipient_count INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      "createdAt" TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log('DB init complete.');
}

// --- Automation helpers ---
async function getAutomation(userId) {
  const { rows } = await pool.query('SELECT * FROM automation WHERE user_id=$1', [userId]);
  if (rows.length) return { autoReplyEnabled: rows[0].autoReplyEnabled };
  // Create default row for new user
  await pool.query('INSERT INTO automation (user_id, "autoReplyEnabled") VALUES ($1, false) ON CONFLICT DO NOTHING', [userId]);
  return { autoReplyEnabled: false };
}

// --- Notification email helper ---
async function sendNotificationEmail(userId, message) {
  try {
    // Get user's notification settings
    const { rows } = await pool.query(
      'SELECT notification_email, notifications_enabled FROM users WHERE id=$1', [userId]
    );
    if (!rows.length) return;
    const user = rows[0];
    if (!user.notifications_enabled) return;

    // Fall back to env var for admin if no email set
    const toEmail = user.notification_email ||
      (userId === 1 ? (process.env.NOTIFICATION_EMAIL || process.env.SENDGRID_FROM_EMAIL) : null);
    if (!toEmail) return;

    const categoryLabel = {
      email: '📧 Email', sms: '💬 SMS', voicemail: '📞 Voicemail',
      maintenance: '🔧 Maintenance', renewal: '📋 Renewal'
    }[message.category] || '📩 Message';

    const preview = (message.text || '').replace(/📞 Voicemail: ?/, '').replace(/"/g, '').slice(0, 220);
    const appUrl = process.env.APP_URL || 'https://modernmanagement.onrender.com';

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Inter',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#ff6b6b,#ff8e53);border-radius:14px 14px 0 0;padding:28px 32px;text-align:center;">
          <div style="display:inline-block;background:rgba(255,255,255,0.2);border-radius:10px;padding:8px 16px;font-size:18px;font-weight:800;color:white;letter-spacing:-0.5px;">MM</div>
          <div style="color:rgba(255,255,255,0.85);font-size:12px;margin-top:6px;letter-spacing:1px;text-transform:uppercase;font-weight:600;">Modern Management</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:white;padding:32px;border-radius:0 0 14px 14px;box-shadow:0 4px 24px rgba(0,0,0,0.07);">
          <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#ff6b6b;">${categoryLabel}</p>
          <h2 style="margin:0 0 20px;font-size:20px;font-weight:800;color:#0f172a;line-height:1.2;">${message.subject || 'New message'}</h2>

          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:24px;">
            <tr><td style="padding:18px 20px;">
              <p style="margin:0 0 4px;font-size:12px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">From</p>
              <p style="margin:0 0 14px;font-size:15px;font-weight:700;color:#0f172a;">${message.resident || 'Unknown'}</p>
              ${preview ? `<p style="margin:0;font-size:14px;color:#475569;line-height:1.6;">${preview}${(message.text || '').length > 220 ? '…' : ''}</p>` : ''}
            </td></tr>
          </table>

          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${appUrl}/workspace" style="display:inline-block;background:linear-gradient(135deg,#ff6b6b,#ff8e53);color:white;text-decoration:none;padding:13px 32px;border-radius:9px;font-size:15px;font-weight:700;letter-spacing:0.2px;">Open Workspace →</a>
            </td></tr>
          </table>

          <p style="margin:24px 0 0;font-size:12px;color:#cbd5e1;text-align:center;">You're receiving this because notifications are enabled in your Modern Management account.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await sgMail.send({
      to: toEmail,
      from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
      subject: `New ${categoryLabel} from ${message.resident || 'Unknown'} — Modern Management`,
      html: htmlBody,
      text: `New message from ${message.resident}\n\n${message.subject}\n\n${preview}\n\nOpen your workspace: ${appUrl}/workspace`
    });
    console.log(`Notification email sent to ${toEmail} for message ${message.id}`);
  } catch (err) {
    console.error('Notification email error:', err.message);
  }
}

// --- Notification push helper (PWA Stage C) ---
// Sibling to sendNotificationEmail. Same `message` shape (a messages-table
// row with category/text/subject/resident), same category labels (so the
// push and email wording match), same fire-and-forget posture. Loops over
// every push_subscriptions row for the user and sends a payload to each
// browser. Expired subscriptions (404/410 from the push service) are
// pruned from the table. Other per-subscription errors are logged but
// don't abort the loop. The whole function is wrapped so it never throws
// to the caller.
async function sendPushNotification(userId, message) {
  if (!pushConfigured) return;
  try {
    const { rows: subs } = await pool.query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );
    if (!subs.length) return;

    // Mirror sendNotificationEmail's wording exactly so the push
    // notification reads the same as the email an owner would also get.
    const categoryLabel = {
      email: '📧 Email', sms: '💬 SMS', voicemail: '📞 Voicemail',
      maintenance: '🔧 Maintenance', renewal: '📋 Renewal'
    }[message.category] || '📩 Message';
    const preview = (message.text || '')
      .replace(/📞 Voicemail: ?/, '')
      .replace(/"/g, '')
      .slice(0, 120);
    const fromWho = message.resident ? ` from ${message.resident}` : '';
    const payload = JSON.stringify({
      title: `New ${categoryLabel}${fromWho}`,
      body: preview,
      url: '/workspace',
    });

    for (const row of subs) {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          // Subscription is gone (unsubscribed/expired). Prune it so we
          // don't keep retrying. Best-effort — a delete failure here
          // just leaves a stale row; not worth retrying.
          try {
            await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [row.endpoint]);
            console.log('[push] pruned expired subscription:', row.endpoint.slice(0, 60));
          } catch (delErr) {
            console.error('[push] prune failed:', delErr.message);
          }
        } else {
          console.error('[push] send failed (status', code, '):', err && (err.body || err.message));
        }
      }
    }
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

// --- Settings routes ---
app.get('/api/settings', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT notification_email, notifications_enabled, twilio_phone_number, inbound_email_alias, alert_phone FROM users WHERE id=$1', [req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

app.put('/api/settings', requireAuth, async (req, res) => {
  // alert_phone is updated only when the key is explicitly present in
  // the body — non-destructive for callers like the onboarding flow
  // that only send notification_email / notifications_enabled.
  const { notification_email, notifications_enabled } = req.body;
  const hasAlertPhone = Object.prototype.hasOwnProperty.call(req.body, 'alert_phone');

  if (hasAlertPhone) {
    const alertPhone = (req.body.alert_phone || '').trim();
    const { rows } = await pool.query(
      `UPDATE users
         SET notification_email = $1,
             notifications_enabled = $2,
             alert_phone = $3
       WHERE id = $4
       RETURNING notification_email, notifications_enabled, alert_phone`,
      [notification_email || '', notifications_enabled !== false, alertPhone, req.session.userId]
    );
    res.json(rows[0]);
  } else {
    const { rows } = await pool.query(
      `UPDATE users
         SET notification_email = $1,
             notifications_enabled = $2
       WHERE id = $3
       RETURNING notification_email, notifications_enabled`,
      [notification_email || '', notifications_enabled !== false, req.session.userId]
    );
    res.json(rows[0]);
  }
});

// --- Web push (PWA Stage B) -----------------------------------------------
// Two endpoints: GET the VAPID public key (so client JS can pass it into
// pushManager.subscribe), and POST a subscription (so we can fan out push
// payloads to it from the same moments that already trigger
// sendNotificationEmail). Auth follows the existing pattern — requireAuth
// middleware + req.session.userId, same as /api/settings above.

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const sub = req.body || {};
  const endpoint = sub.endpoint;
  const p256dh = sub.keys && sub.keys.p256dh;
  const auth   = sub.keys && sub.keys.auth;
  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'Invalid subscription payload (need endpoint, keys.p256dh, keys.auth).' });
  }
  const userAgent = req.headers['user-agent'] || null;
  try {
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.session.userId, endpoint, p256dh, auth, userAgent]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/subscribe]', err.message);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// --- Login / Logout / Signup ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username.trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Phase B B6: request a password reset link. Public route.
// IMPORTANT — account enumeration prevention: this endpoint always
// returns the same generic success response regardless of whether
// the email exists. Email is only sent when a real user matches.
app.post('/api/auth/request-password-reset', passwordResetRequestLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();

  // Validate format but always respond identically.
  const validFormat = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const genericResponse = {
    success: true,
    message: 'If an account with that email exists, a password reset link has been sent.',
  };

  if (!validFormat) {
    // Don't even try to look up — invalid format is its own bucket.
    // Still respond identically to prevent enumeration.
    return res.json(genericResponse);
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, username, email FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [email]
    );

    if (!rows.length) {
      console.log('[password-reset] No account for', email, '— silent no-op');
      return res.json(genericResponse);
    }

    const user = rows[0];

    // Generate a 32-byte random token (URL-safe hex).
    const token = crypto.randomBytes(32).toString('hex');

    await pool.query(
      `INSERT INTO password_reset_tokens (token, user_id) VALUES ($1, $2)`,
      [token, user.id]
    );

    const baseUrl = (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
    const resetUrl = baseUrl + '/reset-password?token=' + encodeURIComponent(token);

    // Send the email. Failure here is logged but doesn't change the
    // response — we don't want to surface email-system errors to the
    // user (also enumeration-vector adjacent).
    try {
      await sgMail.send({
        to: user.email,
        from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
        replyTo: process.env.SENDGRID_FROM_EMAIL,
        subject: 'Reset your Modern Management password',
        text: [
          'Hi ' + user.username + ',',
          '',
          'You (or someone using your email address) requested a password reset for your Modern Management account.',
          '',
          'To set a new password, click the link below within the next hour:',
          resetUrl,
          '',
          'If you did not request this, you can safely ignore this email — your password will stay the same.',
          '',
          'For your security, this link will expire in 1 hour and can only be used once.',
          '',
          'Modern Management',
        ].join('\n'),
        html: [
          '<!DOCTYPE html>',
          '<html><head><meta charset="utf-8"></head>',
          '<body style="margin:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;color:#2d3748;">',
          '<div style="max-width:540px;margin:0 auto;padding:24px 16px;">',
          '<div style="background:white;border-radius:12px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.04);">',
          '<h1 style="margin:0 0 8px;font-size:1.4em;color:#2d3748;">Reset your password</h1>',
          '<p style="color:#475569;font-size:0.95em;line-height:1.6;">Hi ' + user.username + ', you (or someone using your email) requested a password reset for your Modern Management account.</p>',
          '<div style="text-align:center;margin:28px 0;">',
          '<a href="' + resetUrl + '" style="display:inline-block;background:linear-gradient(135deg,#ff6b6b,#ff8e53);color:white;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700;">Set a new password</a>',
          '</div>',
          '<p style="color:#64748b;font-size:0.85em;line-height:1.5;">This link expires in 1 hour and can only be used once.</p>',
          '<p style="color:#64748b;font-size:0.85em;line-height:1.5;">If you did not request this, you can safely ignore this email — your password will stay the same.</p>',
          '<p style="color:#94a3b8;font-size:0.78em;margin-top:24px;padding-top:18px;border-top:1px solid #e2e8f0;">If the button does not work, copy and paste this URL into your browser:<br><span style="word-break:break-all;">' + resetUrl + '</span></p>',
          '</div></div></body></html>',
        ].join(''),
      });
      console.log('[password-reset] Email sent to', user.email);
    } catch (emailErr) {
      console.error('[password-reset] Email send failed for', user.email, ':', emailErr.message);
    }

    res.json(genericResponse);
  } catch (err) {
    console.error('[password-reset] DB error:', err.message);
    // Even on DB error we return the generic response to prevent enumeration.
    res.json(genericResponse);
  }
});

// Phase B B6: confirm a reset token is valid (used by the reset-password
// page on load to show "valid" or "expired/invalid" state before user
// types a new password). Public route.
app.get('/api/auth/check-reset-token', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return res.json({ valid: false, reason: 'invalid_format' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token = $1`,
      [token]
    );
    if (!rows.length) return res.json({ valid: false, reason: 'not_found' });
    const t = rows[0];
    if (t.used_at)         return res.json({ valid: false, reason: 'already_used' });
    if (new Date(t.expires_at) < new Date()) return res.json({ valid: false, reason: 'expired' });
    res.json({ valid: true });
  } catch (err) {
    console.error('[password-reset] check-token error:', err.message);
    res.json({ valid: false, reason: 'server_error' });
  }
});

// Phase B B6: complete the password reset. Public route.
app.post('/api/auth/reset-password', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const password = String(req.body.password || '');

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ error: 'Invalid or missing token.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the token row so concurrent reset attempts can't race.
    const { rows: tokenRows } = await client.query(
      `SELECT user_id, expires_at, used_at FROM password_reset_tokens
        WHERE token = $1 FOR UPDATE`,
      [token]
    );
    if (!tokenRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link is invalid.' });
    }
    const t = tokenRows[0];
    if (t.used_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link has already been used.' });
    }
    if (new Date(t.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    await client.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [newHash, t.user_id]
    );
    await client.query(
      `UPDATE password_reset_tokens SET used_at = NOW() WHERE token = $1`,
      [token]
    );

    await client.query('COMMIT');
    console.log('[password-reset] Password reset completed for user_id=' + t.user_id);
    res.json({ success: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[password-reset] reset error:', err.message);
    res.status(500).json({ error: 'Could not reset password.' });
  } finally {
    client.release();
  }
});

// Session E1: list available verticals for the signup-vertical page.
// Public (no auth) — the page is part of the pre-signup flow.
app.get('/api/verticals', (req, res) => {
  const list = verticals.listAvailableVerticals();
  res.json({
    verticals: list.map((v) => ({
      slug: v.slug,
      displayName: v.displayName,
      tagline: v.tagline,
      description: v.description,
    })),
  });
});

// Phase B B1: signup-form uniqueness pre-check endpoints. Public
// (no auth) so the multi-screen form can validate inline as the user
// types. Final uniqueness re-check happens at account-creation time
// in B4 to catch races during the multi-minute Stripe + Twilio flow.
// Rate-limiting is not applied here yet — flag for Phase D hardening.
app.get('/api/signup/check-username', signupCheckLimiter, async (req, res) => {
  const username = String(req.query.username || '').trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'username required' });
  // Same regex the form enforces — server-side guard so a malformed
  // value can't cause an unbounded query against an indexed column.
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    return res.json({ available: false, reason: 'invalid_format' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM users WHERE username = $1 LIMIT 1',
      [username]
    );
    res.json({ available: rows.length === 0 });
  } catch (err) {
    console.error('check-username error:', err.message);
    res.status(500).json({ error: 'Check failed' });
  }
});

app.get('/api/signup/check-email', signupCheckLimiter, async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.json({ available: false, reason: 'invalid_format' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email]
    );
    res.json({ available: rows.length === 0 });
  } catch (err) {
    console.error('check-email error:', err.message);
    res.status(500).json({ error: 'Check failed' });
  }
});

// Phase B B2: Stripe price ID resolution by lookup_key. Cached at
// first use for the lifetime of the process. If a key is missing,
// throws so the calling endpoint can surface a clear 5xx — failing
// fast is better than silently using a wrong/null price ID.
const SIGNUP_PRICE_LOOKUP_KEYS = [
  'solo_monthly', 'solo_annual',
  'team_monthly', 'team_annual',
  'enterprise_monthly', 'enterprise_annual',
  'additional_user_monthly',
];

// Session E11: Professional Services Stripe price resolution. PM uses
// lookup_keys (above) because that's the convention from Phase B; PS
// uses env vars per the E11 setup checklist where Jay copies price IDs
// straight out of the Stripe dashboard. Two architectures live side-by-
// side — PM behavior is preserved unchanged, PS gets a parallel path.
function getPSStripePriceId(plan) {
  const map = {
    starter: process.env.STRIPE_PRICE_PS_STARTER_MONTHLY,
    pro:     process.env.STRIPE_PRICE_PS_PRO_MONTHLY,
    premium: process.env.STRIPE_PRICE_PS_PREMIUM_MONTHLY,
  };
  return map[plan] || null;
}

// Startup warning if any PS price env var is missing. Doesn't fail
// startup (PM signup still works), but PS signup will return a clear
// "pricing not configured" error until the env vars land.
(function _checkPSPriceEnvVars() {
  const missing = ['STRIPE_PRICE_PS_STARTER_MONTHLY', 'STRIPE_PRICE_PS_PRO_MONTHLY', 'STRIPE_PRICE_PS_PREMIUM_MONTHLY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.warn('[startup] Professional Services Stripe price env vars missing: ' + missing.join(', ') + '. PS signups will fail with "pricing not configured" until these are set in .env.');
  }
})();
let _signupPriceCache = null;
async function getSignupPriceIdByLookupKey(lookupKey) {
  if (!stripeSignup) {
    throw new Error('stripeSignup not initialized — STRIPE_TEST_SECRET_KEY missing');
  }
  if (!_signupPriceCache) {
    const result = await stripeSignup.prices.list({
      lookup_keys: SIGNUP_PRICE_LOOKUP_KEYS,
      limit: 20,
    });
    _signupPriceCache = {};
    for (const p of result.data) _signupPriceCache[p.lookup_key] = p.id;
    for (const k of SIGNUP_PRICE_LOOKUP_KEYS) {
      if (!_signupPriceCache[k]) {
        _signupPriceCache = null;  // don't cache an incomplete result
        throw new Error(`Stripe price lookup_key not found in account: ${k}`);
      }
    }
    console.log('[signup] Stripe prices resolved:', Object.keys(_signupPriceCache).join(', '));
  }
  return _signupPriceCache[lookupKey];
}

// Phase B B2: signup → Stripe Checkout. Re-validates every field
// (defense against form-bypass), bcrypt-hashes the password, stores
// a signup_drafts row keyed by random hex, then creates a Checkout
// session and returns its URL. The webhook handler below correlates
// completed sessions back to the draft via client_reference_id.
//
// IMPORTANT: draft_data contains password_hash (bcrypt). Do NOT log
// raw draft rows; redact password_hash before any console output.
app.post('/api/signup/create-checkout-session', signupCheckoutLimiter, async (req, res) => {
  if (!stripeSignup) {
    return res.status(500).json({ error: 'Signup checkout is not configured' });
  }

  const body = req.body || {};
  const username        = String(body.username || '').trim().toLowerCase();
  const password        = String(body.password || '');
  const email           = String(body.email || '').trim();
  const business_name   = String(body.business_name || '').trim();
  const units           = parseInt(body.units, 10);
  const property_type   = String(body.property_type || '');
  // E11: PS-specific business info — captured for the draft so the
  // workspace + plan-recommendation surfaces have it post-signup.
  const business_type           = String(body.business_type || '').trim();
  const appointments_per_month  = parseInt(body.appointments_per_month, 10);
  const area_code       = String(body.area_code || '').trim();
  const area_code_backup = String(body.area_code_backup || '').trim();
  const alert_phone     = String(body.alert_phone || '').trim();
  const billing         = String(body.billing || '');
  const plan            = String(body.plan || '');
  // Session E1: optional vertical slug. validateVertical() falls back
  // to the default ('property-management') for missing/unknown values,
  // so legacy callers without this field continue working.
  const verticalSlug    = verticals.validateVertical(String(body.vertical || ''));
  const isPS = verticalSlug === 'professional-services';

  // Server-side re-validation (mirrors client regexes in views/signup.html).
  // Shared validations first.
  if (!/^[a-z0-9_]{3,30}$/.test(username))                  return res.status(400).json({ error: 'Invalid username format' });
  if (!password || password.length < 8)                     return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))            return res.status(400).json({ error: 'Invalid email' });
  if (!business_name || business_name.length > 100)         return res.status(400).json({ error: 'Business name is required (1-100 chars)' });

  // E11: vertical-aware business-info validation. PM keeps its existing
  // units + property_type checks unchanged; PS validates business_type
  // (enum) and appointments_per_month (numeric, used for plan recommendation).
  if (isPS) {
    const BUSINESS_TYPES = ['salon', 'barbershop', 'spa', 'nail_salon', 'hair_stylist', 'massage_therapy', 'personal_training', 'tutoring', 'pet_grooming', 'mobile_detailing', 'other'];
    if (!BUSINESS_TYPES.includes(business_type)) {
      return res.status(400).json({ error: 'Invalid business type' });
    }
    if (!Number.isFinite(appointments_per_month) || appointments_per_month < 0 || appointments_per_month > 100000) {
      return res.status(400).json({ error: 'Appointments per month must be a non-negative number' });
    }
  } else {
    if (!Number.isFinite(units) || units < 1 || units > 1000) return res.status(400).json({ error: 'Units must be a number between 1 and 1000' });
    const PROPERTY_TYPES = ['residential_apartment', 'condo', 'single_family', 'mixed_use', 'commercial'];
    if (!PROPERTY_TYPES.includes(property_type))              return res.status(400).json({ error: 'Invalid property type' });
  }

  if (area_code && !/^[0-9]{3}$/.test(area_code))           return res.status(400).json({ error: 'Area code must be exactly 3 digits' });
  if (area_code_backup && !/^[0-9]{3}$/.test(area_code_backup)) return res.status(400).json({ error: 'Backup area code must be exactly 3 digits' });
  if (alert_phone && !/^\+1[0-9]{10}$/.test(alert_phone))   return res.status(400).json({ error: 'Alert phone must be +1 followed by 10 digits' });

  // E11: vertical-aware plan + billing validation. PS is monthly-only in v1;
  // PM keeps its monthly/annual + solo/team/enterprise constraint.
  if (isPS) {
    if (billing !== 'monthly') return res.status(400).json({ error: 'Professional Services plans are monthly-only in v1' });
    if (!['starter', 'pro', 'premium'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
  } else {
    if (!['monthly', 'annual'].includes(billing))             return res.status(400).json({ error: 'Invalid billing cadence' });
    if (!['solo', 'team', 'enterprise'].includes(plan))       return res.status(400).json({ error: 'Invalid plan' });
  }

  // Final uniqueness re-check (catches races since the form's blur check)
  try {
    const { rows: u } = await pool.query('SELECT 1 FROM users WHERE username = $1 LIMIT 1', [username]);
    if (u.length) return res.status(409).json({ error: 'That username is already taken' });
    const { rows: e } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (e.length) return res.status(409).json({ error: 'An account with that email already exists' });
  } catch (err) {
    console.error('[signup-checkout] uniqueness check failed:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }

  // Hash password — plaintext NEVER persists past this line.
  let password_hash;
  try {
    password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  } catch (err) {
    console.error('[signup-checkout] bcrypt hash failed:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }

  // Random hex draft_id — used as Stripe client_reference_id so the
  // webhook can correlate session.completed back to the draft row.
  const draft_id = require('crypto').randomBytes(16).toString('hex');

  // Resolve Stripe price ID. E11: PS uses env-var-based resolution; PM
  // keeps its existing lookup_key-based resolution unchanged. If a PS
  // env var is missing, surface a clear "pricing not configured" error
  // rather than failing back to a PM price.
  let price_id;
  if (isPS) {
    price_id = getPSStripePriceId(plan);
    if (!price_id) {
      console.error('[signup-checkout] PS price not configured for plan=' + plan);
      return res.status(500).json({ error: 'Professional Services pricing is not configured. Please contact support.' });
    }
  } else {
    const lookup_key = `${plan}_${billing}`;
    try {
      price_id = await getSignupPriceIdByLookupKey(lookup_key);
    } catch (err) {
      console.error('[signup-checkout] price lookup failed:', err.message);
      return res.status(500).json({ error: 'Pricing temporarily unavailable; please try again' });
    }
  }

  // Persist the draft (do NOT log this row — draft_data has password_hash).
  // E11: PS-specific fields (business_type, appointments_per_month) are
  // stored alongside PM fields so the orchestrator and welcome email
  // template can read either set.
  try {
    await pool.query(
      'INSERT INTO signup_drafts (id, draft_data) VALUES ($1, $2::jsonb)',
      [draft_id, JSON.stringify({
        username, email, business_name,
        // PM-specific:
        units: isPS ? null : units,
        property_type: isPS ? null : property_type,
        // PS-specific:
        business_type: isPS ? business_type : null,
        appointments_per_month: isPS ? appointments_per_month : null,
        // Shared:
        area_code, area_code_backup, alert_phone,
        billing: isPS ? 'monthly' : billing,
        plan,
        vertical: verticalSlug,
        password_hash,
      })]
    );
  } catch (err) {
    console.error('[signup-checkout] draft insert failed:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }

  // Build success/cancel URLs from request host (trust proxy:1 makes
  // req.protocol return the real client-facing protocol behind Render's
  // load balancer). Q-B2.7 fallback: warn + use localhost:4000 if host
  // header is somehow missing.
  let host = req.headers.host;
  if (!host) {
    console.warn('[signup-checkout] req.headers.host is empty — falling back to localhost:4000');
    host = 'localhost:4000';
  }
  const proto = req.protocol || 'http';
  const success_url = `${proto}://${host}/signup/success?session_id={CHECKOUT_SESSION_ID}&draft_id=${draft_id}`;
  const cancel_url  = `${proto}://${host}/signup/canceled?draft_id=${draft_id}`;

  // Session D3: optional 7-day trial gating. PM: opt-in (Solo only).
  // E11: PS — all three tiers (Starter / Pro / Premium) get a 7-day
  // free trial automatically per the launch design.
  const wantsTrial = req.body && (req.body.trial === true || req.body.trial === 'true');
  const shouldApplyTrial = isPS
    ? true
    : (wantsTrial && plan === 'solo');

  const sessionConfig = {
    mode: 'subscription',
    line_items: [{ price: price_id, quantity: 1 }],
    customer_email: email,
    client_reference_id: draft_id,
    metadata: {
      draft_id,
      signup_username: username,
      signup_email: email,
      // Session E1: orchestrator reads this to set workspaces.vertical
      // on the new workspace.
      vertical: verticalSlug,
    },
    success_url,
    cancel_url,
  };
  // Session E1: also stamp vertical onto the subscription metadata so
  // downstream Stripe events / dashboards can be filtered by vertical.
  // subscription_data already exists for the D3 trial path; merge into it.
  if (shouldApplyTrial) {
    sessionConfig.subscription_data = {
      trial_period_days: 14,
      metadata: { vertical: verticalSlug },
    };
  } else {
    sessionConfig.subscription_data = {
      metadata: { vertical: verticalSlug },
    };
  }

  // Create Stripe Checkout session
  let session;
  try {
    session = await stripeSignup.checkout.sessions.create(sessionConfig);
  } catch (err) {
    console.error('[signup-checkout] Stripe session creation failed:', err.message);
    return res.status(500).json({ error: 'Could not create checkout session' });
  }

  res.json({ url: session.url, session_id: session.id });
});

// Phase B B4 part 2: signup status endpoint. Polled by signup-success.html
// to know when the orchestrator has finished provisioning the workspace.
// Public (no auth) — keyed by session_id which is an unguessable token
// from Stripe. Response shape:
//   { status: 'pending' }                              still working
//   { status: 'success', workspace: {...}, login_url } done, all clean
//   { status: 'failed' }                               generic error
//                                                       (we don't expose
//                                                        internals to UI;
//                                                        operator gets the
//                                                        detailed alert)
app.get('/api/signup/status', async (req, res) => {
  const sessionId = String(req.query.session_id || '').trim();
  if (!sessionId) return res.status(400).json({ error: 'session_id required' });
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) {
    return res.status(400).json({ error: 'invalid session_id format' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT
         processed_at,
         event_data->>'_orchestrator_error' AS error_msg,
         event_data->'data'->'object'->>'subscription' AS subscription_id
       FROM stripe_events
       WHERE event_type = 'checkout.session.completed'
         AND event_data->'data'->'object'->>'id' = $1
       ORDER BY received_at DESC
       LIMIT 1`,
      [sessionId]
    );

    if (!rows.length) return res.json({ status: 'pending' });

    const row = rows[0];

    if (row.error_msg) {
      return res.json({ status: 'failed' });
    }

    if (!row.processed_at) {
      return res.json({ status: 'pending' });
    }

    if (!row.subscription_id) {
      console.warn('[signup-status] processed event has no subscription_id; session=', sessionId);
      return res.json({ status: 'success' });
    }

    const { rows: wsRows } = await pool.query(
      `SELECT w.business_name, w.twilio_phone_number, u.username
         FROM workspaces w
         JOIN users u ON u.id = w.owner_user_id
        WHERE w.stripe_subscription_id = $1
        LIMIT 1`,
      [row.subscription_id]
    );
    if (!wsRows.length) {
      console.warn('[signup-status] processed event has no workspace; session=', sessionId);
      return res.json({ status: 'pending' });
    }

    res.json({
      status: 'success',
      workspace: {
        business_name: wsRows[0].business_name,
        twilio_phone_number: wsRows[0].twilio_phone_number,
        username: wsRows[0].username,
      },
      login_url: '/login',
    });
  } catch (err) {
    console.error('[signup-status] error:', err.message);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// Phase B B2: Stripe webhook receiver (signup flow). Verifies signature,
// stores relevant events idempotently in stripe_events for B4 to consume.
// Other event types are acknowledged but not stored (avoids bloat).
//
// Note: req.body here is a raw Buffer because /api/stripe/webhook is
// mounted with express.raw() above, before bodyParser.json().
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripeSignup) {
    return res.status(500).send('Webhook receiver not configured');
  }
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_TEST_WEBHOOK_SECRET;
  if (!sig || !secret) {
    console.error('[stripe-webhook] missing signature header or webhook secret');
    return res.status(400).send('Missing signature or secret');
  }

  let event;
  try {
    event = stripeSignup.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Filter to event families relevant to the signup + subscription lifecycle.
  // Other events ack with 200 but aren't persisted.
  const STORED_EVENT_PREFIXES = [
    'checkout.session.',       // checkout.session.completed, checkout.session.async_payment_*
    'customer.subscription.',  // customer.subscription.created/updated/deleted
    'invoice.payment_',        // invoice.payment_succeeded/failed
    'account.',                // E13: account.updated for Stripe Connect onboarding sync
  ];
  const should_store = STORED_EVENT_PREFIXES.some(p => event.type.startsWith(p));

  if (should_store) {
    try {
      // ON CONFLICT DO NOTHING — Stripe sends the same event ID for retries.
      // Idempotent INSERT means duplicate webhooks become silent no-ops.
      await pool.query(
        `INSERT INTO stripe_events (stripe_event_id, event_type, event_data)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (stripe_event_id) DO NOTHING`,
        [event.id, event.type, JSON.stringify(event)]
      );
      console.log('[stripe-webhook] stored event:', event.type, event.id);
    } catch (err) {
      console.error('[stripe-webhook] DB insert failed:', err.message);
      // Acknowledge anyway — Stripe will retry, and idempotency on
      // stripe_event_id makes a re-insert safe.
    }

    // B4 part 1: dispatch checkout.session.completed to the orchestrator.
    // Synchronous: we want any orchestration error to surface in our logs
    // before we 200 to Stripe. The orchestrator handles its own
    // idempotency (SELECT ... FOR UPDATE on stripe_events.processed_at)
    // so duplicate webhook deliveries from Stripe become no-op skips.
    //
    // Session D3: subscription.updated, subscription.deleted, and
    // invoice.payment_failed now dispatch to lib/subscription-lifecycle
    // so workspace state stays in sync with Stripe. Each handler is
    // idempotent and best-effort on the audit_log writes. Errors here
    // return 500 so Stripe retries — except for processCheckoutCompleted
    // which catches its own errors (legacy contract preserved).
    const lifecycleCtx = { sms: twilioClient, env: process.env };
    switch (event.type) {
      case 'checkout.session.completed': {
        // E14 Step 5: disambiguate customer payments (direct charge on a
        // connected account) from salon signups. Customer-payment sessions
        // carry metadata.transaction_id, set by /api/transactions/:id/
        // request-payment. Salon-signup sessions only carry draft_id /
        // signup_username / signup_email / vertical — no transaction_id —
        // so any session lacking it falls through to the original
        // signup-orchestrator path exactly as before.
        const sessionObj = event.data && event.data.object;
        const isCustomerPayment = !!(
          sessionObj && sessionObj.metadata && sessionObj.metadata.transaction_id
        );
        if (isCustomerPayment) {
          try {
            const result = await paymentLedger.processCustomerPaymentCompletedEvent(event, pool);
            console.log('[stripe-webhook] customer-payment.completed →', JSON.stringify(result));
          } catch (err) {
            console.error('[stripe-webhook] customer-payment handler error:', err.message);
            return res.status(500).json({ error: 'processing failed' });
          }
        } else {
          try {
            const result = await processCheckoutCompletedEvent(event, pool);
            console.log('[stripe-webhook] orchestrator result:', JSON.stringify(result));
          } catch (orchErr) {
            // Should not throw — processCheckoutCompletedEvent catches its own
            // errors and returns { ok: false }. But defensive in case of bug.
            console.error('[stripe-webhook] orchestrator threw unexpectedly:', orchErr.message);
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        try {
          const result = await subscriptionLifecycle.processSubscriptionUpdatedEvent(
            event, pool, stripeSignup, lifecycleCtx
          );
          console.log('[stripe-webhook] subscription.updated →', JSON.stringify(result));
        } catch (err) {
          console.error('[stripe-webhook] subscription.updated handler error:', err.message);
          return res.status(500).json({ error: 'processing failed' });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        try {
          const result = await subscriptionLifecycle.processSubscriptionDeletedEvent(
            event, pool, lifecycleCtx
          );
          console.log('[stripe-webhook] subscription.deleted →', JSON.stringify(result));
        } catch (err) {
          console.error('[stripe-webhook] subscription.deleted handler error:', err.message);
          return res.status(500).json({ error: 'processing failed' });
        }
        break;
      }
      case 'invoice.payment_failed': {
        try {
          const result = await subscriptionLifecycle.processInvoicePaymentFailedEvent(
            event, pool, lifecycleCtx
          );
          console.log('[stripe-webhook] invoice.payment_failed →', JSON.stringify(result));
        } catch (err) {
          console.error('[stripe-webhook] invoice.payment_failed handler error:', err.message);
          return res.status(500).json({ error: 'processing failed' });
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        // Recovery backstop: if Stripe sends payment_succeeded without an
        // accompanying customer.subscription.updated, the handler flips a
        // past_due workspace back to active. No-op for any other status.
        try {
          const result = await subscriptionLifecycle.processInvoicePaymentSucceededEvent(
            event, pool, lifecycleCtx
          );
          console.log('[stripe-webhook] invoice.payment_succeeded →', JSON.stringify(result));
        } catch (err) {
          console.error('[stripe-webhook] invoice.payment_succeeded handler error:', err.message);
          return res.status(500).json({ error: 'processing failed' });
        }
        break;
      }
      case 'account.updated': {
        // E13: connected account state changed (Stripe pushes this when
        // the owner finishes a step of onboarding, when capabilities flip,
        // or when a requirement appears). Mirror charges_enabled +
        // details_submitted into the workspace and derive connect_status.
        try {
          const result = await connectLifecycle.processAccountUpdatedEvent(event, pool);
          console.log('[stripe-webhook] account.updated →', JSON.stringify(result));
        } catch (err) {
          console.error('[stripe-webhook] account.updated handler error:', err.message);
          return res.status(500).json({ error: 'processing failed' });
        }
        break;
      }
      default:
        console.log('[stripe-webhook] event stored, no handler:', event.type, event.id);
    }
  } else {
    console.log('[stripe-webhook] received (not stored):', event.type, event.id);
  }

  res.json({ received: true });
});

// =====================================================================
// E13 — Stripe Connect (Express) onboarding routes. TEST MODE only.
// No charge / payment-intent code in this session — these endpoints
// just let a PS workspace owner connect their bank via Stripe-hosted
// onboarding and get marked "ready to accept cards." The webhook case
// 'account.updated' above keeps connect_status in lockstep going forward.
//
// Account model: Express connected accounts with Account Links v1
// (stripe.accounts.create({type:'express'}) + stripe.accountLinks.create).
// Reuses the existing stripeSignup test-mode client.
// =====================================================================

// POST /api/connect/onboarding/start
// Authenticated. PS workspaces only. On first call, creates an Express
// connected account and stores the acct_xxx id on the workspace. On every
// call (first or repeat), mints a fresh Account Link and returns its url;
// the frontend redirects the browser to it.
app.post('/api/connect/onboarding/start', requireAuth, async (req, res) => {
  if (!stripeSignup) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'workspace_not_found' });

    const wr = await pool.query(
      `SELECT w.id, w.vertical, w.stripe_connect_account_id,
              w.business_name, u.email
         FROM workspaces w
         JOIN users u ON u.id = w.owner_user_id
        WHERE w.id = $1`,
      [workspaceId]
    );
    const workspace = wr.rows[0];
    if (!workspace) return res.status(404).json({ error: 'workspace_not_found' });
    if (workspace.vertical !== 'professional-services') {
      return res.status(400).json({ error: 'PS workspaces only' });
    }

    // First-time setup: create the Express account, persist its id, mark
    // the workspace 'pending' (any further status comes from the webhook
    // or the return-route sync).
    let accountId = workspace.stripe_connect_account_id;
    if (!accountId) {
      const account = await stripeSignup.accounts.create({
        type: 'express',
        country: 'US',
        email: workspace.email || undefined,
        business_profile: workspace.business_name
          ? { name: workspace.business_name }
          : undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      await pool.query(
        `UPDATE workspaces
            SET stripe_connect_account_id = $1,
                connect_status            = 'pending',
                connect_updated_at        = NOW()
          WHERE id = $2`,
        [accountId, workspaceId]
      );
    }

    const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
    const link = await stripeSignup.accountLinks.create({
      account: accountId,
      refresh_url: `${base}/payments/connect/refresh`,
      return_url:  `${base}/payments/connect/return`,
      type: 'account_onboarding',
    });

    res.json({ url: link.url, account_id: accountId });
  } catch (err) {
    console.error('[connect] onboarding/start error:', err.message);
    res.status(500).json({ error: 'connect_start_failed', detail: err.message });
  }
});

// GET /payments/connect/return
// Owner came back from Stripe-hosted onboarding. Don't trust the
// redirect itself to mean completion — re-fetch the account from Stripe
// and mirror its state into the workspaces row before bouncing back
// into the app. The webhook case is the source of truth long-term, but
// this synchronous sync gives the user immediate feedback on the
// Finances page when they land.
app.get('/payments/connect/return', requireAuthPage, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (workspaceId && stripeSignup) {
      const wr = await pool.query(
        `SELECT stripe_connect_account_id FROM workspaces WHERE id = $1`,
        [workspaceId]
      );
      const accountId = wr.rows[0] && wr.rows[0].stripe_connect_account_id;
      if (accountId) {
        try {
          const account = await stripeSignup.accounts.retrieve(accountId);
          await connectLifecycle.syncAccountState(pool, account);
        } catch (e) {
          // Non-fatal — the webhook will catch up. Still bounce the
          // owner into the app so they're not stranded on a blank page.
          console.error('[connect] return-sync failed (non-fatal):', e.message);
        }
      }
    }
  } catch (err) {
    console.error('[connect] return route error (non-fatal):', err.message);
  }
  res.redirect('/workspace');
});

// GET /payments/connect/refresh
// Stripe redirects here when the Account Link expired (24-hour TTL) or
// the owner reloaded the onboarding page. Mint a new link and bounce
// the browser back into Stripe's hosted flow.
app.get('/payments/connect/refresh', requireAuthPage, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId || !stripeSignup) return res.redirect('/workspace');
    const wr = await pool.query(
      `SELECT stripe_connect_account_id FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    const accountId = wr.rows[0] && wr.rows[0].stripe_connect_account_id;
    if (!accountId) return res.redirect('/workspace');

    const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
    const link = await stripeSignup.accountLinks.create({
      account: accountId,
      refresh_url: `${base}/payments/connect/refresh`,
      return_url:  `${base}/payments/connect/return`,
      type: 'account_onboarding',
    });
    return res.redirect(link.url);
  } catch (err) {
    console.error('[connect] refresh route error:', err.message);
    res.redirect('/workspace');
  }
});

app.post('/api/signup', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const forwardToken = generateForwardToken();
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, email, plan, payment_forward_token) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [username.trim().toLowerCase(), hash, email || '', 'free', forwardToken]
    );
    const user = rows[0];
    // Ensure automation row exists
    await pool.query('INSERT INTO automation (user_id, "autoReplyEnabled") VALUES ($1, false) ON CONFLICT DO NOTHING', [user.id]);
    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/api/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, email, plan, onboarding_completed FROM users WHERE id=$1', [req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

app.put('/api/me/onboarding', requireAuth, async (req, res) => {
  await pool.query('UPDATE users SET onboarding_completed=true WHERE id=$1', [req.session.userId]);
  res.json({ success: true });
});

// Session D5: single-call summary of current plan, status, limits,
// features, and live usage counters. Frontend caches the response in
// window._planSummary and re-fetches after actions that change counts
// (resource creation, AI command, report generation).
//
// Resource counts mirror the D4 gate counting logic:
//   - properties: workspace_id-scoped, archived_at IS NULL
//   - units: workspace_id-scoped, status != 'retired'
//   - contacts: user_id-scoped (legacy table, no workspace_id)
app.get('/api/plan-summary', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) {
      return res.status(404).json({ error: 'workspace_not_found' });
    }

    const planInfo = await planEnforcement.getWorkspacePlanInfo(pool, workspaceId);
    if (!planInfo) {
      return res.status(404).json({ error: 'workspace_not_found' });
    }
    const planName = planInfo.plan || 'team';
    const planConfig = plans.getPlan(planName);

    const aiCommandsToday = await usage.getAICommandCountToday(pool, {
      workspaceId, userId,
    });
    const reportsThisMonth = await usage.getReportCountThisMonth(pool, {
      workspaceId,
    });

    let propertiesCount = 0;
    let unitsCount = 0;
    let contactsCount = 0;
    try {
      const r1 = await pool.query(
        `SELECT COUNT(*) AS c FROM entities WHERE workspace_id = $1 AND archived_at IS NULL`,
        [workspaceId]
      );
      propertiesCount = parseInt(r1.rows[0].c, 10);
      const r2 = await pool.query(
        `SELECT COUNT(*) AS c FROM offerings WHERE workspace_id = $1 AND status != 'retired'`,
        [workspaceId]
      );
      unitsCount = parseInt(r2.rows[0].c, 10);
      const r3 = await pool.query(
        `SELECT COUNT(*) AS c FROM contacts WHERE user_id = $1`,
        [userId]
      );
      contactsCount = parseInt(r3.rows[0].c, 10);
    } catch (err) {
      console.error('[plan-summary] resource count failed:', err.message);
    }

    // E3: include workspace vertical so the Finances page can render the
    // correct sections (PS sees Transactions; PM sees Rent Payments).
    // E4: also include inventory_tracking_enabled so the frontend knows
    // whether to show the Inventory sidebar item (PS-only AND opt-in).
    // E13: also include the connect_* columns so the PS Finances page
    // can render the right "Card Payments" status card variant without
    // making a second fetch.
    let workspaceVertical = 'property-management';
    let inventoryTrackingEnabled = false;
    let connectStatus = 'not_started';
    let connectChargesEnabled = false;
    let connectDetailsSubmitted = false;
    // CP1: the browser needs the workspace timezone to render calendar
    // times correctly (nullable — frontend falls back to browser tz).
    let workspaceTimezone = null;
    try {
      const wR = await pool.query(
        `SELECT vertical, inventory_tracking_enabled, timezone,
                connect_status, connect_charges_enabled, connect_details_submitted
           FROM workspaces WHERE id = $1`,
        [workspaceId]
      );
      if (wR.rows[0]) {
        if (wR.rows[0].vertical) workspaceVertical = wR.rows[0].vertical;
        inventoryTrackingEnabled = !!wR.rows[0].inventory_tracking_enabled;
        if (wR.rows[0].connect_status) connectStatus = wR.rows[0].connect_status;
        connectChargesEnabled = !!wR.rows[0].connect_charges_enabled;
        connectDetailsSubmitted = !!wR.rows[0].connect_details_submitted;
        // Send the EFFECTIVE timezone: wsTz maps a NULL column to the
        // same America/New_York default the server itself books with,
        // so browser rendering can never disagree with server writes.
        const { wsTz } = require('./lib/time-helpers');
        workspaceTimezone = wsTz(wR.rows[0]);
      }
    } catch (e) { /* fall through with defaults */ }

    res.json({
      plan: planName,
      plan_display_name: planConfig.displayName,
      monthly_price: planConfig.monthlyPrice,
      subscription_status: planInfo.subscription_status || 'active',
      workspace_vertical: workspaceVertical,
      inventory_tracking_enabled: inventoryTrackingEnabled,
      // E13: Stripe Connect onboarding state. PS Finances page reads these
      // to render the right "Card Payments" status card variant.
      connect_status: connectStatus,
      connect_charges_enabled: connectChargesEnabled,
      connect_details_submitted: connectDetailsSubmitted,
      workspace_timezone: workspaceTimezone,
      limits: planConfig.limits,
      features: planConfig.features,
      usage: {
        ai_commands_today: aiCommandsToday || 0,
        reports_this_month: reportsThisMonth || 0,
        properties: propertiesCount,
        units: unitsCount,
        contacts: contactsCount,
      },
    });
  } catch (err) {
    console.error('[plan-summary] error:', err);
    res.status(500).json({ error: 'plan_summary_failed' });
  }
});

// Session E8: PS Home dashboard data. PS-only. Returns stats + 5 card lists
// in one response so the frontend renders the whole dashboard from a single
// fetch. Each section is wrapped in try/catch — one failing query doesn't
// nuke the rest; failures degrade to empty arrays / zeros so the UI stays
// stable and the user just sees stale-but-coherent data until the next poll.
//
// Polling: the frontend hits this every 30s while the user is on the Home
// page. Stops polling when the user navigates away.
app.get('/api/dashboard/ps', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'workspace_not_found' });

    // Workspace meta — also gates the endpoint to PS workspaces only.
    let workspace;
    try {
      const wR = await pool.query(
        `SELECT id, owner_user_id, vertical, inventory_tracking_enabled
           FROM workspaces WHERE id = $1`,
        [workspaceId]
      );
      workspace = wR.rows[0];
    } catch (e) {
      return res.status(500).json({ error: 'workspace_lookup_failed' });
    }
    if (!workspace) return res.status(404).json({ error: 'workspace_not_found' });
    if (workspace.vertical !== 'professional-services') {
      return res.status(400).json({ error: 'PS workspaces only' });
    }

    // Each block guarded — a query failure logs and the section degrades
    // to an empty result rather than 500ing the whole dashboard.
    let appointments_today = [];
    let appointments_today_count = 0;
    try {
      const r = await pool.query(
        `SELECT id, starts_at, duration_minutes, ends_at, title,
                status, contact_id,
                COALESCE(
                  (SELECT name FROM contacts WHERE contacts.id = appointments.contact_id LIMIT 1),
                  'Walk-in'
                ) AS customer_display_name
           FROM appointments
          WHERE workspace_id = $1
            AND starts_at >= date_trunc('day', NOW())
            AND starts_at <  date_trunc('day', NOW()) + INTERVAL '1 day'
            AND status NOT IN ('canceled', 'no_show')
          ORDER BY starts_at ASC
          LIMIT 20`,
        [workspaceId]
      );
      appointments_today = r.rows;
      appointments_today_count = r.rowCount;
    } catch (err) {
      console.error('[dashboard/ps] appointments_today failed:', err.message);
    }

    let ai_conversations = [];
    let ai_conversations_active = 0;
    try {
      const r = await pool.query(
        `SELECT id, state, customer_phone, customer_email,
                last_customer_message_at, last_ai_message_at,
                message_count, context_summary
           FROM appointment_threads
          WHERE workspace_id = $1
            AND state NOT IN ('complete', 'closed')
          ORDER BY last_customer_message_at DESC NULLS LAST
          LIMIT 10`,
        [workspaceId]
      );
      ai_conversations = r.rows;
      const cR = await pool.query(
        `SELECT COUNT(*)::int AS c FROM appointment_threads
          WHERE workspace_id = $1 AND state NOT IN ('complete', 'closed')`,
        [workspaceId]
      );
      ai_conversations_active = cR.rows[0] ? cR.rows[0].c : 0;
    } catch (err) {
      console.error('[dashboard/ps] ai_conversations failed:', err.message);
    }

    let pending_approvals = [];
    let pending_approvals_count = 0;
    try {
      const r = await pool.query(
        `SELECT id, tool_name, ai_summary, status, created_at
           FROM pending_actions
          WHERE workspace_id = $1 AND status = 'pending'
          ORDER BY created_at DESC
          LIMIT 10`,
        [workspaceId]
      );
      pending_approvals = r.rows;
      const cR = await pool.query(
        `SELECT COUNT(*)::int AS c FROM pending_actions
          WHERE workspace_id = $1 AND status = 'pending'`,
        [workspaceId]
      );
      pending_approvals_count = cR.rows[0] ? cR.rows[0].c : 0;
    } catch (err) {
      console.error('[dashboard/ps] pending_approvals failed:', err.message);
    }

    let recent_transactions = [];
    try {
      const r = await pool.query(
        `SELECT id, customer_display_name, total_cents, amount_paid_cents,
                status, payment_method, payment_received_at, created_at
           FROM transactions
          WHERE workspace_id = $1
            AND status IN ('paid', 'partially_paid')
          ORDER BY payment_received_at DESC NULLS LAST
          LIMIT 10`,
        [workspaceId]
      );
      recent_transactions = r.rows;
    } catch (err) {
      console.error('[dashboard/ps] recent_transactions failed:', err.message);
    }

    let revenue_this_week_cents = 0;
    try {
      const r = await pool.query(
        `SELECT COALESCE(SUM(amount_paid_cents), 0)::bigint AS s
           FROM transactions
          WHERE workspace_id = $1
            AND status IN ('paid', 'partially_paid')
            AND payment_received_at >= date_trunc('week', NOW())`,
        [workspaceId]
      );
      revenue_this_week_cents = r.rows[0] ? Number(r.rows[0].s) : 0;
    } catch (err) {
      console.error('[dashboard/ps] revenue_this_week failed:', err.message);
    }

    let low_stock = [];
    if (workspace.inventory_tracking_enabled) {
      try {
        const r = await pool.query(
          `SELECT id, name, status, quantity, unit, preferred_vendor_id
             FROM inventory_items
            WHERE workspace_id = $1
              AND status IN ('low', 'out')
              AND archived_at IS NULL
            ORDER BY CASE status WHEN 'out' THEN 0 ELSE 1 END, name ASC
            LIMIT 20`,
          [workspaceId]
        );
        low_stock = r.rows;
      } catch (err) {
        console.error('[dashboard/ps] low_stock failed:', err.message);
      }
    }

    res.json({
      stats: {
        appointments_today: appointments_today_count,
        pending_approvals: pending_approvals_count,
        revenue_this_week_cents,
        ai_conversations_active,
      },
      appointments_today,
      ai_conversations,
      pending_approvals,
      recent_transactions,
      low_stock,
      inventory_tracking_enabled: !!workspace.inventory_tracking_enabled,
    });
  } catch (err) {
    console.error('[dashboard/ps] error:', err);
    res.status(500).json({ error: 'dashboard_failed' });
  }
});

// Session E12: Daily Focus. Ensures exactly one AI-generated "grow your
// business" calendar event exists for today, then returns it. Idempotent
// per workspace per day — safe to call on every app open. The frontend
// fires this from window.onload; only the first call of the day does any
// AI work (the existence check short-circuits the rest).
//
// The event is created on cal_events with event_type='daily_focus' (added
// to the CHECK constraint by migration 040), is_all_day=true, dated today.
// It surfaces on the Calendar page like any other all-day event.
//
// Not gated by subscription status and NOT counted toward the D4 AI
// command quota — this is a background nicety, not a user-issued command.
app.post('/api/daily-nudge/ensure', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(404).json({ error: 'workspace_not_found' });

    let workspace;
    try {
      const wr = await pool.query(
        'SELECT id, vertical, owner_user_id, business_name, name, timezone FROM workspaces WHERE id = $1',
        [workspaceId]
      );
      workspace = wr.rows[0];
    } catch (e) {
      return res.status(500).json({ error: 'workspace_lookup_failed' });
    }
    if (!workspace) return res.status(404).json({ error: 'workspace_not_found' });

    // FD3-CP7 (look-first b): the nudge's one-per-day idempotency key is
    // now the WORKSPACE's calendar day, not UTC's — an owner opening the
    // app at 9 PM Eastern no longer gets tomorrow's nudge early.
    const today = require('./lib/time-helpers').wsToday(workspace);

    // Idempotency: at most one daily_focus event per workspace per day.
    // The partial index idx_cal_events_daily_focus (migration 040) keeps
    // this lookup fast.
    const existing = await pool.query(
      `SELECT id, title FROM cal_events
        WHERE workspace_id = $1 AND event_type = 'daily_focus' AND date = $2
        ORDER BY id DESC LIMIT 1`,
      [workspaceId, today]
    );
    if (existing.rows.length) {
      return res.json({ created: false, nudge: existing.rows[0] });
    }

    // Generate today's suggestion. If generation fails, don't create a
    // placeholder event — just report it and let the next app open retry.
    let suggestion;
    try {
      suggestion = await generateDailyNudge(workspace);
    } catch (err) {
      console.error('[daily-nudge] generation failed:', err.message);
      return res.json({ created: false, error: 'generation_failed' });
    }
    if (!suggestion) {
      return res.json({ created: false, error: 'generation_empty' });
    }

    // All-day event for today (midnight-to-midnight, UTC — matches the
    // backfill convention from migration 034 and add_calendar_event.js).
    const startsAt = new Date(today + 'T00:00:00.000Z');
    const endsAt = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);
    const title = '\u{1F4A1} ' + suggestion; // lightbulb prefix so it's recognizable on the calendar

    let inserted;
    try {
      const r = await pool.query(
        `INSERT INTO cal_events
           (user_id, workspace_id, date, title, starts_at, ends_at, is_all_day, event_type)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'daily_focus')
         RETURNING id, title`,
        [workspace.owner_user_id, workspaceId, today, title,
          startsAt.toISOString(), endsAt.toISOString()]
      );
      inserted = r.rows[0];
    } catch (err) {
      console.error('[daily-nudge] cal_events insert failed:', err.message);
      return res.status(500).json({ error: 'daily_nudge_insert_failed' });
    }

    res.json({ created: true, nudge: inserted });
  } catch (err) {
    console.error('[daily-nudge] error:', err.message);
    res.status(500).json({ error: 'daily_nudge_failed' });
  }
});

// Session D5: Stripe Customer Portal session for self-serve plan
// management. Distinct from the legacy GET /api/billing/portal route
// (which uses the legacy `stripe` client and stays untouched). This
// endpoint uses the new-flow `stripeSignup` client and looks up the
// customer ID set by the signup orchestrator at users.stripe_customer_id.
app.post('/api/billing/portal-session', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { rows } = await pool.query(
      `SELECT stripe_customer_id FROM users WHERE id = $1`,
      [userId]
    );
    const customerId = rows[0] && rows[0].stripe_customer_id;
    if (!customerId) {
      return res.status(400).json({
        error: 'no_stripe_customer',
        message: 'No billing record on file. Please contact support.',
      });
    }
    if (!stripeSignup) {
      return res.status(500).json({
        error: 'billing_not_configured',
        message: 'Billing is not configured on this server. Please contact support.',
      });
    }

    const proto = req.protocol || 'http';
    const host = req.headers.host || 'localhost:4000';
    const session = await stripeSignup.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${proto}://${host}/workspace`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing portal-session] error:', err.message);
    res.status(500).json({ error: 'portal_session_failed' });
  }
});

// --- Connected Email Account (IMAP/SMTP) ---

// Returns connection status + detected settings (for setup UI)
app.get('/api/email-account', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, provider, imap_host, imap_port, smtp_host, smtp_port, sync_enabled, last_sync_at
       FROM email_accounts WHERE user_id=$1`,
      [req.session.userId]
    );
    res.json({ connected: rows.length > 0, account: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-detect settings from email address (for pre-filling the setup form)
app.get('/api/email-account/detect', requireAuth, async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email is required' });
  res.json(detectEmailProvider(email));
});

// Test credentials without saving
app.post('/api/email-account/test', requireAuth, async (req, res) => {
  try {
    const { email, password, imap_host, imap_port } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const detected = detectEmailProvider(email);
    const result = await testImapConnection({
      email,
      password,
      imap_host: imap_host || detected.imap,
      imap_port: imap_port || detected.imap_port
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Connect or update an email account
app.post('/api/email-account/connect', requireAuth, async (req, res) => {
  try {
    const { email, password, imap_host, imap_port, smtp_host, smtp_port } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const detected = detectEmailProvider(email);
    const finalImapHost = imap_host || detected.imap;
    const finalImapPort = imap_port || detected.imap_port;
    const finalSmtpHost = smtp_host || detected.smtp;
    const finalSmtpPort = smtp_port || detected.smtp_port;

    // Test the IMAP connection before saving
    const test = await testImapConnection({
      email, password,
      imap_host: finalImapHost, imap_port: finalImapPort
    });
    if (!test.success) return res.status(400).json({ error: 'Connection failed: ' + test.error });

    const encrypted = encryptSecret(password);

    // Upsert (one account per user)
    await pool.query(
      `INSERT INTO email_accounts
         (user_id, email, provider, imap_host, imap_port, smtp_host, smtp_port, encrypted_password, sync_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       ON CONFLICT (user_id) DO UPDATE SET
         email=EXCLUDED.email,
         provider=EXCLUDED.provider,
         imap_host=EXCLUDED.imap_host,
         imap_port=EXCLUDED.imap_port,
         smtp_host=EXCLUDED.smtp_host,
         smtp_port=EXCLUDED.smtp_port,
         encrypted_password=EXCLUDED.encrypted_password,
         sync_enabled=true,
         last_sync_uid=0`,
      [req.session.userId, email, detected.name, finalImapHost, finalImapPort, finalSmtpHost, finalSmtpPort, encrypted]
    );

    // Trigger an immediate sync in the background
    syncEmailAccount(req.session.userId).catch(err => console.error('Initial sync error:', err.message));

    res.json({ success: true });
  } catch (err) {
    console.error('Email connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Trigger a manual sync
app.post('/api/email-account/sync', requireAuth, async (req, res) => {
  try {
    const result = await syncEmailAccount(req.session.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect (removes credentials)
app.delete('/api/email-account', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM email_accounts WHERE user_id=$1', [req.session.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Payment Forwarding ---
app.get('/api/payments/forwarding-info', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT payment_forward_token FROM users WHERE id=$1',
      [req.session.userId]
    );
    let token = rows[0]?.payment_forward_token;
    if (!token) {
      token = generateForwardToken();
      await pool.query('UPDATE users SET payment_forward_token=$1 WHERE id=$2', [token, req.session.userId]);
    }
    const domain = 'modernmanagementapp.com';
    res.json({ token, address: `payments+${token}@${domain}` });
  } catch (err) {
    console.error('forwarding-info error:', err.message);
    res.status(500).json({ error: 'Failed to load forwarding info' });
  }
});

app.post('/api/payments/rotate-token', requireAuth, async (req, res) => {
  try {
    const token = generateForwardToken();
    await pool.query('UPDATE users SET payment_forward_token=$1 WHERE id=$2', [token, req.session.userId]);
    res.json({ token, address: `payments+${token}@modernmanagementapp.com` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rotate token' });
  }
});

// List payment events (all + optional status filter)
app.get('/api/payments/events', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let q = `SELECT pe.*, rp.resident AS rent_resident, rp.unit AS rent_unit, rp.amount AS rent_amount, rp.due_date AS rent_due_date
             FROM payment_events pe
             LEFT JOIN rent_payments rp ON rp.id = pe.matched_rent_id
             WHERE pe.user_id=$1`;
    const params = [req.session.userId];
    if (status) { params.push(status); q += ` AND pe.status=$${params.length}`; }
    q += ` ORDER BY pe."createdAt" DESC LIMIT 100`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    console.error('events error:', err.message);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// Confirm a needs_review event (apply the match, mark rent paid)
app.post('/api/payments/events/:id/confirm', requireAuth, async (req, res) => {
  try {
    const { rentId } = req.body; // optional — override match
    const { rows } = await pool.query(
      'SELECT * FROM payment_events WHERE id=$1 AND user_id=$2',
      [Number(req.params.id), req.session.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    const event = rows[0];
    const finalRentId = rentId || event.matched_rent_id;
    if (!finalRentId) return res.status(400).json({ error: 'No rent record to match' });
    await markRentPaidFromEvent(req.session.userId, finalRentId, event.parsed_date);
    await pool.query(
      `UPDATE payment_events SET status='auto_matched', matched_rent_id=$1 WHERE id=$2`,
      [finalRentId, event.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('confirm error:', err.message);
    res.status(500).json({ error: 'Failed to confirm' });
  }
});

// Dismiss an event (ignore without matching)
app.post('/api/payments/events/:id/dismiss', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE payment_events SET status='dismissed' WHERE id=$1 AND user_id=$2`,
      [Number(req.params.id), req.session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dismiss' });
  }
});

// Test endpoint — feed a fake payment email to test matching
app.post('/api/payments/test', requireAuth, async (req, res) => {
  try {
    const { from, subject, body } = req.body;
    if (!body) return res.status(400).json({ error: 'body is required' });
    const event = await processPaymentEmail(req.session.userId, {
      from: from || 'test@example.com',
      subject: subject || 'Test payment',
      body
    });
    res.json(event);
  } catch (err) {
    console.error('test error:', err.message);
    res.status(500).json({ error: 'Test failed', details: err.message });
  }
});

// Protect all /api/* routes except login/signup and inbound webhooks
app.use('/api', (req, res, next) => {
  const open = ['/login', '/signup', '/sms/incoming', '/email/incoming', '/voice/incoming', '/voice/recording', '/voice/transcription', '/voice/relay-incoming', '/billing/webhook'];
  if (open.some(p => req.path === p)) return next();
  if (req.session && req.session.authenticated && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// --- Contacts ---
app.get('/api/contacts', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM contacts WHERE user_id=$1 ORDER BY name ASC', [req.session.userId]);
  res.json(rows);
});

app.post('/api/contacts', requireAuth, async (req, res) => {
  const { name, type, unit, email, phone, notes } = req.body;

  // Session D4: subscription status + maxContacts cap (user_id-scoped)
  const _workspaceIdContacts = await getWorkspaceId(req);
  const _planInfoContacts = await planEnforcement.getWorkspacePlanInfo(pool, _workspaceIdContacts);
  const _statusCheckContacts = planEnforcement.checkSubscriptionStatus(_planInfoContacts);
  if (!_statusCheckContacts.allowed) {
    return res.status(403).json({ error: _statusCheckContacts.reason, message: _statusCheckContacts.suggestion });
  }
  try {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS c FROM contacts WHERE user_id = $1`,
      [req.session.userId]
    );
    const _currentCountContacts = parseInt(countRows[0].c, 10);
    const _limitCheckContacts = planEnforcement.checkResourceLimit(_planInfoContacts, 'maxContacts', _currentCountContacts);
    if (!_limitCheckContacts.allowed) {
      return res.status(403).json({ error: _limitCheckContacts.reason, message: _limitCheckContacts.suggestion });
    }
  } catch (e) {
    console.error('[plan-enforcement] contacts count failed:', e.message);
  }

  const { rows } = await pool.query(
    'INSERT INTO contacts (user_id, name, type, unit, email, phone, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.session.userId, name, type, unit || '', email || '', phone || '', notes || '']
  );
  res.status(201).json(rows[0]);
});

app.put('/api/contacts/:id', requireAuth, async (req, res) => {
  const { name, type, unit, email, phone, notes, lease_start, lease_end, monthly_rent } = req.body;
  const { rows } = await pool.query(
    `UPDATE contacts SET name=$1, type=$2, unit=$3, email=$4, phone=$5, notes=$6,
     lease_start=$7, lease_end=$8, monthly_rent=$9 WHERE id=$10 AND user_id=$11 RETURNING *`,
    [name, type, unit || '', email || '', phone || '', notes || '',
     lease_start || '', lease_end || '', Number(monthly_rent) || 0,
     Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Contact not found' });
  res.json(rows[0]);
});

app.delete('/api/contacts/:id', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM contacts WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Contact not found' });
  res.json({ success: true });
});

// Leases — residents with upcoming expirations
app.get('/api/leases', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT *, lease_end::date - CURRENT_DATE AS days_until
     FROM contacts
     WHERE user_id=$1 AND type='resident' AND lease_end != '' AND lease_end IS NOT NULL
     ORDER BY lease_end ASC`,
    [req.session.userId]
  );
  res.json(rows);
});

// Auto-create renewal tasks for leases expiring within 90 days
app.post('/api/leases/check-renewals', requireAuth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const in90 = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0];

  const { rows: expiring } = await pool.query(
    `SELECT * FROM contacts WHERE user_id=$1 AND type='resident'
     AND lease_end != '' AND lease_end IS NOT NULL
     AND lease_end BETWEEN $2 AND $3`,
    [req.session.userId, today, in90]
  );

  let created = 0;
  for (const c of expiring) {
    // Only suggest if no existing open renewal task for this resident
    const { rows: existing } = await pool.query(
      `SELECT id FROM tasks WHERE user_id=$1 AND done=false AND suggested=true
       AND title ILIKE $2`,
      [req.session.userId, `%renewal%${c.name}%`]
    );
    if (existing.length) continue;

    const daysUntil = Math.round((new Date(c.lease_end) - new Date(today)) / 86400000);
    const urgency = daysUntil <= 30 ? 'URGENT' : daysUntil <= 60 ? 'Soon' : 'Upcoming';
    const dueDate = new Date(Math.max(Date.now(), new Date(c.lease_end) - 30 * 86400000))
      .toISOString().split('T')[0];

    await pool.query(
      `INSERT INTO tasks (user_id, title, category, "dueDate", notes, done, suggested, "aiReason")
       VALUES ($1,$2,$3,$4,$5,false,true,$6)`,
      [
        req.session.userId,
        `[${urgency}] Lease renewal — ${c.name}${c.unit ? ` (Unit ${c.unit})` : ''}`,
        'lease',
        dueDate,
        `Lease expires ${c.lease_end} (${daysUntil} days). Contact resident to discuss renewal terms or non-renewal notice.`,
        `Lease ends in ${daysUntil} day${daysUntil !== 1 ? 's' : ''} — renewal decision needed before expiry.`
      ]
    );
    created++;
  }
  res.json({ checked: expiring.length, tasksCreated: created });
});

// --- Inventory: Entities (Properties in PM vertical) ---
// Workspace-scoped. Archived (soft-deleted) entities are hidden from the
// default list; pass ?include_archived=true to include them. DELETE is
// soft-delete via archived_at (migration 018). See plan §2.2.

app.get('/api/entities', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
  const includeArchived = req.query.include_archived === 'true';
  const sql = includeArchived
    ? 'SELECT * FROM entities WHERE workspace_id=$1 ORDER BY name ASC'
    : 'SELECT * FROM entities WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name ASC';
  try {
    const { rows } = await pool.query(sql, [workspaceId]);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/entities error:', err.message);
    res.status(500).json({ error: 'Failed to list entities' });
  }
});

app.get('/api/entities/:id', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM entities WHERE id=$1 AND workspace_id=$2',
      [Number(req.params.id), workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Entity not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/entities/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch entity' });
  }
});

app.post('/api/entities', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

  const name = (req.body.name || '').trim();
  const address = (req.body.address || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  // Session D4: subscription status + maxProperties cap
  const _planInfoEntities = await planEnforcement.getWorkspacePlanInfo(pool, workspaceId);
  const _statusCheckEntities = planEnforcement.checkSubscriptionStatus(_planInfoEntities);
  if (!_statusCheckEntities.allowed) {
    return res.status(403).json({ error: _statusCheckEntities.reason, message: _statusCheckEntities.suggestion });
  }
  try {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS c FROM entities
       WHERE workspace_id = $1 AND archived_at IS NULL`,
      [workspaceId]
    );
    const _currentCountEntities = parseInt(countRows[0].c, 10);
    const _limitCheckEntities = planEnforcement.checkResourceLimit(_planInfoEntities, 'maxProperties', _currentCountEntities);
    if (!_limitCheckEntities.allowed) {
      return res.status(403).json({ error: _limitCheckEntities.reason, message: _limitCheckEntities.suggestion });
    }
  } catch (e) {
    // Best-effort: if the count query itself fails, allow the create.
    console.error('[plan-enforcement] entities count failed:', e.message);
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO entities (
         workspace_id, name, entity_type, address, description,
         number_of_floors, total_unit_count, building_type, year_built,
         heating_system, water_source, parking_setup, pet_policy, smoking_policy,
         shared_amenities, emergency_contacts, service_vendors
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13, $14,
         $15::jsonb, $16::jsonb, $17::jsonb
       ) RETURNING *`,
      [
        workspaceId,
        name,
        req.body.entity_type || 'property',
        address,
        req.body.description || '',
        req.body.number_of_floors ?? null,
        req.body.total_unit_count ?? null,
        req.body.building_type ?? null,
        req.body.year_built ?? null,
        req.body.heating_system ?? null,
        req.body.water_source ?? null,
        req.body.parking_setup ?? null,
        req.body.pet_policy ?? null,
        req.body.smoking_policy ?? null,
        JSON.stringify(req.body.shared_amenities || []),
        JSON.stringify(req.body.emergency_contacts || []),
        JSON.stringify(req.body.service_vendors || []),
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/entities error:', err.message);
    res.status(500).json({ error: 'Failed to create entity: ' + err.message });
  }
});

app.patch('/api/entities/:id', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

  // Required-if-present: if name/address is in the body, it can't be empty.
  if (Object.prototype.hasOwnProperty.call(req.body, 'name') &&
      !(req.body.name || '').trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'address') &&
      !(req.body.address || '').trim()) {
    return res.status(400).json({ error: 'address cannot be empty' });
  }

  // Only update fields present in the body. Prevents null-overwrites.
  const scalarFields = [
    'name', 'address', 'entity_type', 'description', 'number_of_floors',
    'total_unit_count', 'building_type', 'year_built', 'heating_system',
    'water_source', 'parking_setup', 'pet_policy', 'smoking_policy'
  ];
  const jsonbFields = ['shared_amenities', 'emergency_contacts', 'service_vendors'];

  const setParts = [];
  const values = [];
  let i = 1;

  for (const f of scalarFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, f)) {
      setParts.push(`${f} = $${i}`);
      values.push(req.body[f]);
      i++;
    }
  }
  for (const f of jsonbFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, f)) {
      setParts.push(`${f} = $${i}::jsonb`);
      values.push(JSON.stringify(req.body[f]));
      i++;
    }
  }

  if (!setParts.length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.push(Number(req.params.id), workspaceId);

  try {
    const { rows } = await pool.query(
      `UPDATE entities SET ${setParts.join(', ')}
       WHERE id=$${i} AND workspace_id=$${i + 1} AND archived_at IS NULL
       RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Entity not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /api/entities/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update entity' });
  }
});

app.delete('/api/entities/:id', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
  try {
    // COALESCE preserves the original archive timestamp on re-delete
    // (idempotent). NOW() only fires on first archive.
    const { rows } = await pool.query(
      `UPDATE entities SET archived_at = COALESCE(archived_at, NOW())
       WHERE id=$1 AND workspace_id=$2
       RETURNING id, archived_at`,
      [Number(req.params.id), workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Entity not found' });
    res.json({ id: rows[0].id, archived_at: rows[0].archived_at });
  } catch (err) {
    console.error('DELETE /api/entities/:id error:', err.message);
    res.status(500).json({ error: 'Failed to archive entity' });
  }
});

// --- Inventory: Offerings (Units in PM vertical) ---
// Workspace-scoped. Retired offerings are hidden from the default list;
// pass ?include_retired=true to include them. DELETE is soft-delete via
// status='retired' (no separate archived_at column for offerings — see
// asymmetry note in migration 018). Allowed status values: draft,
// available, unavailable, retired. 'occupied' is NEVER stored here;
// it is derived client-side from engagement rows per plan §2.11 / §2.12.

app.get('/api/offerings', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

  const includeRetired = req.query.include_retired === 'true';
  const entityFilter = req.query.entity_id ? Number(req.query.entity_id) : null;

  const params = [workspaceId];
  let where = 'workspace_id = $1';
  if (entityFilter) {
    params.push(entityFilter);
    where += ` AND entity_id = $${params.length}`;
  }
  if (!includeRetired) {
    where += ` AND status <> 'retired'`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM offerings WHERE ${where} ORDER BY entity_id, name ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/offerings error:', err.message);
    res.status(500).json({ error: 'Failed to list offerings' });
  }
});

app.get('/api/offerings/:id', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM offerings WHERE id=$1 AND workspace_id=$2',
      [Number(req.params.id), workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Offering not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/offerings/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch offering' });
  }
});

app.post('/api/offerings', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

  const name = (req.body.name || '').trim();
  const entityId = Number(req.body.entity_id);
  if (!name) return res.status(400).json({ error: 'name is required' });

  // Session D4: subscription status + maxUnits cap (workspace-wide)
  const _planInfoOfferings = await planEnforcement.getWorkspacePlanInfo(pool, workspaceId);
  const _statusCheckOfferings = planEnforcement.checkSubscriptionStatus(_planInfoOfferings);
  if (!_statusCheckOfferings.allowed) {
    return res.status(403).json({ error: _statusCheckOfferings.reason, message: _statusCheckOfferings.suggestion });
  }
  try {
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS c FROM offerings
       WHERE workspace_id = $1 AND status != 'retired'`,
      [workspaceId]
    );
    const _currentCountOfferings = parseInt(countRows[0].c, 10);
    const _limitCheckOfferings = planEnforcement.checkResourceLimit(_planInfoOfferings, 'maxUnits', _currentCountOfferings);
    if (!_limitCheckOfferings.allowed) {
      return res.status(403).json({ error: _limitCheckOfferings.reason, message: _limitCheckOfferings.suggestion });
    }
  } catch (e) {
    console.error('[plan-enforcement] offerings count failed:', e.message);
  }
  if (!entityId || !Number.isInteger(entityId)) {
    return res.status(400).json({ error: 'entity_id is required and must be a number' });
  }

  // Validate optional status / price_frequency if provided
  if (req.body.status !== undefined) {
    const allowed = ['draft', 'available', 'unavailable', 'retired'];
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
  }
  if (req.body.price_frequency !== undefined) {
    const allowed = ['one-time', 'monthly', 'quarterly', 'annual', 'hourly'];
    if (!allowed.includes(req.body.price_frequency)) {
      return res.status(400).json({ error: `price_frequency must be one of: ${allowed.join(', ')}` });
    }
  }

  // Verify the referenced entity belongs to the caller's workspace and
  // isn't archived. Returns 400 (not 404) because entity_id is user input;
  // the error is "you gave me an invalid value", not "resource missing".
  try {
    const { rows: entityCheck } = await pool.query(
      'SELECT id FROM entities WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL',
      [entityId, workspaceId]
    );
    if (!entityCheck.length) {
      return res.status(400).json({ error: 'entity_id is invalid, archived, or not in your workspace' });
    }

    const { rows } = await pool.query(
      `INSERT INTO offerings (
         workspace_id, entity_id, name, description, floor,
         price_amount, price_frequency, status, metadata
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9::jsonb
       ) RETURNING *`,
      [
        workspaceId,
        entityId,
        name,
        req.body.description || '',
        req.body.floor || '',
        req.body.price_amount ?? 0,
        req.body.price_frequency || 'monthly',
        req.body.status || 'draft',
        JSON.stringify(req.body.metadata || {}),
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/offerings error:', err.message);
    res.status(500).json({ error: 'Failed to create offering' });
  }
});

app.patch('/api/offerings/:id', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

  // Required-if-present: if name is in the body it cannot be empty.
  if (Object.prototype.hasOwnProperty.call(req.body, 'name') &&
      !(req.body.name || '').trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }

  // Enum-like validation for status (app-layer; DB is TEXT no CHECK per §9.11).
  if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
    const allowed = ['draft', 'available', 'unavailable', 'retired'];
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'price_frequency')) {
    const allowed = ['one-time', 'monthly', 'quarterly', 'annual', 'hourly'];
    if (!allowed.includes(req.body.price_frequency)) {
      return res.status(400).json({ error: `price_frequency must be one of: ${allowed.join(', ')}` });
    }
  }

  // If caller is moving the offering to a different entity, verify the
  // new entity belongs to the workspace and isn't archived.
  if (Object.prototype.hasOwnProperty.call(req.body, 'entity_id')) {
    const newEntityId = Number(req.body.entity_id);
    if (!newEntityId || !Number.isInteger(newEntityId)) {
      return res.status(400).json({ error: 'entity_id must be a number' });
    }
    try {
      const { rows: check } = await pool.query(
        'SELECT id FROM entities WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL',
        [newEntityId, workspaceId]
      );
      if (!check.length) {
        return res.status(400).json({ error: 'entity_id is invalid, archived, or not in your workspace' });
      }
    } catch (err) {
      console.error('PATCH /api/offerings/:id entity-check error:', err.message);
      return res.status(500).json({ error: 'Failed to validate entity_id' });
    }
  }

  const scalarFields = ['name', 'description', 'floor', 'entity_id',
                        'price_amount', 'price_frequency', 'status'];
  const jsonbFields = ['metadata'];

  const setParts = [];
  const values = [];
  let i = 1;

  for (const f of scalarFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, f)) {
      setParts.push(`${f} = $${i}`);
      values.push(req.body[f]);
      i++;
    }
  }
  for (const f of jsonbFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, f)) {
      setParts.push(`${f} = $${i}::jsonb`);
      values.push(JSON.stringify(req.body[f]));
      i++;
    }
  }

  if (!setParts.length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  // Always bump updated_at on a real update.
  setParts.push('updated_at = NOW()');

  values.push(Number(req.params.id), workspaceId);

  try {
    const { rows } = await pool.query(
      `UPDATE offerings SET ${setParts.join(', ')}
       WHERE id=$${i} AND workspace_id=$${i + 1}
       RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Offering not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /api/offerings/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update offering' });
  }
});

app.delete('/api/offerings/:id', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
  try {
    // Soft-delete: set status='retired'. Idempotent — on re-delete, status
    // stays 'retired' and updated_at is preserved (the CASE clause keeps
    // the original timestamp if the row was already retired).
    const { rows } = await pool.query(
      `UPDATE offerings
         SET status = 'retired',
             updated_at = CASE WHEN status = 'retired' THEN updated_at ELSE NOW() END
       WHERE id=$1 AND workspace_id=$2
       RETURNING id, status, updated_at`,
      [Number(req.params.id), workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Offering not found' });
    res.json({ id: rows[0].id, status: rows[0].status, updated_at: rows[0].updated_at });
  } catch (err) {
    console.error('DELETE /api/offerings/:id error:', err.message);
    res.status(500).json({ error: 'Failed to retire offering' });
  }
});

// --- Inventory: Engagements (Tenancies in PM vertical) ---
// Workspace-scoped. No DELETE — engagements transition via status only
// (per plan §2.12 / §9.15). Allowed status values: pending, active,
// expired, terminated, renewed. Status transitions enforced on PATCH:
//   pending  → active | renewed
//   active   → terminated | renewed
//   expired  → renewed
//   terminated → renewed
//   renewed  → (terminal, no transitions)
// PATCH with status='renewed' is special: it marks the current engagement
// as renewed AND creates a new 'active' engagement (same contact/offering)
// atomically. Requires renewal_start_date in the body. See chunk 1b spec.

app.get('/api/engagements', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

  const params = [workspaceId];
  let where = 'workspace_id = $1';
  if (req.query.contact_id) {
    params.push(Number(req.query.contact_id));
    where += ` AND contact_id = $${params.length}`;
  }
  if (req.query.offering_id) {
    params.push(Number(req.query.offering_id));
    where += ` AND offering_id = $${params.length}`;
  }
  if (req.query.status) {
    params.push(String(req.query.status));
    where += ` AND status = $${params.length}`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM engagements WHERE ${where} ORDER BY created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/engagements error:', err.message);
    res.status(500).json({ error: 'Failed to list engagements' });
  }
});

app.get('/api/engagements/:id', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM engagements WHERE id=$1 AND workspace_id=$2',
      [Number(req.params.id), workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Engagement not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/engagements/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch engagement' });
  }
});

app.post('/api/engagements', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

  const contactId = Number(req.body.contact_id);
  const offeringId = Number(req.body.offering_id);
  if (!contactId || !Number.isInteger(contactId)) {
    return res.status(400).json({ error: 'contact_id is required and must be a number' });
  }
  if (!offeringId || !Number.isInteger(offeringId)) {
    return res.status(400).json({ error: 'offering_id is required and must be a number' });
  }

  // Optional status validation (defaults to 'pending' in DB if omitted)
  if (req.body.status !== undefined) {
    const allowed = ['pending', 'active', 'expired', 'terminated', 'renewed'];
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
  }

  try {
    // Verify contact belongs to caller's workspace. contacts.user_id is
    // the legacy scoping column; 1:1 with workspace owner post-Phase-1.
    const { rows: contactRows } = await pool.query(
      'SELECT id, monthly_rent FROM contacts WHERE id=$1 AND user_id=$2',
      [contactId, req.session.userId]
    );
    if (!contactRows.length) {
      return res.status(400).json({ error: 'contact_id is invalid or not in your workspace' });
    }
    const contactRent = contactRows[0].monthly_rent;

    // Verify offering belongs to workspace
    const { rows: offeringRows } = await pool.query(
      'SELECT id, price_amount FROM offerings WHERE id=$1 AND workspace_id=$2',
      [offeringId, workspaceId]
    );
    if (!offeringRows.length) {
      return res.status(400).json({ error: 'offering_id is invalid or not in your workspace' });
    }
    const offeringPrice = offeringRows[0].price_amount;

    // Compute current_price fallback:
    //   1. explicit body value (even if 0)
    //   2. contact.monthly_rent if non-null and > 0
    //   3. offering.price_amount
    let currentPrice = req.body.current_price;
    if (currentPrice === undefined || currentPrice === null) {
      const rent = contactRent != null ? Number(contactRent) : 0;
      currentPrice = rent > 0 ? rent : offeringPrice;
    }

    const { rows } = await pool.query(
      `INSERT INTO engagements (
         workspace_id, contact_id, offering_id,
         start_date, end_date, current_price, status, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [
        workspaceId,
        contactId,
        offeringId,
        req.body.start_date || null,
        req.body.end_date || null,
        currentPrice,
        req.body.status || 'pending',
        JSON.stringify(req.body.metadata || {}),
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      // Partial unique violation on (contact_id, offering_id) WHERE status='active'
      return res.status(409).json({
        error: 'contact already has an active engagement with this offering'
      });
    }
    if (err.code === '22007' || err.code === '22008') {
      return res.status(400).json({ error: 'invalid date format for start_date or end_date' });
    }
    console.error('POST /api/engagements error:', err.message);
    res.status(500).json({ error: 'Failed to create engagement' });
  }
});

// Allowed status transitions (state machine)
const ENGAGEMENT_TRANSITIONS = {
  pending:    ['active', 'renewed'],
  active:     ['terminated', 'renewed'],
  expired:    ['renewed'],
  terminated: ['renewed'],
  renewed:    []
};

app.patch('/api/engagements/:id', requireAuth, async (req, res) => {
  const workspaceId = await getWorkspaceId(req);
  if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

  const engId = Number(req.params.id);

  // Fetch current (needed for transition check)
  let current;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM engagements WHERE id=$1 AND workspace_id=$2',
      [engId, workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Engagement not found' });
    current = rows[0];
  } catch (err) {
    console.error('PATCH /api/engagements/:id fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch engagement' });
  }

  const body = req.body;
  const targetStatus = body.status;

  // Status-transition validation (only if status is being changed)
  if (targetStatus !== undefined && targetStatus !== current.status) {
    const allowed = ['pending', 'active', 'expired', 'terminated', 'renewed'];
    if (!allowed.includes(targetStatus)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    const validNext = ENGAGEMENT_TRANSITIONS[current.status] || [];
    if (!validNext.includes(targetStatus)) {
      return res.status(400).json({
        error: `Invalid transition: ${current.status} → ${targetStatus}. Allowed from ${current.status}: ${validNext.join(', ') || '(none; terminal)'}`
      });
    }
  }

  // Renewal path: status='renewed' transitions the current AND creates a
  // new 'active' engagement. Runs in a transaction.
  if (targetStatus === 'renewed') {
    const renewalStart = body.renewal_start_date;
    if (!renewalStart) {
      return res.status(400).json({ error: 'renewal_start_date is required when transitioning to renewed' });
    }
    const renewalEnd = body.renewal_end_date || null;
    let renewalPrice = body.renewal_current_price;

    // Compute renewal price fallback if not provided
    if (renewalPrice === undefined || renewalPrice === null) {
      try {
        const { rows: c } = await pool.query(
          'SELECT monthly_rent FROM contacts WHERE id=$1 AND user_id=$2',
          [current.contact_id, req.session.userId]
        );
        const rent = c[0]?.monthly_rent != null ? Number(c[0].monthly_rent) : 0;
        if (rent > 0) {
          renewalPrice = rent;
        } else {
          const { rows: o } = await pool.query(
            'SELECT price_amount FROM offerings WHERE id=$1 AND workspace_id=$2',
            [current.offering_id, workspaceId]
          );
          renewalPrice = o[0]?.price_amount ?? null;
        }
      } catch (err) {
        console.error('Renewal price-compute error:', err.message);
        return res.status(500).json({ error: 'Failed to compute renewal price' });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Mark the previous engagement as renewed. End-date logic: preserve
      // existing end_date if set; otherwise set to the renewal's start_date
      // (so the old tenancy's effective end aligns with the new one's start).
      const { rows: prev } = await client.query(
        `UPDATE engagements
            SET status = 'renewed',
                end_date = COALESCE(end_date, $1::date),
                updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3
          RETURNING *`,
        [renewalStart, engId, workspaceId]
      );
      // Create the new engagement (status='active'). The partial unique
      // index on (contact_id, offering_id) WHERE status='active' is safe
      // here — the previous row is now 'renewed' so the new 'active' row
      // has no conflict.
      const { rows: next } = await client.query(
        `INSERT INTO engagements (
           workspace_id, contact_id, offering_id,
           start_date, end_date, current_price, status, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', '{}'::jsonb)
         RETURNING *`,
        [workspaceId, current.contact_id, current.offering_id,
         renewalStart, renewalEnd, renewalPrice]
      );
      await client.query('COMMIT');
      res.status(201).json({ previous: prev[0], current: next[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '22007' || err.code === '22008') {
        return res.status(400).json({ error: 'invalid date format for renewal_start_date or renewal_end_date' });
      }
      console.error('Renewal transaction error:', err.message);
      res.status(500).json({ error: 'Failed to process renewal' });
    } finally {
      client.release();
    }
    return;
  }

  // Non-renewal PATCH: update provided fields. Only scalar fields allowed
  // on engagements (plus metadata JSONB). contact_id/offering_id are
  // intentionally NOT patchable — they define the engagement's identity.
  const scalarFields = ['start_date', 'end_date', 'current_price', 'status'];
  const jsonbFields = ['metadata'];

  const setParts = [];
  const values = [];
  let i = 1;

  for (const f of scalarFields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      setParts.push(`${f} = $${i}`);
      values.push(body[f]);
      i++;
    }
  }
  for (const f of jsonbFields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) {
      setParts.push(`${f} = $${i}::jsonb`);
      values.push(JSON.stringify(body[f]));
      i++;
    }
  }

  // Auto-populate end_date = TODAY when transitioning to 'terminated' if
  // the caller didn't provide one.
  if (targetStatus === 'terminated' &&
      !Object.prototype.hasOwnProperty.call(body, 'end_date')) {
    setParts.push(`end_date = $${i}`);
    values.push(new Date().toISOString().slice(0, 10)); // YYYY-MM-DD
    i++;
  }

  if (!setParts.length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  setParts.push('updated_at = NOW()');
  values.push(engId, workspaceId);

  try {
    const { rows } = await pool.query(
      `UPDATE engagements SET ${setParts.join(', ')}
       WHERE id=$${i} AND workspace_id=$${i + 1}
       RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Engagement not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'contact already has an active engagement with this offering'
      });
    }
    if (err.code === '22007' || err.code === '22008') {
      return res.status(400).json({ error: 'invalid date format for start_date or end_date' });
    }
    console.error('PATCH /api/engagements/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update engagement' });
  }
});

// --- Tasks ---
app.get('/api/tasks', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE user_id=$1 AND dismissed_at IS NULL ORDER BY suggested DESC, "dueDate" ASC', [req.session.userId]);
  res.json(rows);
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  const { title, category, dueDate, notes, suggested, aiReason } = req.body;
  // Server-side safety-net defaults so the AI / clients can submit
  // partial input. Mirrors the optional-field defaults declared in the
  // add_task tool schema and applyActions client default.
  const _category = (category && String(category).trim()) || 'other';
  let _dueDate = dueDate;
  if (!_dueDate) {
    const d = new Date(); d.setDate(d.getDate() + 7);
    _dueDate = d.toISOString().split('T')[0];
  }
  const { rows } = await pool.query(
    'INSERT INTO tasks (user_id, title, category, "dueDate", notes, done, suggested, "aiReason") VALUES ($1,$2,$3,$4,$5,false,$6,$7) RETURNING *',
    [req.session.userId, title, _category, _dueDate, notes || '', suggested || false, aiReason || '']
  );
  res.status(201).json(rows[0]);
});

app.put('/api/tasks/:id', requireAuth, async (req, res) => {
  const { done, title, category, dueDate, notes } = req.body;
  const { rows } = await pool.query(
    'UPDATE tasks SET done=$1, title=$2, category=$3, "dueDate"=$4, notes=$5 WHERE id=$6 AND user_id=$7 RETURNING *',
    [done, title, category, dueDate, notes || '', Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  res.json(rows[0]);
});

app.put('/api/tasks/:id/approve', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE tasks SET suggested=false WHERE id=$1 AND user_id=$2 RETURNING *',
    [Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  res.json(rows[0]);
});

app.delete('/api/tasks/:id/reject', requireAuth, async (req, res) => {
  // FD3-CP7: dismissing a SUGGESTED task flags it instead of deleting —
  // the row becomes invisible (every task read filters dismissed_at IS
  // NULL) but remains reflection's dedupe memory, so a dismissed
  // suggestion is NEVER re-suggested. Non-suggested rows keep the old
  // delete semantics.
  const flagged = await pool.query(
    'UPDATE tasks SET dismissed_at = NOW() WHERE id=$1 AND user_id=$2 AND suggested=true RETURNING id',
    [Number(req.params.id), req.session.userId]
  );
  if (!flagged.rows.length) {
    await pool.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  }
  res.json({ success: true });
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
});

// --- Maintenance Tickets ---
const EMERGENCY_KEYWORDS = [
  'gas leak','gas smell','flooding','flood','sewage','raw sewage',
  'fire','smoke','carbon monoxide','no heat','burst pipe','burst pipes',
  'broken window','shattered window','structural','collapse','roof collapse',
  'electrical fire','sparks','no water','water damage','major leak'
];

function isEmergency(text) {
  const lower = (text || '').toLowerCase();
  return EMERGENCY_KEYWORDS.some(k => lower.includes(k));
}

async function sendEmergencySMS(ticket) {
  const phone = process.env.MAINTENANCE_PHONE;
  if (!phone) { console.log('No MAINTENANCE_PHONE set — skipping emergency SMS'); return false; }
  try {
    const msg = `🚨 EMERGENCY MAINTENANCE — ${ticket.unit ? 'Unit ' + ticket.unit + ' · ' : ''}${ticket.title}. ${ticket.description ? ticket.description.slice(0, 100) : ''} Resident: ${ticket.resident || 'Unknown'}. Please respond immediately.`;
    await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: phone, body: msg });
    await pool.query('UPDATE maintenance_tickets SET emergency_sms_sent=true WHERE id=$1', [ticket.id]);
    console.log('Emergency SMS sent for ticket', ticket.id);
    return true;
  } catch (err) {
    console.error('Emergency SMS error:', err.message);
    return false;
  }
}

app.get('/api/maintenance', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM maintenance_tickets WHERE user_id=$1 ORDER BY priority DESC, "createdAt" DESC',
    [req.session.userId]
  );
  res.json(rows);
});

app.post('/api/maintenance', requireAuth, async (req, res) => {
  const { title, description, unit, resident, category } = req.body;
  const priority = isEmergency(title + ' ' + description) ? 'emergency' : 'normal';
  const { rows } = await pool.query(
    `INSERT INTO maintenance_tickets (user_id, title, description, unit, resident, category, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.session.userId, title, description || '', unit || '', resident || '', category || 'general', priority]
  );
  const ticket = rows[0];
  res.status(201).json(ticket);
  if (priority === 'emergency') sendEmergencySMS(ticket);
  suggestTasksFromConversation(
    { id: ticket.id, resident: ticket.resident || 'Unknown', subject: title, text: description || title, category: 'maintenance' },
    null, req.session.userId
  );
});

app.put('/api/maintenance/:id', requireAuth, async (req, res) => {
  const { status, outcome, requires_action, action_notes } = req.body;
  const { rows } = await pool.query(
    `UPDATE maintenance_tickets SET status=$1, outcome=$2, requires_action=$3, action_notes=$4, "updatedAt"=NOW()
     WHERE id=$5 AND user_id=$6 RETURNING *`,
    [status, outcome || '', requires_action || false, action_notes || '', Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Ticket not found' });
  if (status === 'resolved' && requires_action) {
    await pool.query(
      `INSERT INTO tasks (user_id, title, category, "dueDate", notes, done, suggested, "aiReason") VALUES ($1,$2,$3,$4,$5,false,true,$6)`,
      [
        req.session.userId,
        `Office action required: ${rows[0].title}`,
        'maintenance',
        new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0],
        action_notes || `Maintenance resolved ticket for unit ${rows[0].unit}. Office follow-up needed.`,
        'Maintenance marked this ticket as requiring office action (contractor/payment/approval).'
      ]
    );
  }
  res.json(rows[0]);
});

app.delete('/api/maintenance/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM maintenance_tickets WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  res.json({ success: true });
});

// --- Calendar Events ---
app.get('/api/calevents', requireAuth, async (req, res) => {
  // CP5: additive join — appointment status and the linked contact ride
  // along so the calendar can gray canceled bookings and show who is
  // booked. Existing fields unchanged; fetch-everything scoping stays
  // parked as flagged in CP3.
  const { rows } = await pool.query(
    `SELECT ce.*,
            a.status  AS appointment_status,
            a.contact_id,
            c.name    AS contact_name,
            c.phone   AS contact_phone
       FROM cal_events ce
       LEFT JOIN appointments a ON a.id = ce.appointment_id
       LEFT JOIN contacts c ON c.id = a.contact_id AND c.user_id = ce.user_id
      WHERE ce.user_id = $1
      ORDER BY ce.date ASC`,
    [req.session.userId]
  );
  res.json(rows);
});

app.post('/api/calevents', requireAuth, async (req, res) => {
  const { date, title } = req.body;
  const event_type = req.body.event_type || 'general';
  const start_time = req.body.start_time;
  const end_time = req.body.end_time;

  // Whitelist event_type. 'appointment' is deliberately EXCLUDED — those
  // rows are created only by lib/tools/book_appointment.js so the
  // appointment_id / cal_event_id linkage stays consistent.
  const ALLOWED = ['general', 'time_off', 'personal'];
  if (!ALLOWED.includes(event_type)) {
    return res.status(400).json({ error: `event_type must be one of ${ALLOWED.join(', ')}` });
  }

  // Both-or-neither: partial times require both ends.
  if ((start_time && !end_time) || (!start_time && end_time)) {
    return res.status(400).json({ error: 'start_time and end_time must be given together (or both omitted for an all-day event).' });
  }

  // Resolve workspace + timezone. workspace_id is written so new events
  // are workspace-scoped like everything else; user_id is still written
  // for legacy compatibility with pre-E2 delete paths.
  const workspaceId = await getWorkspaceId(req);
  const { wsTz, toZonedISO } = require('./lib/time-helpers');
  let tz = wsTz(null);
  if (workspaceId) {
    const wsRes = await pool.query(`SELECT id, timezone FROM workspaces WHERE id = $1`, [workspaceId]);
    if (wsRes.rows[0]) tz = wsTz(wsRes.rows[0]);
  }

  let starts_at = null;
  let ends_at = null;
  let is_all_day = true;

  if (start_time && end_time) {
    const s = toZonedISO(`${date}T${start_time}:00`, tz);
    const e = toZonedISO(`${date}T${end_time}:00`, tz);
    if (!s || !e) {
      return res.status(400).json({ error: 'Invalid start_time / end_time (expected HH:mm 24-hour, e.g. 14:00).' });
    }
    if (new Date(e).getTime() <= new Date(s).getTime()) {
      return res.status(400).json({ error: 'end_time must be after start_time.' });
    }
    starts_at = s;
    ends_at = e;
    is_all_day = false;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    // All-day fallback: midnight-to-midnight in the workspace tz so the
    // conflict detector sees a proper local-day block.
    starts_at = toZonedISO(`${date}T00:00:00`, tz);
    if (starts_at) {
      ends_at = new Date(new Date(starts_at).getTime() + 24 * 60 * 60 * 1000).toISOString();
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO cal_events
       (user_id, workspace_id, date, title, starts_at, ends_at, is_all_day, event_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [req.session.userId, workspaceId, date, title, starts_at, ends_at, is_all_day, event_type]
  );
  res.status(201).json(rows[0]);
});

// GET /api/calevents/:id — full detail for click-to-view popup. Returns
// {event, appointment|null, contact|null}. Workspace-scoped via the
// event's workspace_id column.
app.get('/api/calevents/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });

    const evR = await pool.query(
      `SELECT id, workspace_id, title, date, starts_at, ends_at, is_all_day,
              event_type, appointment_id
         FROM cal_events
        WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (evR.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    const event = evR.rows[0];

    let appointment = null;
    let contact = null;
    if (event.appointment_id) {
      const apR = await pool.query(
        `SELECT id, status, duration_minutes, quoted_price_cents,
                notes_internal, notes_customer, source, contact_id, cal_event_id
           FROM appointments
          WHERE id = $1 AND workspace_id = $2`,
        [event.appointment_id, workspaceId]
      );
      if (apR.rows.length > 0) {
        appointment = apR.rows[0];
        if (appointment.contact_id) {
          // Contacts is user_id-scoped (legacy). Look up via workspace owner.
          const wsR = await pool.query(
            `SELECT owner_user_id FROM workspaces WHERE id = $1`,
            [workspaceId]
          );
          const ownerId = wsR.rows[0] && wsR.rows[0].owner_user_id;
          if (ownerId) {
            const cR = await pool.query(
              `SELECT id, name, phone, email FROM contacts WHERE id = $1 AND user_id = $2`,
              [appointment.contact_id, ownerId]
            );
            contact = cR.rows[0] || null;
          }
        }
      }
    }

    res.json({ event, appointment, contact });
  } catch (err) {
    console.error('[GET /api/calevents/:id]', err.message);
    res.status(500).json({ error: 'Failed to load event' });
  }
});

// DELETE /api/calevents/:id — smart delete/cancel. If the event has an
// appointment_id, cancel that appointment (mirroring cancel_appointment.js
// verbatim) which sets status='canceled' and deletes the cal_events row.
// If it's a plain event (no appointment_id), hard-delete the cal_events
// row. Workspace-scoped; falls back to legacy user_id-scoped delete when
// the row lacks workspace_id (backward compatibility for pre-E2 rows).
app.delete('/api/calevents/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid event id' });

    // First look up the event scoped to this workspace.
    let event = null;
    if (workspaceId) {
      const r = await pool.query(
        `SELECT id, workspace_id, appointment_id
           FROM cal_events WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId]
      );
      event = r.rows[0] || null;
    }

    // Backward compatibility: legacy events pre-date the workspace_id
    // column and are still keyed off user_id. If workspace lookup missed,
    // try the legacy user_id-scoped delete so the existing calendar UI's
    // delete button keeps working for those rows.
    if (!event) {
      const legacy = await pool.query(
        `DELETE FROM cal_events WHERE id = $1 AND user_id = $2`,
        [id, req.session.userId]
      );
      if (!legacy.rowCount) return res.status(404).json({ error: 'Event not found' });
      return res.json({ success: true, deleted: true });
    }

    if (event.appointment_id) {
      // Cancel the appointment — mirrors lib/tools/cancel_appointment.js
      // exactly (same status token 'canceled', same three timestamps, same
      // cal_events cleanup so the slot re-opens).
      const wsR = await pool.query(
        `SELECT id, cal_event_id, status FROM appointments
          WHERE id = $1 AND workspace_id = $2`,
        [event.appointment_id, workspaceId]
      );
      const appt = wsR.rows[0];
      if (!appt) {
        // Orphan cal_events row pointing at a missing appointment — just
        // hard-delete the calendar row.
        await pool.query(`DELETE FROM cal_events WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
        return res.json({ success: true, deleted: true });
      }
      if (appt.status === 'canceled') {
        // CP5: already canceled — the cal_events row now STAYS so the
        // calendar renders it grayed instead of vanishing.
        return res.json({ success: true, cancelled: true, alreadyCancelled: true });
      }
      await pool.query(
        `UPDATE appointments
            SET status = 'canceled',
                canceled_at = NOW(),
                canceled_by = $1,
                canceled_reason = $2,
                updated_at = NOW()
          WHERE id = $3 AND workspace_id = $4`,
        ['staff', null, event.appointment_id, workspaceId]
      );
      // CP5: status-based cancel — the cal_events row survives so the
      // booking renders grayed/struck-through. Availability is freed by
      // the canceled-exclusion in propose_appointment_times and the
      // engine's calendar loader, not by deleting the row.
      return res.json({ success: true, cancelled: true });
    }

    // Plain event / block-off — hard delete the cal_events row.
    await pool.query(
      `DELETE FROM cal_events WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('[DELETE /api/calevents/:id]', err.message);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// PATCH /api/appointments/:id — user-driven appointment edit. Mirrors
// lib/tools/update_appointment.js exactly so user + AI edits behave
// identically: same editable field set, same duration bounds (5-720),
// same ends_at recompute, same cal_events sync (starts_at + ends_at +
// title + legacy date TEXT column). starts_at flows through toZonedISO
// so naive strings from the client are interpreted as workspace wall-
// clock (belt-and-suspenders alongside the frontend's date+time inputs).
app.patch('/api/appointments/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid appointment id' });

    // Pre-check workspace scope so a cross-workspace id returns 404 rather
    // than a silent 200 with zero rows updated.
    const found = await pool.query(
      `SELECT * FROM appointments WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    const current = found.rows[0];

    // Load the workspace's timezone (nullable → America/New_York default
    // via wsTz). Same time-helpers module the AI booking tools use.
    const wsR = await pool.query(
      `SELECT id, timezone FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    const workspace = wsR.rows[0] || { id: workspaceId };
    const { wsTz, toZonedISO } = require('./lib/time-helpers');

    const body = req.body || {};
    const updates = {};

    // Simple pass-through fields (identical to update_appointment tool).
    if (Object.prototype.hasOwnProperty.call(body, 'title'))          updates.title          = body.title;
    if (Object.prototype.hasOwnProperty.call(body, 'notes_internal')) updates.notes_internal = body.notes_internal;
    if (Object.prototype.hasOwnProperty.call(body, 'notes_customer')) updates.notes_customer = body.notes_customer;
    if (Object.prototype.hasOwnProperty.call(body, 'quoted_price_cents')) {
      const qpc = parseInt(body.quoted_price_cents, 10);
      if (!Number.isFinite(qpc) || qpc < 0) {
        return res.status(400).json({ error: 'quoted_price_cents must be a non-negative integer' });
      }
      updates.quoted_price_cents = qpc;
    }

    // starts_at / duration_minutes / ends_at — mirror the tool's recompute.
    let newStartsAt = current.starts_at;
    let newDuration = current.duration_minutes;

    if (Object.prototype.hasOwnProperty.call(body, 'starts_at')) {
      const startIso = toZonedISO(body.starts_at, wsTz(workspace));
      if (!startIso) return res.status(400).json({ error: 'Invalid start time' });
      newStartsAt = startIso;
      updates.starts_at = newStartsAt;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'duration_minutes')) {
      const dur = parseInt(body.duration_minutes, 10);
      if (!Number.isFinite(dur) || dur < 5 || dur > 720) {
        return res.status(400).json({ error: 'duration_minutes must be between 5 and 720' });
      }
      newDuration = dur;
      updates.duration_minutes = newDuration;
    }
    if (updates.starts_at !== undefined || updates.duration_minutes !== undefined) {
      updates.ends_at = new Date(new Date(newStartsAt).getTime() + newDuration * 60 * 1000).toISOString();
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Dynamic UPDATE — matches the tool's shape byte-for-byte.
    const setClauses = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(updates)) {
      setClauses.push(`${k} = $${i++}`);
      values.push(v);
    }
    setClauses.push('updated_at = NOW()');
    values.push(id, workspaceId);

    await pool.query(
      `UPDATE appointments SET ${setClauses.join(', ')}
        WHERE id = $${i++} AND workspace_id = $${i}`,
      values
    );

    // Sync the linked cal_events row — same COALESCE + legacy date TEXT
    // update the tool does. Only fires when there's a linked row AND
    // something on the cal_events surface changed.
    if (current.cal_event_id && (updates.starts_at || updates.ends_at || updates.title)) {
      try {
        await pool.query(
          `UPDATE cal_events
              SET starts_at = COALESCE($1, starts_at),
                  ends_at   = COALESCE($2, ends_at),
                  title     = COALESCE($3, title),
                  date      = COALESCE($4, date)
            WHERE id = $5`,
          [updates.starts_at || null,
           updates.ends_at || null,
           updates.title || null,
           updates.starts_at ? new Date(updates.starts_at).toISOString().slice(0, 10) : null,
           current.cal_event_id]
        );
      } catch (syncErr) {
        console.error('[PATCH /api/appointments/:id] cal_event sync failed (appointment updated):', syncErr.message);
      }
    }

    // Return the fresh row so the frontend can re-sync from source of truth.
    const after = await pool.query(
      `SELECT * FROM appointments WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    res.json({ appointment: after.rows[0] });
  } catch (err) {
    console.error('[PATCH /api/appointments/:id]', err.message);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});

// --- Budget ---
app.get('/api/budget', requireAuth, async (req, res) => {
  const { month, year } = req.query;
  let q = 'SELECT * FROM budget_transactions WHERE user_id=$1';
  const params = [req.session.userId];
  if (month && year) {
    q += ` AND date LIKE $2`;
    params.push(`${year}-${String(month).padStart(2,'0')}%`);
  }
  q += ' ORDER BY date ASC, "createdAt" ASC';
  const { rows } = await pool.query(q, params);
  res.json(rows);
});

app.post('/api/budget', requireAuth, async (req, res) => {
  const { type, category, description, amount, date, notes } = req.body;
  // Server-side safety-net defaults so the AI / clients can submit
  // partial input. Mirrors the optional-field defaults declared in the
  // add_budget_transaction tool schema and applyActions client default.
  const _category = (category && String(category).trim()) || 'Other';
  const _date = (date && String(date).trim()) || new Date().toISOString().split('T')[0];
  const { rows } = await pool.query(
    'INSERT INTO budget_transactions (user_id, type, category, description, amount, date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.session.userId, type, _category, description || '', Number(amount), _date, notes || '']
  );
  res.status(201).json(rows[0]);
});

app.delete('/api/budget/:id', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM budget_transactions WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ success: true });
});

// --- Automation ---
app.get('/api/automation', requireAuth, async (req, res) => {
  const automationData = await getAutomation(req.session.userId);
  res.json(automationData);
});

// Sub-step D (Layer 3): PUT /api/automation now enforces the consent
// flow. Enabling auto-reply (FALSE -> TRUE) is rejected here — clients
// must use POST /api/automation/consent so the consent grant gets
// recorded in audit_log. Disabling (TRUE -> FALSE) writes a revocation
// event to audit_log and proceeds. No-op writes pass through silently.
app.put('/api/automation', requireAuth, async (req, res) => {
  const desired = !!req.body.autoReplyEnabled;
  const current = await getAutomation(req.session.userId);
  const currentValue = !!current.autoReplyEnabled;

  if (currentValue === desired) {
    return res.json({ autoReplyEnabled: desired, managerReviewRequired: !desired });
  }

  if (desired === true) {
    return res.status(400).json({
      error: 'Use POST /api/automation/consent to enable auto-reply (consent required).'
    });
  }

  // currentValue === true && desired === false — revocation path.
  // Write the audit-log entry first; if it fails we don't flip the
  // bool (keeps the audit trail authoritative — never a state change
  // without a corresponding event log).
  try {
    await pool.query(
      'INSERT INTO audit_log (user_id, event_type, details, ip) VALUES ($1, $2, $3::jsonb, $4)',
      [req.session.userId, 'auto_reply_consent_revoked', '{}', req.ip || null]
    );
  } catch (err) {
    console.error('[consent] revocation audit-log write failed:', err.message);
    return res.status(500).json({ error: 'Failed to record revocation' });
  }

  await pool.query(
    'INSERT INTO automation (user_id, "autoReplyEnabled") VALUES ($1, FALSE) ON CONFLICT (user_id) DO UPDATE SET "autoReplyEnabled" = FALSE',
    [req.session.userId]
  );
  res.json({ autoReplyEnabled: false, managerReviewRequired: true });
});

// Sub-step D (Layer 3): explicit consent path for enabling auto-reply.
// Frontend sends this only after the consent modal's checkbox has been
// checked and the Enable Auto-Reply button clicked. Audit-log entry is
// written before the automation flip, so we never have an "enabled"
// state without a corresponding granted-consent record.
app.post('/api/automation/consent', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO audit_log (user_id, event_type, details, ip) VALUES ($1, $2, $3::jsonb, $4)',
      [req.session.userId, 'auto_reply_consent_granted', '{}', req.ip || null]
    );
  } catch (err) {
    console.error('[consent] grant audit-log write failed:', err.message);
    return res.status(500).json({ error: 'Failed to record consent' });
  }
  try {
    await pool.query(
      'INSERT INTO automation (user_id, "autoReplyEnabled") VALUES ($1, TRUE) ON CONFLICT (user_id) DO UPDATE SET "autoReplyEnabled" = TRUE',
      [req.session.userId]
    );
  } catch (err) {
    console.error('[consent] automation update failed:', err.message);
    return res.status(500).json({ error: 'Failed to enable auto-reply' });
  }
  res.json({ autoReplyEnabled: true, managerReviewRequired: false });
});

// --- Messages ---
app.get('/api/messages', requireAuth, async (req, res) => {
  const folder = req.query.folder || 'inbox';
  // Inbox pins emergency-flagged rows to the top until the owner
  // marks them reviewed (sub-step C). Other folders keep the legacy
  // chronological-only sort.
  const orderBy = folder === 'inbox'
    ? 'emergency_flagged DESC, "createdAt" DESC'
    : '"createdAt" DESC';
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE user_id=$1 AND folder=$2 ORDER BY ${orderBy}`,
    [req.session.userId, folder]
  );
  res.json(rows);
});

// ============================================================
// IB3 — conversations. The grouping key (look-first b):
//   't' + thread_id   where the row is threaded (the conversation)
//   'c' + contact_id  for threadless-but-linked rows (voice/email
//                     notices, PM mail) — one bucket per customer
//   'm' + id          for fully unlinked rows (each its own)
// One fetch per folder, grouped here (message volume is per-owner
// small; the rows are already indexed by user). The legacy
// /api/messages endpoints stay untouched for their other readers.
// ============================================================
function conversationKeyOf(m) {
  if (m.thread_id) return 't' + m.thread_id;
  if (m.contact_id) return 'c' + m.contact_id;
  return 'm' + m.id;
}
const CONVO_KEY_RE = /^[tcm]\d+$/;

app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const folder = req.query.folder || 'inbox';
    const { rows } = await pool.query(
      `SELECT m.id, m.thread_id, m.contact_id, m.direction, m.sent_by, m.category,
              m.subject, m.text, m.phone, m.email, m.resident, m.read_at,
              m.emergency_flagged, m."createdAt",
              c.name AS contact_name
         FROM messages m
         LEFT JOIN contacts c ON c.id = m.contact_id AND c.user_id = m.user_id
        WHERE m.user_id = $1 AND m.folder = $2
        ORDER BY m."createdAt" DESC
        LIMIT 500`,
      [req.session.userId, folder]
    );
    const groups = new Map();
    for (const m of rows) {
      const key = conversationKeyOf(m);
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          name: m.contact_name || m.resident || m.phone || m.email || 'Unknown',
          identity: m.phone || m.email || null,
          last_at: m.createdAt,
          last_preview: (m.text || m.subject || '').slice(0, 120),
          last_channel: m.category,
          last_sent_by: m.sent_by,
          unread: 0,
          flagged: false,
          count: 0,
        };
        groups.set(key, g);
      }
      g.count++;
      if (m.direction === 'inbound' && !m.read_at) g.unread++;
      if (m.emergency_flagged) g.flagged = true;
      // rows arrive newest-first; a later row is OLDER — but identity
      // fields may only exist on older rows, so fill blanks as we go.
      if (!g.identity) g.identity = m.phone || m.email || null;
      if (g.name === 'Unknown') g.name = m.contact_name || m.resident || m.phone || m.email || 'Unknown';
    }
    const conversations = [...groups.values()].sort((a, b) => {
      if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
      return new Date(b.last_at) - new Date(a.last_at);
    });
    res.json({ conversations });
  } catch (err) {
    console.error('[GET /api/conversations]', err.message);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

app.get('/api/conversations/:key/messages', requireAuth, async (req, res) => {
  try {
    const key = String(req.params.key || '');
    if (!CONVO_KEY_RE.test(key)) return res.status(400).json({ error: 'Bad conversation key' });
    const kind = key[0];
    const id = parseInt(key.slice(1), 10);
    const where = kind === 't' ? 'm.thread_id = $2'
      : kind === 'c' ? 'm.contact_id = $2 AND m.thread_id IS NULL'
      : 'm.id = $2';
    const { rows } = await pool.query(
      `SELECT m.id, m.thread_id, m.contact_id, m.direction, m.sent_by, m.category,
              m.subject, m.text, m.phone, m.email, m.resident, m.read_at,
              m.emergency_flagged, m."createdAt",
              c.name AS contact_name
         FROM messages m
         LEFT JOIN contacts c ON c.id = m.contact_id AND c.user_id = m.user_id
        WHERE m.user_id = $1 AND ${where} AND m.folder <> 'deleted'
        ORDER BY m."createdAt" ASC
        LIMIT 300`,
      [req.session.userId, id]
    );
    // IB2 path, group-shaped: seeing the conversation marks it.
    await readState.markGroupRead({ db: pool, userId: req.session.userId, key });
    // Conversation meta: identity + whether the AI is responding
    // (workspace-global truth today; per-thread driver is IB4).
    let meta = { name: null, phone: null, email: null, thread_id: null, ai_responding: false };
    for (const m of rows) {
      if (!meta.name) meta.name = m.contact_name || m.resident || null;
      if (!meta.phone) meta.phone = m.phone || null;
      if (!meta.email) meta.email = m.email || null;
      if (!meta.thread_id) meta.thread_id = m.thread_id || null;
    }
    try {
      const wR = await pool.query(
        'SELECT vertical, appointment_auto_respond FROM workspaces WHERE owner_user_id = $1 LIMIT 1',
        [req.session.userId]
      );
      const ws = wR.rows[0];
      meta.ai_responding = !!(ws && ws.vertical === 'professional-services' && ws.appointment_auto_respond);
    } catch (err) { /* meta stays false */ }
    res.json({ messages: rows, meta });
  } catch (err) {
    console.error('[GET /api/conversations/:key/messages]', err.message);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

// Folder moves + permanent delete operate on the whole group —
// "folders preserved in meaning, now filtering conversations".
app.put('/api/conversations/:key/folder', requireAuth, async (req, res) => {
  try {
    const key = String(req.params.key || '');
    const folder = req.body && req.body.folder;
    if (!CONVO_KEY_RE.test(key)) return res.status(400).json({ error: 'Bad conversation key' });
    if (!['inbox', 'archive', 'deleted'].includes(folder)) return res.status(400).json({ error: 'Bad folder' });
    const kind = key[0];
    const id = parseInt(key.slice(1), 10);
    const where = kind === 't' ? 'thread_id = $3'
      : kind === 'c' ? 'contact_id = $3 AND thread_id IS NULL'
      : 'id = $3';
    const r = await pool.query(
      `UPDATE messages SET folder = $1 WHERE user_id = $2 AND ${where}`,
      [folder, req.session.userId, id]
    );
    res.json({ success: true, moved: r.rowCount });
  } catch (err) {
    console.error('[PUT /api/conversations/:key/folder]', err.message);
    res.status(500).json({ error: 'Failed to move conversation' });
  }
});

app.delete('/api/conversations/:key', requireAuth, async (req, res) => {
  try {
    const key = String(req.params.key || '');
    if (!CONVO_KEY_RE.test(key)) return res.status(400).json({ error: 'Bad conversation key' });
    const kind = key[0];
    const id = parseInt(key.slice(1), 10);
    const where = kind === 't' ? 'thread_id = $2'
      : kind === 'c' ? 'contact_id = $2 AND thread_id IS NULL'
      : 'id = $2';
    // Permanent delete only ever offered from the Deleted folder in the
    // UI; the guard here makes the endpoint honest regardless.
    const r = await pool.query(
      `DELETE FROM messages WHERE user_id = $1 AND ${where} AND folder = 'deleted'`,
      [req.session.userId, id]
    );
    res.json({ success: true, deleted: r.rowCount });
  } catch (err) {
    console.error('[DELETE /api/conversations/:key]', err.message);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

// IB2: the truth the badges render — conversations containing unread
// (Gmail's arithmetic), one indexed query.
app.get('/api/messages/unread-count', requireAuth, async (req, res) => {
  const n = await readState.unreadConversationCount({ db: pool, userId: req.session.userId });
  res.json({ unread_conversations: n });
});

app.get('/api/messages/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM messages WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  const msg = rows[0];
  // IB2: the act of seeing IS the marking — server-side, on this
  // fetch. Opening a threaded message marks the whole conversation's
  // inbound rows; threadless rows (incl. voice transcripts) mark
  // themselves. Best-effort; the message is served either way.
  const marked = await readState.markReadOnFetch({ db: pool, userId: req.session.userId, message: msg });
  if (marked > 0) msg.read_at = new Date().toISOString();
  // Sub-step C: lazily compute matched keywords for the detail-view
  // banner. Single source of truth on the server (no JS duplication of
  // the keyword list). Graceful fallback if the keyword list has
  // changed since flagging — the recompute may be empty even though
  // emergency_flagged is true; the frontend handles that case.
  if (msg.emergency_flagged) {
    msg.emergency_keywords = detectEmergency(msg.text);
  }
  res.json(msg);
});

// Sub-step C: clear the emergency flag on a message after the owner
// has manually reviewed it. Single-purpose endpoint — does not change
// folder, status, or any other field. Uses requireAuth (safer than
// the legacy /api/messages/* routes that scope by req.session.userId
// directly; retrofitting the others is a separate cleanup task).
app.post('/api/messages/:id/clear-emergency', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE messages
        SET emergency_flagged = FALSE
      WHERE id = $1 AND user_id = $2
      RETURNING *`,
    [Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json(rows[0]);
});

app.post('/api/messages', requireAuth, async (req, res) => {
  const { resident, subject, category, text } = req.body;
  // Server-side safety-net default: derive a subject from the body if
  // the caller (e.g. the AI compose_message tool) omitted it.
  let _subject = (subject && String(subject).trim()) || '';
  if (!_subject && text) {
    const oneLine = String(text).replace(/\s+/g, ' ').trim();
    if (oneLine.length <= 50) _subject = oneLine;
    else {
      const cut = oneLine.slice(0, 50);
      const lastSpace = cut.lastIndexOf(' ');
      _subject = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '...';
    }
  }
  const { rows } = await pool.query(
    'INSERT INTO messages (user_id, resident, subject, category, text, status, folder, direction, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [req.session.userId, resident, _subject || '(no subject)', category, text, 'new', 'inbox', 'inbound', 'customer']
  );
  res.status(201).json(rows[0]);
});

app.put('/api/messages/:id/folder', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE messages SET folder=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
    [req.body.folder, Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json(rows[0]);
});

app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM messages WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Message not found' });
  res.json({ success: true });
});

app.delete('/api/messages/folder/deleted', requireAuth, async (req, res) => {
  await pool.query("DELETE FROM messages WHERE folder='deleted' AND user_id=$1", [req.session.userId]);
  res.json({ success: true });
});

app.put('/api/messages/:id/status', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE messages SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
    [req.body.status, Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json(rows[0]);
});

// --- Drafts (DB-backed, user-scoped) ---
app.get('/api/drafts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM drafts WHERE user_id=$1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drafts', requireAuth, async (req, res) => {
  try {
    const { messageId, content, status } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO drafts (user_id, message_id, content, status) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.session.userId, messageId || null, content || '', status || 'draft']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/drafts/:id', requireAuth, async (req, res) => {
  try {
    const { content, status } = req.body;
    const { rows } = await pool.query(
      'UPDATE drafts SET content=COALESCE($1,content), status=COALESCE($2,status) WHERE id=$3 AND user_id=$4 RETURNING *',
      [content, status, Number(req.params.id), req.session.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Draft not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/drafts/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM drafts WHERE id=$1 AND user_id=$2',
      [Number(req.params.id), req.session.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Draft not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Knowledge base (DB-backed, per-user) ---
// Helper: fetch knowledge docs for a user (used by AI endpoints)
async function getKnowledge(userId) {
  try {
    const { rows } = await pool.query(
      'SELECT id, title, type, content FROM knowledge WHERE user_id=$1 ORDER BY id ASC',
      [userId]
    );
    return rows;
  } catch (err) {
    console.error('getKnowledge error:', err.message);
    return [];
  }
}

// Format knowledge docs into a context block for AI prompts
function formatKnowledgeContext(docs) {
  if (!docs || !docs.length) return 'No company policies or procedures have been uploaded yet.';
  return docs.map(d => `## ${d.title} (${d.type})\n${d.content}`).join('\n\n');
}

// Ensure knowledge table exists before any query — defensive in case initDB is mid-retry
async function ensureKnowledgeTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'policy',
      content TEXT DEFAULT '',
      "createdAt" TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

app.get('/api/knowledge', requireAuth, async (req, res) => {
  try {
    await ensureKnowledgeTable();
    const rows = await getKnowledge(req.session.userId);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to load knowledge base', details: err.message });
  }
});

app.post('/api/knowledge', requireAuth, async (req, res) => {
  try {
    await ensureKnowledgeTable();
    const { title, type, content } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const { rows } = await pool.query(
      'INSERT INTO knowledge (user_id, title, type, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.session.userId, title, type || 'policy', content || '']
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /api/knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to save knowledge doc', details: err.message });
  }
});

app.put('/api/knowledge/:id', requireAuth, async (req, res) => {
  try {
    const { title, type, content } = req.body;
    const { rows } = await pool.query(
      'UPDATE knowledge SET title=$1, type=$2, content=$3 WHERE id=$4 AND user_id=$5 RETURNING *',
      [title, type, content, Number(req.params.id), req.session.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Knowledge doc not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to update knowledge doc', details: err.message });
  }
});

app.delete('/api/knowledge/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM knowledge WHERE id=$1 AND user_id=$2',
      [Number(req.params.id), req.session.userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Knowledge doc not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/knowledge error:', err.message);
    res.status(500).json({ error: 'Failed to delete knowledge doc', details: err.message });
  }
});

app.post('/api/knowledge/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    await ensureKnowledgeTable();
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filename = req.file.originalname;
    const ext = path.extname(filename).toLowerCase();
    let content = '';
    if (ext === '.pdf') {
      const parsed = await pdfParse(req.file.buffer);
      content = (parsed.text || '').trim();
      if (!content) return res.status(400).json({ error: 'Could not extract any text from this PDF. It may be scanned/image-based.' });
    } else if (ext === '.txt') {
      content = req.file.buffer.toString('utf-8').trim();
    } else {
      return res.status(400).json({ error: 'Only PDF and TXT files are supported' });
    }
    const title = path.basename(filename, ext);
    const { rows } = await pool.query(
      'INSERT INTO knowledge (user_id, title, type, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.session.userId, title, 'uploaded', content]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('File parse error:', err.message);
    res.status(500).json({ error: 'Failed to read file', details: err.message });
  }
});

// --- AI: Generate draft reply ---
app.post('/api/generate', requireAuth, async (req, res) => {
  const { messageId, contacts } = req.body;
  const { rows } = await pool.query('SELECT * FROM messages WHERE id=$1 AND user_id=$2', [Number(messageId), req.session.userId]);
  const message = rows[0];
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const knowledgeDocs = await getKnowledge(req.session.userId);
  const knowledgeContext = formatKnowledgeContext(knowledgeDocs);

  const contactContext = contacts && contacts.length
    ? '\n\n## Contact Directory\n' + contacts.map(c =>
        `- ${c.name} (${c.type})${c.unit ? `, Unit ${c.unit}` : ''}${c.email ? `, Email: ${c.email}` : ''}${c.phone ? `, Phone: ${c.phone}` : ''}${c.notes ? `. Notes: ${c.notes}` : ''}`
      ).join('\n')
    : '';

  try {
    const response = await anthropic.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: `You are a professional property management assistant. Draft concise, friendly, and helpful responses to resident messages on behalf of the property management team.

Use the following company policies, procedures, and contact directory to inform your response:

${knowledgeContext}${contactContext}

Guidelines:
- Address the resident by first name
- Be warm but professional
- Reference relevant policies where appropriate, but don't quote them verbatim
- Keep responses to 3-5 short paragraphs
- End with "Best regards,\\nThe Property Management Team"`,
      messages: [{
        role: 'user',
        content: `Please draft a response to this resident message:\n\nFrom: ${message.resident}\nSubject: ${message.subject}\nCategory: ${message.category}\n\nMessage:\n${message.text}`
      }]
    });

    const draft = response.content.find(b => b.type === 'text')?.text || '';
    const draftEntry = { id: drafts.length ? Math.max(...drafts.map(d => d.id)) + 1 : 1, messageId, content: draft, status: 'generated', createdAt: new Date().toISOString() };
    drafts.push(draftEntry);
    res.json(draftEntry);
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(500).json({ error: 'Failed to generate draft', details: err.message });
  }
});

// --- AI: Command center ---
const registry = require('./lib/tool-registry');

// Session C1: shared helper to build the executor `ctx` for any code
// path that needs to run a registered tool (currently /api/command and
// the approval-queue approve endpoint). Mirrors the ctx shape from B4.
async function buildExecutorContext(req) {
  const workspaceId = await getWorkspaceId(req);
  let workspaceRow = { id: workspaceId, vertical: 'property-management' };
  if (workspaceId) {
    try {
      const wRes = await pool.query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
      if (wRes.rows[0]) workspaceRow = wRes.rows[0];
    } catch (e) { /* fall through with default */ }
  }
  return {
    workspace: workspaceRow,
    user: { id: req.session.userId },
    db: pool,
    logger: console,
    mailer: sgMail,
    sms: twilioClient,
    stripe: stripeSignup,      // E14 Stage 2: test-mode Stripe client for payment-request tools
    env: process.env,
    generateReportContent,
  };
}

// Session C1: human-readable description of a pending action for the
// approval queue UI and the inline chip in the AI response.
function buildPendingActionSummary(toolName, input) {
  switch (toolName) {
    case 'compose_message':
      return `Compose ${input.channel || 'message'} to ${input.to || 'recipient'}: "${_c1Truncate(input.body || input.subject || '', 80)}"`;
    case 'send_late_notice':
      return `Send late notice to ${input.resident || 'tenant'}${input.unit ? ` (unit ${input.unit})` : ''}`;
    // Session C3: outbound communication tools
    case 'send_sms':
      return `Send SMS to ${input.to || 'recipient'}: "${_c1Truncate(input.body || '', 80)}"`;
    case 'send_email':
      return `Send email to ${input.to || 'recipient'} — "${_c1Truncate(input.subject || '', 60)}"`;
    case 'send_broadcast': {
      const aud = input.audience || 'all residents';
      const ch = (input.channel || 'message').toUpperCase();
      const subj = input.subject ? ` — "${_c1Truncate(input.subject, 50)}"` : '';
      return `Send ${ch} broadcast to ${aud}${subj}: "${_c1Truncate(input.body || '', 60)}"`;
    }
    case 'reply_to_message':
      return `Reply to ${input.message_reference || 'message'}: "${_c1Truncate(input.body || '', 80)}"`;
    // E14 Stage 2: AI-proposed batch of customer payment requests. The
    // input.requests array carries the AI's proposal verbatim; this chip
    // renders enough of it for the owner to recognize what they're
    // approving. `amount_cents` is optional in the schema, so omitted ones
    // render as "full balance" — the tool resolves them at approval time.
    case 'request_payments_batch': {
      const list = Array.isArray(input && input.requests) ? input.requests : [];
      if (list.length === 0) return 'Send payment requests (empty batch)';
      const preview = list.map(e => {
        const name = (e && e.customer_name) || `#${e && e.transaction_id}`;
        const idTag = (e && e.transaction_id != null) ? ` #${e.transaction_id}` : '';
        const amount = (e && e.amount_cents != null && Number(e.amount_cents) > 0)
          ? ' $' + (Number(e.amount_cents) / 100).toFixed(2)
          : ' full balance';
        return `${name}${idTag}${amount}`;
      }).join(', ');
      return `Send payment requests to ${list.length} customer${list.length === 1 ? '' : 's'}: ${_c1Truncate(preview, 120)}`;
    }
    default:
      return `${toolName}: ${_c1Truncate(JSON.stringify(input), 80)}`;
  }
}

function _c1Truncate(str, max) {
  const s = String(str || '');
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// Session B5: server picks one navigation target from a multi-tool batch.
//   - Iterates executionResults in order; last eligible success wins (last-wins).
//   - 'auto' policy fires from any page; 'home_only' only fires when the user
//     was on the home page; 'never' tools are skipped entirely.
//   - resolveNavigateTo replaces any focus value of the form '$field' with
//     result.data[field], so tool-specific fields (date, id, etc.) are
//     baked in at response time. Static values pass through unchanged.
function resolveNavigateTo(template, result) {
  if (!template || !template.page) return null;
  const focusTemplate = template.focus || {};
  const resolvedFocus = {};
  for (const [key, val] of Object.entries(focusTemplate)) {
    if (typeof val === 'string' && val.startsWith('$')) {
      const fieldName = val.slice(1);
      const data = result && result.data ? result.data : {};
      resolvedFocus[key] = data[fieldName];
    } else {
      resolvedFocus[key] = val;
    }
  }
  return { page: template.page, focus: resolvedFocus };
}

function selectNavigation(executionResults, currentPage, registry) {
  let chosen = null;
  for (const entry of executionResults) {
    if (!entry || !entry.result || entry.result.success !== true) continue;
    const action = entry.action;
    // Post-refactor action shape: { toolName, toolUseId, input }.
    if (!action || !action.toolName) continue;
    const tool = registry.getTool(action.toolName);
    if (!tool) continue;
    const policy = tool.navigationPolicy;
    if (!policy || policy === 'never') continue;
    if (policy === 'home_only' && currentPage !== 'home') continue;
    if (policy !== 'auto' && policy !== 'home_only') continue;
    if (!tool.navigateTo) continue;
    chosen = resolveNavigateTo(tool.navigateTo, entry.result);
  }
  return chosen;
}

// Session E9: load persistent Command Center chat history for the current
// user+workspace. Returns oldest-first so the frontend can append in order
// and render the chat bubble timeline directly. is_first_time=true tells
// the UI to render the welcome state + quick-prompts instead of history.
app.get('/api/command-history', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.json({ history: [], is_first_time: true });
    const userId = req.session.userId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    // AP2: replay the MOST RECENT rows (the old ASC LIMIT returned the
    // oldest 50, so past the cap the replay showed ancient history and
    // dropped the live conversation). One extra row is fetched purely
    // to detect capping.
    const r = await pool.query(
      `SELECT id, role, content, tool_calls_summary, created_at
         FROM command_history
        WHERE workspace_id = $1 AND user_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [workspaceId, userId, limit + 1]
    );
    const capped = r.rows.length > limit;
    const rows = (capped ? r.rows.slice(0, limit) : r.rows).reverse();

    res.json({
      history: rows,
      is_first_time: rows.length === 0,
      capped,
    });
  } catch (err) {
    console.error('[command-history] fetch error:', err.message);
    res.status(500).json({ error: 'Could not load command history' });
  }
});

app.post('/api/command', requireAuth, async (req, res) => {
  const { prompt, contacts, calEvents, tasks, messages: msgList, rentRecords, maintenanceTickets, properties, units, currentPage } = req.body;

  // Session B2: load the workspace row so we can resolve the
  // workspace.vertical column (added in migration 026). Defensive
  // SELECT * — if the column doesn't exist yet (migration not run),
  // `vertical` is undefined and we fall back to 'property-management'
  // below. The userId is what legacy ctx executors actually scope by.
  const workspaceId = await getWorkspaceId(req);
  let _workspaceRow = { id: workspaceId, vertical: 'property-management' };
  if (workspaceId) {
    try {
      const wRes = await pool.query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
      if (wRes.rows[0]) _workspaceRow = wRes.rows[0];
    } catch (e) { /* fall through with default */ }
  }

  // Session D4: enforcement gates (subscription status + daily AI quota).
  // Run BEFORE any Anthropic call so blocked requests don't burn tokens.
  // The _workspaceRow already contains plan + subscription_status from the
  // SELECT * above; reuse it as planInfo (avoids a redundant lookup).
  const planInfo = _workspaceRow && _workspaceRow.id ? _workspaceRow : null;
  const statusCheck = planEnforcement.checkSubscriptionStatus(planInfo);
  if (!statusCheck.allowed) {
    return res.status(403).json({
      error: statusCheck.reason,
      message: statusCheck.suggestion,
    });
  }
  const quotaCheck = await planEnforcement.checkAICommandQuota(pool, planInfo, req.session.userId);
  if (!quotaCheck.allowed) {
    return res.status(429).json({
      error: quotaCheck.reason,
      message: quotaCheck.suggestion,
      count: quotaCheck.count,
      limit: quotaCheck.limit,
    });
  }

  // AP2: conversation memory. The last ~10 exchanges become prior turns
  // in the model call. Fetched BEFORE the current prompt is persisted so
  // this turn is never duplicated. Budgets (hard bounds): 20 rows max,
  // 600 chars per message (+120 for a tool summary), 6000 chars total —
  // oldest dropped first when the total budget is exceeded. Anthropic
  // requires user-first strict alternation, so consecutive same-role
  // rows are merged and leading assistant rows dropped.
  const historyMessages = [];
  if (workspaceId) {
    try {
      const hist = await pool.query(
        `SELECT role, content, tool_calls_summary FROM command_history
          WHERE workspace_id = $1 AND user_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 20`,
        [workspaceId, req.session.userId]
      );
      const rows = hist.rows.reverse(); // chronological
      const MAX_MSG = 600;
      const MAX_TOTAL = 6000;
      const built = [];
      let total = 0;
      for (let i = rows.length - 1; i >= 0; i--) { // newest → oldest
        const r = rows[i];
        let text = String(r.content || '').slice(0, MAX_MSG);
        if (r.role === 'assistant' && r.tool_calls_summary) {
          text += `\n[tools used: ${String(r.tool_calls_summary).slice(0, 120)}]`;
        }
        if (total + text.length > MAX_TOTAL) break; // truncate oldest first
        total += text.length;
        built.unshift({ role: r.role === 'assistant' ? 'assistant' : 'user', content: text });
      }
      // Merge consecutive same-role messages; drop leading assistants.
      for (const m of built) {
        const last = historyMessages[historyMessages.length - 1];
        if (last && last.role === m.role) last.content += '\n' + m.content;
        else historyMessages.push(m);
      }
      while (historyMessages.length && historyMessages[0].role !== 'user') historyMessages.shift();
    } catch (err) {
      console.error('[command] history load failed (continuing without memory):', err.message);
    }
  }

  // Session E9: persist the user's prompt to command_history so the
  // Command Center can render the chat timeline across sessions. Best-
  // effort — a write failure here logs and continues so a transient DB
  // hiccup never blocks an AI command. Only fires after the gates above
  // pass, so blocked / quota-exceeded attempts don't pollute history.
  if (workspaceId && typeof prompt === 'string' && prompt.trim()) {
    try {
      await pool.query(
        `INSERT INTO command_history (workspace_id, user_id, role, content)
         VALUES ($1, $2, 'user', $3)`,
        [workspaceId, req.session.userId, prompt]
      );
    } catch (err) {
      console.error('[command] history user-write failed (non-fatal):', err.message);
    }
  }

  const knowledgeDocs = await getKnowledge(req.session.userId);
  const knowledgeSection = knowledgeDocs.length
    ? `\n## Property Policies & Procedures (Knowledge Base)\nThe property manager has provided the following policies, procedures, and reference documents. Treat these as authoritative. When drafting messages, answering questions, or taking actions, always follow the guidance here:\n\n${knowledgeDocs.map(d => `### ${d.title} (${d.type})\n${d.content}`).join('\n\n')}\n`
    : '';

  // Session E10: vertical-aware context snapshot.
  //   - PM workspaces continue to use the inline req.body-fed template
  //     (existing behavior preserved — same data, same labels).
  //   - PS workspaces get a DB-loaded snapshot rendered via
  //     buildPSContextSummary. The Command Center doesn't send the legacy
  //     req.body context arrays, so without this branch the PS AI would
  //     see "no contacts / no events / no tasks" for everything.
  const vertical = _workspaceRow.vertical || 'property-management';
  let contextSummary;
  if (vertical === 'professional-services') {
    let psSnapshot;
    try {
      psSnapshot = await buildReportSnapshot({
        workspaceId: _workspaceRow.id,
        type: 'command_center',
        parameters: { currentPage: currentPage || null },
      });
    } catch (err) {
      console.error('[command] PS snapshot build failed:', err.message);
      psSnapshot = null;
    }
    const psBody = psSnapshot ? buildPSContextSummary(psSnapshot) : '## Current App State\n(Could not load workspace snapshot.)';
    contextSummary = `${knowledgeSection ? knowledgeSection + '\n' : ''}${psBody}`.trim();
  } else {
    contextSummary = `
## Current App State
${knowledgeSection}
### Contacts (Residents, Vendors, Important)
${contacts && contacts.length ? contacts.map(c => `- ${c.name} (${c.type})${c.unit ? `, Unit ${c.unit}` : ''}${c.email ? `, ${c.email}` : ''}${c.phone ? `, ${c.phone}` : ''}${c.monthly_rent > 0 ? `, $${c.monthly_rent}/mo` : ''}${c.lease_end ? `, lease ends ${c.lease_end}` : ''}`).join('\n') : 'No contacts.'}

### Calendar Events
${calEvents && calEvents.length ? calEvents.map(e => `- ${e.date}: ${e.title}`).join('\n') : 'No events.'}

### Tasks
${tasks && tasks.length ? tasks.map(t => `- [${t.done ? 'done' : 'pending'}] ${t.title} (due ${t.dueDate})`).join('\n') : 'No tasks.'}

### Inbox Messages
${msgList && msgList.length ? msgList.map(m => `- #${m.id}: From ${m.resident} — "${m.subject}" [${m.status}]`).join('\n') : 'No messages.'}

### Rent Records (this month)
${rentRecords && rentRecords.length ? rentRecords.map(r => `- ${r.resident}${r.unit ? ` Unit ${r.unit}` : ''}: $${r.amount} due ${r.due_date} [${r.status}]`).join('\n') : 'No rent records loaded.'}

### Active Maintenance Tickets
${(() => {
  // Session C2.5: include all unresolved statuses so the AI can reason
  // about resolve_maintenance_ticket / update_maintenance_ticket on
  // tickets that have moved past 'open'.
  // Filter: status IN ('open', 'in_progress', 'on_hold')
  const ACTIVE_MAINTENANCE_STATUSES = ['open', 'in_progress', 'on_hold'];
  if (!maintenanceTickets || !maintenanceTickets.length) return 'No active tickets.';
  const active = maintenanceTickets.filter(t => ACTIVE_MAINTENANCE_STATUSES.includes(t.status));
  return active.length
    ? active.map(t => `- #${t.id}: ${t.title}${t.unit ? ` (Unit ${t.unit})` : ''} [${t.status}, ${t.priority}]`).join('\n')
    : 'No active tickets.';
})()}

### Properties (Inventory)
${properties && properties.length ? properties.map(p => `- #${p.id} "${p.name}"${p.address ? ` at ${p.address}` : ''}${p.building_type ? `, ${p.building_type}` : ''}${p.year_built ? `, built ${p.year_built}` : ''}${p.number_of_floors ? `, ${p.number_of_floors} floors` : ''}${p.total_unit_count ? `, ${p.total_unit_count} total units` : ''}`).join('\n') : 'No properties.'}

### Units (Inventory)
${units && units.length ? units.map(u => {
  const dims = [u.bedrooms != null ? `${u.bedrooms}br` : null, u.bathrooms != null ? `${u.bathrooms}ba` : null, u.sqft ? `${u.sqft}sqft` : null].filter(Boolean).join('/');
  const price = u.rent ? `$${u.rent}${u.frequency ? `/${u.frequency.replace(/ly$/,'')}` : ''}` : '';
  const occ = u.occupied_by ? `OCCUPIED by "${u.occupied_by}"` : (u.off_market ? 'Off-market' : 'Vacant');
  return `- #${u.id} "${u.property_name}" ▸ "${u.name}"${dims ? `, ${dims}` : ''}${price ? `, ${price}` : ''}, ${occ}`;
}).join('\n') : 'No units.'}
`.trim();
  }
  // FUTURE: when a workspace has > ~200 units, the units list above
  // dominates the snapshot. Cap the rendered list and tell the AI it's
  // truncated, or switch read-query answers to dedicated endpoints.
  // The frontend builds the units array in submitHomeCommand (views/
  // app.html) — same cap target there.


  // Session B3: every tool now lives in lib/tools/* and runs server-side.
  // The inline tools = [...] array was deleted along with the hybrid filter.
  // Session D4: filter by plan as well as vertical so the AI on a Solo
  // workspace doesn't even see send_broadcast (and any future
  // plan-gated tools). Falls back to the vertical-only filter if plan
  // is missing (legacy workspaces stay unrestricted).
  const planForTools = planInfo && planInfo.plan ? planInfo.plan : null;
  const toolsForAI = registry.getAnthropicSchemaForPlan(vertical, planForTools);

  // Session E10: vertical-aware business framing. PM workspaces see the
  // legacy "property manager" framing; PS workspaces see a service-business
  // framing so the AI refers to people as customers (not residents) and
  // the menu as services/products (not units/properties).
  const businessFraming = vertical === 'professional-services'
    ? `You are an AI command center assistant for a service business — like a salon, spa, hair stylist, nail tech, massage therapist, personal trainer, tutor, pet groomer, or similar appointment-based business. The owner is your user. They run their business through this app: managing customers, services and products on their menu, appointments, transactions, inventory, and vendor relationships. Refer to people as "customers" (not tenants or residents). Refer to the menu as "services and products" (not units or properties). The business operates on bookings and appointments, not leases.`
    : `You are an AI command center assistant for a property management app called Modern Management.
You help property managers get things done by taking action within the app.`;

  // System prompt is reused across every turn of the agentic loop below.
  // Pulled out of the anthropic.messages.create() call so each iteration
  // sends the same instructions — Claude stays capable of calling tools
  // on follow-up turns, not just on the first one.
  // AP2: render the client's compact context object as a short readable
  // block (bounded — only named keys, each field sliced, whole block
  // capped at 600 chars). Replaces AP1's one-liner.
  const screenContext = (() => {
    const c = req.body.context;
    const cap = (v, n) => String(v == null ? '' : v).slice(0, n);
    if (!c || typeof c !== 'object') {
      return currentPage ? `The owner is currently looking at the "${cap(currentPage, 40)}" screen of the app.` : '';
    }
    const bits = [`Owner is on the "${cap(c.page || currentPage || 'unknown', 40)}" screen.`];
    if (c.calendar_view) bits.push(`Calendar ${cap(c.calendar_view, 10)} view, showing ${cap(c.calendar_range, 24)}.`);
    if (c.selected_day) bits.push(`Selected day: ${cap(c.selected_day, 12)}.`);
    if (c.open_event && typeof c.open_event === 'object') {
      bits.push(`Open event: #${cap(c.open_event.id, 12)} "${cap(c.open_event.title, 60)}"${c.open_event.starts_at ? ` at ${cap(c.open_event.starts_at, 30)}` : ''}${c.open_event.contact ? `, customer ${cap(c.open_event.contact, 40)}` : ''}.`);
    }
    if (c.open_contact && typeof c.open_contact === 'object') {
      bits.push(`Open contact: #${cap(c.open_contact.id, 12)} "${cap(c.open_contact.name, 40)}".`);
    }
    if (c.open_thread) bits.push(`Open inbox message: "${cap(c.open_thread, 60)}".`);
    if (c.task_filter) bits.push(`Task filter: ${cap(c.task_filter, 16)}.`);
    if (c.period) bits.push(`Visible finance period: ${cap(c.period, 10)}.`);
    return bits.join(' ').slice(0, 600);
  })();

  const systemPrompt = `${businessFraming}

${contextSummary}

${(() => { const a = require('./lib/time-helpers').promptTimeAnchor(_workspaceRow); return `Business timezone: ${a.tz}. Right now it is ${a.nowInTz}.`; })()}
${screenContext}
When the owner uses relative references, resolve them from the screen context above: "this Friday" means the Friday of the visible or selected week; "this customer" or "them" means the open contact; "this appointment" means the open event. If the screen context cannot resolve a reference, ask ONE short clarifying question — never guess a date or which existing record was meant. That caution is about resolving TARGETS, not about creating records: when you have complete information for a new record (for a new contact, a name plus a phone or email), create it directly — do not ask permission first.

You have access to the following tools. Use them proactively when the user's intent is clear:
- add_calendar_event: schedule events and appointments
- delete_calendar_event: cancel/delete a calendar event by title (and optionally date)
- add_task: create tasks with categories and due dates
- update_task: change a task's status (mark done / pending), title, due date, category, or notes
- compose_message: draft and save messages to residents or contacts
- add_contact: add ${vertical === 'professional-services' ? 'customers' : 'residents'}, vendors, or important contacts${vertical === 'professional-services' ? '' : ' (including lease dates and monthly rent)'}
- update_contact: change phone, email, unit, lease dates, monthly rent, notes, or type on an existing contact
- mark_rent_paid: mark a resident's rent as paid — match by name from the rent records
- send_late_notice: send a payment reminder to an unpaid resident
- add_budget_transaction: log income or expenses to the budget tracker
- add_maintenance_ticket: create maintenance/repair tickets
- generate_rent: create pending rent records for all residents for a given month
- create_property / update_property / archive_property: manage properties (buildings, locations)
- create_unit / update_unit: manage rental units within properties
- set_unit_off_market: toggle a unit's off-market flag (use for repairs, renovations, or temporarily unrentable units)
- retire_unit: soft-delete a unit permanently
- assign_tenant_to_unit / move_tenant_to_unit / end_tenant_assignment: manage which tenant occupies which unit

You can use multiple tools in one response if needed (e.g. "add Maria and generate May rent" → add_contact + generate_rent).
Always explain what you did clearly. For mark_rent_paid and send_late_notice, identify the closest matching resident from the rent records. If no match, say so.

Tool execution: tools execute server-side as part of this request. The tool_result you receive in the follow-up call reflects the actual outcome — if it says "success" the action happened; if it reports failure, explain to the user what went wrong rather than claiming success. Never say "Done" or "I've created X" without seeing a successful tool_result.

Multi-action requests: when the user asks for multiple actions in one message ("create a unit and assign a tenant to it", "add three tasks", "create a property and add two units to it"), call ALL relevant tools in your initial response — not just the first one. Do not announce future actions you intend to take ("I will now do X") and then stop without executing them. If you announce an action, you must execute it via a tool call in the same turn. Sequential dependencies are fine: tools execute in the order you call them, so a later tool can depend on an earlier one's result. The only exception is when a later action genuinely needs information you don't yet have (e.g., the user gave you ambiguous input that requires clarification first) — in that case, ask the user, do not announce-and-fail.

Chained operations: you can call a tool, see its result in the next turn, and then call another tool that depends on that result. For example, to add an add-on to an existing service: call find_menu_item first to look up the parent service's id, then call add_menu_item with parent_menu_item_id set from the result. Don't announce intermediate steps in prose — just call the next tool.

CRITICAL DISAMBIGUATION RULE for inventory tools: when the user references a property, unit, or contact by name, that name may match more than one record in the snapshot above (e.g., two properties both starting with "Riverside", or two contacts named "Maria"). NEVER guess or pick the first match. Before calling create_unit / update_unit / set_unit_off_market / retire_unit / assign_tenant_to_unit / move_tenant_to_unit / update_property / archive_property, scan the Properties / Units / Contacts sections of the snapshot. If a name is ambiguous, do NOT call the tool — instead reply with a clarifying question that lists the candidates (e.g., "Which Riverside — Riverside Lofts (#4) or Riverside North (#7)?"). Only call the tool once the user has clarified.

For READ questions about inventory ("what's vacant?", "who lives in Unit 3B?", "how many units at Glenwood?", "show my properties", "what's the occupancy rate at Glenwood?"), answer directly from the snapshot — do NOT call any tools.`;

  try {
    // Tool execution context — built once, reused across every turn of
    // the loop. Stable across iterations because workspace, user, and
    // env don't change mid-request.
    const ctx = {
      workspace: _workspaceRow,
      user: { id: req.session.userId },
      db: pool,
      logger: console,
      mailer: sgMail,            // SendGrid client (late notices, etc.)
      sms: twilioClient,         // Twilio client (late notices, emergency SMS)
      stripe: stripeSignup,      // E14 Stage 2: test-mode Stripe client for payment-request tools
      env: process.env,          // TWILIO_PHONE_NUMBER, SENDGRID_FROM_EMAIL, MAINTENANCE_PHONE
      generateReportContent,     // Session B4: shared report-generation helper
    };

    // Agentic loop. Single-turn behavior was: call Claude → execute tools →
    // call Claude again for a final text summary. That broke chained ops
    // like "add an add-on to Gel Manicure" because Claude couldn't see the
    // first tool's result and decide to call a second tool.
    //
    // Now: keep cycling (call Claude → execute → push results → call Claude
    // again) until Claude returns a text-only response or we hit the cap.
    // The user sees only the final text reply; intermediate "Now I'll do X"
    // messages are dropped per design. All side effects (DB writes, approval
    // queues, command_history writes downstream) still happen.
    const MAX_ITERATIONS = 5;
    // AP2: prior turns ride ahead of the current prompt.
    const conversationMessages = [...historyMessages, { role: 'user', content: prompt }];

    let reply = '';
    const allActions = [];           // accumulator across every turn
    const allExecutionResults = [];  // accumulator across every turn
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const turnResponse = await anthropic.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: toolsForAI,
        messages: conversationMessages,
      });

      // Parse this turn's content blocks into tool calls + text.
      const turnActions = [];
      let turnReplyText = '';
      for (const block of turnResponse.content) {
        if (block.type === 'text') {
          turnReplyText += block.text;
        } else if (block.type === 'tool_use') {
          // Same shape the prior refactor settled on. toolUseId captured
          // here so the tool_result block can reference it directly with
          // no .find() lookup.
          turnActions.push({
            toolName: block.name,
            toolUseId: block.id,
            input: block.input,
          });
        }
      }

      // The user only sees the LAST turn's text — earlier turns' prose
      // is preamble ("Now I'll look up X…") that's noise to the user.
      reply = turnReplyText;

      // No tool calls this turn → Claude is done. Exit the loop.
      if (turnActions.length === 0 || turnResponse.stop_reason !== 'tool_use') {
        break;
      }

      // Execute every tool Claude requested in this turn.
      const turnExecutionResults = [];
      for (const action of turnActions) {
        const tool = registry.getTool(action.toolName);
        if (!tool) {
          // Should never happen — the AI only sees registered tools — but
          // surface cleanly if Anthropic ever returns an unknown name.
          turnExecutionResults.push({
            action,
            result: { success: false, message: `Unknown tool: ${action.toolName}` },
          });
          continue;
        }

        // Session C1: requiresApproval tools queue to pending_actions
        // instead of executing. Approval lives downstream.
        if (tool.requiresApproval) {
          try {
            const summary = buildPendingActionSummary(action.toolName, action.input);
            const inserted = await pool.query(
              `INSERT INTO pending_actions (workspace_id, user_id, tool_name, input, ai_summary, status)
               VALUES ($1, $2, $3, $4, $5, 'pending')
               RETURNING id, tool_name, ai_summary, created_at`,
              [
                ctx.workspace.id,
                ctx.user.id,
                action.toolName,
                JSON.stringify(action.input),
                summary,
              ]
            );
            const pending = inserted.rows[0];
            turnExecutionResults.push({
              action,
              result: {
                success: true,
                queued: true,
                pendingId: pending.id,
                summary,
                message: `Queued for approval: ${summary}`,
                data: { pending_action_id: pending.id, tool_name: action.toolName },
              },
            });
          } catch (err) {
            console.error(`[command] Failed to queue ${action.toolName}:`, err);
            turnExecutionResults.push({
              action,
              result: { success: false, message: `Failed to queue action: ${err.message}` },
            });
          }
          continue;
        }

        // Normal tool execution. Raw input is passed (not the wrapper) so
        // tools whose schema includes a `type` field (add_menu_item) see
        // their input untouched.
        try {
          const result = await tool.execute(action.input, ctx);
          turnExecutionResults.push({ action, result });
        } catch (err) {
          console.error(`[command] Tool ${action.toolName} threw:`, err);
          turnExecutionResults.push({
            action,
            result: { success: false, message: `Error executing ${action.toolName}: ${err.message}` },
          });
        }
      }

      // Accumulate this turn's results into the request-wide totals.
      allActions.push(...turnActions);
      allExecutionResults.push(...turnExecutionResults);

      // Build tool_result blocks Claude needs to see for its next turn.
      const toolResults = turnExecutionResults.map(({ action, result }) => ({
        type: 'tool_result',
        tool_use_id: action.toolUseId,
        content: result.message
          || (result.success ? `Completed ${action.toolName}` : `Failed ${action.toolName}`),
        is_error: !result.success,
      }));

      // Append this turn's assistant message + the tool results so the
      // next loop iteration's anthropic.messages.create() sees the full
      // history. Loop continues from the while-condition check.
      conversationMessages.push({ role: 'assistant', content: turnResponse.content });
      conversationMessages.push({ role: 'user', content: toolResults });
    }

    if (iterations >= MAX_ITERATIONS) {
      console.warn(`[command] Hit MAX_ITERATIONS (${MAX_ITERATIONS}). Reply may be incomplete; allActions count=${allActions.length}`);
      if (!reply) {
        reply = "I worked through several steps but ran out of room. Some actions may not have completed — please check and try again if needed.";
      }
    }

    // Fallback: if Claude never produced text but did call tools, surface
    // a generic confirmation so the user isn't staring at an empty bubble.
    if (!reply && allActions.length) {
      reply = `Done! I've completed ${allActions.length} action${allActions.length > 1 ? 's' : ''} for you.`;
    }

    // Build action chips for the frontend from EVERY turn's results.
    // Public API contract: each chip's `type` field is the tool name.
    // Session C1: queued/pendingId/summary surface the approval queue
    // so the frontend can render inline approve/reject buttons.
    const actionChips = allExecutionResults.map(({ action, result }) => ({
      type: action.toolName,
      success: result.success,
      message: result.message,
      data: result.data || null,
      queued: !!result.queued,
      pendingId: result.pendingId || null,
      summary: result.summary || null,
    }));

    // Navigation hint considers the full union of actions across turns;
    // selectNavigation picks the last action with a nav policy that fires.
    const navigation = selectNavigation(allExecutionResults, currentPage, registry);

    // Session D2: count this AI command toward the daily cap. Counts one
    // command per /api/command request regardless of how many turns the
    // loop ran — the user submitted one prompt. Best-effort: increment
    // failures are logged but never break the response.
    try {
      await usage.incrementAICommand(pool, {
        workspaceId: _workspaceRow.id,
        userId: req.session.userId,
      });
    } catch (err) {
      console.error('[command] Counter increment failed (non-fatal):', err.message);
    }

    // Session E9: persist assistant reply for the chat timeline.
    // tool_calls_summary lists every tool name invoked across all turns
    // so the UI can show "via find_menu_item, add_menu_item" under the
    // AI bubble. Null when no tools fired.
    try {
      const toolSummary = actionChips.length
        ? actionChips.map(a => a.type).filter(Boolean).join(', ')
        : null;
      await pool.query(
        `INSERT INTO command_history (workspace_id, user_id, role, content, tool_calls_summary)
         VALUES ($1, $2, 'assistant', $3, $4)`,
        [_workspaceRow.id, req.session.userId, reply || 'Done!', toolSummary]
      );
    } catch (err) {
      console.error('[command] history assistant-write failed (non-fatal):', err.message);
    }

    res.json({ reply: reply || 'Done!', actions: actionChips, navigation });
  } catch (err) {
    console.error('Command error:', err.message);
    res.status(500).json({ error: 'Command failed', details: err.message });
  }
});

// --- AI Task Suggestion ---
async function suggestTasksFromConversation(message, replyText, userId) {
  // FD3-CP7 (look-first b): workspace-local date via the shared helper
  // — the bare UTC date was tomorrow's from ~7-8 PM Eastern onward.
  let today;
  try {
    const wR = await pool.query('SELECT timezone FROM workspaces WHERE owner_user_id = $1 LIMIT 1', [userId]);
    today = require('./lib/time-helpers').wsToday(wR.rows[0] || {});
  } catch (err) {
    today = require('./lib/time-helpers').wsToday({});
  }
  try {
    const response = await anthropic.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 600,
      system: `You are a property management assistant that identifies follow-up tasks from resident communications. Return ONLY a valid JSON array of task objects, or [] if no tasks are needed. Each object must have: title (string), category (one of: maintenance, vendor, lease, finance, other), dueDate (YYYY-MM-DD), notes (string), aiReason (string explaining why this task is needed).`,
      messages: [{
        role: 'user',
        content: `Analyze this property management conversation and identify any tasks that were promised, implied, or are clearly necessary.

Today's date: ${today}
Resident/caller: ${message.resident}
Message received: "${message.text}"
${replyText ? `Reply sent: "${replyText}"` : ''}

Rules:
- If an emergency was mentioned (gas leak, flood, fire, no heat, etc.), set dueDate to today
- If something was promised ("we will dispatch", "we will follow up", "we will send"), create a task for it
- If maintenance is needed, create a task for it
- If a lease or financial issue was raised, create a task if follow-up is needed
- Do not create tasks for things already resolved
- Return [] if no tasks are needed

Return only the JSON array, no other text.`
      }]
    });

    const text = response.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const suggested = JSON.parse(match[0]);
    for (const t of suggested) {
      if (!t.title || !t.dueDate) continue;
      await pool.query(
        `INSERT INTO tasks (user_id, title, category, "dueDate", notes, done, suggested, "aiReason") VALUES ($1,$2,$3,$4,$5,false,true,$6)`,
        [userId, t.title, t.category || 'other', t.dueDate, t.notes || `From: ${message.resident} — ${message.subject}`, t.aiReason || '']
      );
    }
    console.log(`AI suggested ${suggested.length} task(s) from message ${message.id}`);
  } catch (err) {
    console.error('Task suggestion error:', err.message);
  }
}

// --- AI Auto-Reply Safety Layer 1: emergency keyword detection ---
// Hardcoded keyword list (per spec — not user-editable). Word-boundary
// regex; case-insensitive. Multi-word phrases like "gas leak" work via
// literal-space matching with \b at the phrase edges. The list errs on
// the side of safety: false positives just hold a message for manual
// review, false negatives let dangerous content through to auto-reply.
//
// Distinct from the older EMERGENCY_KEYWORDS / isEmergency() above
// (~line 1968) which is the MAINTENANCE-ticket triage list — that one
// drives the maintenance "emergency" priority via physical-property
// terms (carbon monoxide, structural, water damage, etc.). The two
// lists overlap (fire / gas leak / smoke) but cover different domains:
// auto-reply safety includes health/safety/threat terms that the
// maintenance list deliberately doesn't, so they shouldn't be merged.
const AUTOREPLY_EMERGENCY_KEYWORDS = [
  // Fire / smoke
  'fire', 'smoke', 'burning', 'alarm',
  // Gas
  'gas leak', 'gas smell', 'propane',
  // Water
  'flood', 'flooding', 'water leak', 'burst pipe', 'sewage',
  // Safety
  'emergency', 'urgent', 'threat', 'threatening', 'weapon', 'gun', 'knife',
  'intruder', 'break-in', 'broken in',
  // Health
  'hurt', 'injured', 'bleeding', 'unconscious', 'dead', 'body', 'overdose',
  // Severity markers
  '911', 'asap urgent', 'life threatening',
];

function _escapeRegexChars(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const AUTOREPLY_EMERGENCY_REGEX = new RegExp(
  '\\b(' + AUTOREPLY_EMERGENCY_KEYWORDS.map(_escapeRegexChars).join('|') + ')\\b',
  'gi'
);

// detectEmergency: returns the unique matched keywords (lower-cased).
// Empty array means clean message. Useful both as the gate (length > 0
// suppresses auto-reply) and as the payload for the owner alert SMS.
function detectEmergency(text) {
  if (!text) return [];
  const matches = String(text).match(AUTOREPLY_EMERGENCY_REGEX);
  if (!matches) return [];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const k = m.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

const { sendOwnerAlert } = require('./lib/owner-alert');
const { persistOutboundMessage } = require('./lib/outbound-persist');
const readState = require('./lib/read-state');

// IB1: record an owner/system/ai outbound AFTER its send succeeded.
// Cannot throw; a persistence failure logs and the send stands.
async function persistOwnerOutbound(userId, { channel, to, body, subject, sentBy }) {
  try {
    const wR = await pool.query('SELECT * FROM workspaces WHERE owner_user_id = $1 LIMIT 1', [userId]);
    if (!wR.rows[0]) return;
    await persistOutboundMessage({
      db: pool, workspace: wR.rows[0], channel, to, body, subject,
      sentBy: sentBy || 'owner', logger: console,
      findOrCreateThread: appointmentEngine.findOrCreateThread,
      // IB1 commit 3: owner turns land in the engine's context too.
      onOwnerTurn: appointmentEngine.appendOwnerTurnToContext,
    });
  } catch (err) {
    console.error('[outbound-persist] wrapper failed (send unaffected):', err.message);
  }
}

// sendOwnerEmergencyAlert: SMS to users.alert_phone first, fall back to
// email via SendGrid (notification_email or email), log + return if
// both are missing. Soft errors only — the message is already flagged
// in the DB; failure here means the owner finds out next time they
// open the inbox rather than instantly.
async function sendOwnerEmergencyAlert(userId, message, matchedKeywords) {
  const sender = (message.resident && String(message.resident).trim())
    || message.phone
    || message.email
    || '(no sender label)';
  const keywords = matchedKeywords.join(', ');
  const smsBody = `Modern Management URGENT: Message from ${sender} flagged for review (keywords: ${keywords}). Reply in app.`;
  // FD3-CP4: routing (alert_phone SMS → notification_email → email)
  // extracted to lib/owner-alert so the approval ping shares it.
  // respectEnabled:false — emergencies always send.
  const sent = await sendOwnerAlert(
    { db: pool, twilio: twilioClient, sendgrid: sgMail, env: process.env, logger: console },
    userId,
    {
      smsBody,
      emailSubject: 'URGENT: Tenant message flagged for review',
      emailText: smsBody + '\n\nMessage preview:\n' + String(message.text || '').slice(0, 500),
      respectEnabled: false,
    }
  );
  if (sent) {
    console.log('[emergency-alert]', sent, 'sent for message', message.id);
  } else {
    console.error(
      '[emergency-alert] not delivered — message', message.id,
      'is flagged in the DB but owner not actively notified'
    );
  }
}

// --- Auto-reply helper ---
async function autoReplyToMessage(message, userId) {
  try {
    const knowledgeDocs = await getKnowledge(userId);
    const knowledgeContext = formatKnowledgeContext(knowledgeDocs);

    const isVoicemail = message.category === 'voicemail';
    const systemPrompt = isVoicemail
      ? `You are a professional property management assistant. Write a SHORT SMS reply (under 160 characters) acknowledging a voicemail was received. Be warm and let them know someone will follow up soon. Do NOT include "Best regards" or signatures.`
      : `You are a professional property management assistant. Draft concise, friendly, and helpful responses to resident messages on behalf of the property management team.\n\n${knowledgeContext}\n\nGuidelines:\n- Address the resident by first name\n- Be warm but professional\n- Keep responses to 3-5 short paragraphs\n- End with "Best regards,\\nThe Property Management Team"`;

    const response = await anthropic.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: isVoicemail ? 100 : 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: isVoicemail
        ? `Acknowledge this voicemail in a short SMS: ${message.text}`
        : `Please draft a response to this message:\n\nFrom: ${message.resident}\nSubject: ${message.subject}\n\n${message.text}` }]
    });

    const draft = response.content.find(b => b.type === 'text')?.text || '';
    if (!draft) return;

    if (message.email) {
      await sgMail.send({
        to: message.email,
        from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
        replyTo: process.env.SENDGRID_FROM_EMAIL,
        subject: 'Re: ' + message.subject,
        text: draft
      });
      // IB1: the PM auto-reply was AI content that never persisted.
      await persistOwnerOutbound(userId, { channel: 'email', to: message.email, body: draft, subject: 'Re: ' + message.subject, sentBy: 'ai' });
    } else if (message.phone) {
      await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: message.phone, body: draft });
      await persistOwnerOutbound(userId, { channel: 'sms', to: message.phone, body: draft, sentBy: 'ai' });
    }

    await pool.query('UPDATE messages SET status=$1 WHERE id=$2', ['sent', message.id]);
    console.log('Auto-reply sent for message', message.id);

    suggestTasksFromConversation(message, draft, userId);
  } catch (err) {
    console.error('Auto-reply error:', err.message);
  }
}

// --- SendGrid: Incoming Email ---
// --- Payment email parser ---
// Uses Claude to extract tenant + amount + date + source from payment confirmation emails
async function parsePaymentEmail({ from, subject, body }) {
  const systemPrompt = `You extract structured payment information from payment confirmation emails (Zelle, Venmo, Chase QuickPay, bank deposit alerts, Stripe, PayPal, Square, AppFolio, Buildium, etc.).

Return ONLY a JSON object with these exact keys:
- tenant: string — the payer's name as it appears in the email (just name, no email/phone)
- amount: number — the payment amount in USD, as a plain number (e.g. 1800, not "$1,800.00")
- date: string — the payment date in YYYY-MM-DD format; if unclear, use today
- source: string — the payment platform (e.g. "Zelle", "Venmo", "Chase", "Bank deposit", "Stripe")
- confidence: "high" | "medium" | "low" — your confidence in the extraction

Rules:
- If the email is NOT a payment confirmation (e.g. it's spam, marketing, unrelated), return {"confidence": "none"} only.
- If amount is ambiguous, use the largest dollar figure in the email.
- Never invent data. If a field is missing, use empty string for strings or 0 for amount.

Today's date is ${new Date().toISOString().split('T')[0]}. Return ONLY the JSON, no other text.`;

  try {
    const response = await anthropic.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: `FROM: ${from}\nSUBJECT: ${subject}\n\nBODY:\n${body}` }]
    });
    const text = response.content.find(b => b.type === 'text')?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('parsePaymentEmail error:', err.message);
    return null;
  }
}

// --- Match parsed payment to a rent record ---
// Returns { rentId, confidence } or { rentId: null, reason } if no confident match
async function matchPaymentToRent(userId, parsed) {
  const today = new Date().toISOString().split('T')[0];
  const in30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  // Look at all unpaid rent records from recent months (last 60 days window)
  const { rows: rents } = await pool.query(
    `SELECT r.*, c.name AS contact_name, c.unit AS contact_unit
     FROM rent_payments r
     LEFT JOIN contacts c ON c.user_id = r.user_id AND LOWER(c.name) = LOWER(r.resident)
     WHERE r.user_id=$1 AND r.status != 'paid' AND r.due_date >= $2
     ORDER BY r.due_date DESC`,
    [userId, in30]
  );

  if (!rents.length) return { rentId: null, reason: 'no_unpaid_records' };

  const tenantLower = (parsed.tenant || '').toLowerCase();
  const parsedAmount = Number(parsed.amount) || 0;

  // Score each candidate: name similarity + amount match
  const scored = rents.map(r => {
    const nameLower = (r.resident || '').toLowerCase();
    let nameScore = 0;
    if (nameLower === tenantLower) nameScore = 100;
    else if (nameLower.includes(tenantLower) || tenantLower.includes(nameLower)) nameScore = 70;
    else {
      // first-name or last-name match
      const tParts = tenantLower.split(/\s+/);
      const rParts = nameLower.split(/\s+/);
      const overlap = tParts.filter(t => t && rParts.includes(t)).length;
      if (overlap) nameScore = 50;
    }
    // Amount match (within $1 tolerance)
    const amountMatch = Math.abs(Number(r.amount) - parsedAmount) <= 1 ? 100 : 0;
    return { rent: r, score: nameScore + amountMatch };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];

  // High confidence: name + amount both match
  if (top.score >= 170) return { rentId: top.rent.id, confidence: 'high' };
  // Medium: name matches well, amount off, OR exact amount but weak name
  if (top.score >= 100) return { rentId: top.rent.id, confidence: 'medium' };
  // Low: weak match, queue for review
  return { rentId: null, reason: 'no_confident_match' };
}

// --- Mark rent paid from a payment event (shared logic) ---
async function markRentPaidFromEvent(userId, rentId, paidDate) {
  await pool.query(
    `UPDATE rent_payments SET status='paid', paid_date=$1 WHERE id=$2 AND user_id=$3`,
    [paidDate || new Date().toISOString().split('T')[0], rentId, userId]
  );
}

app.post('/api/email/incoming', upload.none(), async (req, res) => {
  const fromRaw = req.body.from || req.body.sender || 'Unknown';
  const toRaw = req.body.to || req.body.envelope || '';
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1] : fromRaw;
  const nameMatch = fromRaw.match(/^([^<]+)</);
  const resident = nameMatch ? nameMatch[1].trim() : email;
  const subject = req.body.subject || '(No subject)';
  const text = (req.body.text || req.body.html || '').replace(/<[^>]*>/g, '').trim();

  // Respond immediately to SendGrid so it doesn't retry
  res.sendStatus(200);

  // Check if this is a payment-forwarding email: payments+TOKEN@...
  const paymentMatch = String(toRaw).match(/payments\+([a-z0-9]+)@/i);
  if (paymentMatch) {
    const token = paymentMatch[1].toLowerCase();
    try {
      const { rows: userRows } = await pool.query(
        'SELECT id FROM users WHERE payment_forward_token=$1 LIMIT 1',
        [token]
      );
      if (!userRows.length) {
        console.warn(`Unknown payment forward token: ${token}`);
        return;
      }
      const userId = userRows[0].id;
      await processPaymentEmail(userId, { from: email, subject, body: text });
    } catch (err) {
      console.error('Payment email processing error:', err.message);
    }
    return;
  }

  // Regular resident message handling — route to the user who owns this inbound address
  try {
    // Extract recipient addresses from the "to" field
    const toAddresses = String(toRaw).match(/[\w.+-]+@[\w.-]+/gi) || [];
    let userId = null;
    for (const addr of toAddresses) {
      userId = await lookupUserByEmailAlias(addr);
      if (userId) break;
    }
    if (!userId) {
      console.warn(`Inbound email to unrecognized address(es) [${toAddresses.join(', ')}] from ${email} — dropped`);
      return;
    }

    const { rows } = await pool.query(
      'INSERT INTO messages (user_id, resident, subject, category, text, status, folder, email, direction, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [userId, resident, subject, 'email', text || '(No message body)', 'new', 'inbox', email, 'inbound', 'customer']
    );
    if (rows[0]) {
      sendNotificationEmail(userId, rows[0]);
      sendPushNotification(userId, rows[0]);

      // Layer 1: emergency keyword gate. If matched, flag the row,
      // alert the owner, and skip auto-reply / task suggestion. The
      // notification email above still fires — it's the standard
      // "you got a new message" ping, not the emergency alert.
      const matched = detectEmergency(rows[0].text);
      if (matched.length) {
        try {
          await pool.query(
            'UPDATE messages SET emergency_flagged = TRUE WHERE id = $1',
            [rows[0].id]
          );
          rows[0].emergency_flagged = true;
        } catch (err) {
          console.error('[emergency-alert] Failed to set emergency_flagged for msg', rows[0].id, err.message);
        }
        sendOwnerEmergencyAlert(userId, rows[0], matched);
      } else {
        const autoData = await getAutomation(userId);
        if (autoData.autoReplyEnabled) autoReplyToMessage(rows[0], userId);
        else suggestTasksFromConversation(rows[0], null, userId);
      }
    }
  } catch (err) {
    console.error('Inbound email error:', err.message);
  }
});

// Process a forwarded payment email: parse with AI, match, auto-mark or queue for review
async function processPaymentEmail(userId, { from, subject, body }) {
  const parsed = await parsePaymentEmail({ from, subject, body });

  // Not a payment confirmation — store with 'none' status so it's visible but not actionable
  if (!parsed || parsed.confidence === 'none') {
    await pool.query(
      `INSERT INTO payment_events (user_id, raw_from, raw_subject, raw_body, status, confidence)
       VALUES ($1, $2, $3, $4, 'not_payment', 'none')`,
      [userId, from, subject, body.slice(0, 4000)]
    );
    return;
  }

  const match = await matchPaymentToRent(userId, parsed);
  const status = match.rentId && match.confidence === 'high' ? 'auto_matched'
               : match.rentId && match.confidence === 'medium' ? 'needs_review'
               : 'unmatched';

  const { rows } = await pool.query(
    `INSERT INTO payment_events
       (user_id, raw_from, raw_subject, raw_body, parsed_tenant, parsed_amount, parsed_date, parsed_source, confidence, matched_rent_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [userId, from, subject, body.slice(0, 4000),
     parsed.tenant || '', Number(parsed.amount) || 0, parsed.date || '',
     parsed.source || '', parsed.confidence || 'low',
     match.rentId, status]
  );

  // Auto-mark paid only if confidence is high
  if (status === 'auto_matched' && match.rentId) {
    await markRentPaidFromEvent(userId, match.rentId, parsed.date);
  }

  return rows[0];
}

// --- SendGrid: Send Email ---
app.post('/api/email/send', requireAuth, async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Missing to, subject, or body' });

  // Prefer user's connected account if available — replies appear from their real address
  if (req.session?.userId) {
    const { rows } = await pool.query('SELECT 1 FROM email_accounts WHERE user_id=$1', [req.session.userId]);
    if (rows.length) {
      const result = await sendViaConnectedAccount(req.session.userId, { to, subject, text: body });
      if (result.success) {
        await persistOwnerOutbound(req.session.userId, { channel: 'email', to, body, subject, sentBy: 'owner' });
        return res.json({ success: true, via: 'connected' });
      }
      // Fall through to SendGrid if SMTP fails
      console.warn('Connected SMTP send failed, falling back to SendGrid:', result.error);
    }
  }

  // Fallback: send via MM's SendGrid account
  try {
    await sgMail.send({
      to,
      from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
      replyTo: process.env.SENDGRID_FROM_EMAIL,
      subject,
      text: body
    });
    await persistOwnerOutbound(req.session.userId, { channel: 'email', to, body, subject, sentBy: 'owner' });
    res.json({ success: true, via: 'sendgrid' });
  } catch (err) {
    console.error('SendGrid error:', err.message);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

// --- Twilio: Incoming SMS ---
// --- Multi-tenant inbound routing helpers ---
// Look up which user owns a given Twilio phone number
// Phase A multi-customer routing (A2): replaced the legacy
// lookupUserByPhone() — which looked up users.twilio_phone_number
// directly — with workspace-aware routing. Each customer's workspace
// owns its Twilio number and a subscription_status; only 'active'
// workspaces accept inbound traffic. Returns { workspace_id,
// owner_user_id } or null.
async function lookupWorkspaceByTwilioNumber(phoneNumber) {
  if (!phoneNumber) return null;
  const { rows } = await pool.query(
    `SELECT id AS workspace_id, owner_user_id
       FROM workspaces
      WHERE twilio_phone_number = $1
        AND subscription_status = 'active'
      LIMIT 1`,
    [phoneNumber]
  );
  return rows[0] || null;
}

// Look up which user owns a given inbound email alias
async function lookupUserByEmailAlias(toAddress) {
  if (!toAddress) return null;
  const addr = String(toAddress).toLowerCase();
  // Check inbound_email_alias on users table
  const { rows: aliasRows } = await pool.query(
    `SELECT id FROM users WHERE LOWER(inbound_email_alias)=$1 LIMIT 1`,
    [addr]
  );
  if (aliasRows.length) return aliasRows[0].id;
  // Check connected email_accounts
  const { rows: acctRows } = await pool.query(
    `SELECT user_id FROM email_accounts WHERE LOWER(email)=$1 LIMIT 1`,
    [addr]
  );
  return acctRows[0]?.user_id || null;
}

app.post('/api/sms/incoming', validateTwilioSignature, async (req, res) => {
  const from = req.body.From || 'Unknown';
  const to = req.body.To || '';
  const body = req.body.Body || '';
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const route = await lookupWorkspaceByTwilioNumber(to);
  if (!route) {
    console.warn(`Inbound SMS to unrecognized or inactive Twilio number ${to} from ${from} — dropped`);
    return;
  }
  const userId = route.owner_user_id;

  const { rows } = await pool.query(
    'INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone, direction, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
    [userId, from, `SMS from ${from}`, 'sms', body, 'new', 'inbox', from, 'inbound', 'customer']
  ).catch(err => { console.error('DB insert error:', err.message); return { rows: [] }; });

  if (rows[0]) {
    sendNotificationEmail(userId, rows[0]);
    sendPushNotification(userId, rows[0]);

    // Session E2: PS appointment routing — additive, falls through if
    // not applicable. Loads the full workspace row, then invokes the
    // engine for PS workspaces with appointment_auto_respond=true.
    // When the engine handles the message, we short-circuit the
    // existing emergency-detection / auto-reply / suggest-tasks paths
    // for this turn (the engine has already replied to the customer
    // and persisted an outbound row). When it doesn't handle, those
    // paths run unchanged.
    let _e2Handled = false;
    try {
      const { rows: wsRows } = await pool.query(
        `SELECT * FROM workspaces WHERE id = $1 LIMIT 1`,
        [route.workspace_id]
      );
      const workspace = wsRows[0] || null;
      if (workspace && workspace.vertical === 'professional-services' && workspace.appointment_auto_respond) {
        const engineResult = await appointmentEngine.processInboundMessage({
          workspace,
          contact: null,
          customer_phone: from,
          customer_email: null,
          channel: 'sms',
          body,
          db: pool,
          twilio: twilioClient,
          sendgrid: sgMail,
          env: process.env,
          logger: console,
        });
        _e2Handled = !!(engineResult && engineResult.handled);
        // IB1: link the inbound row to the conversation the engine used
        // (thread + its resolved contact). Best-effort — a failed stamp
        // leaves an unlinked-but-intact row, exactly the pre-IB1 state.
        if (engineResult && engineResult.thread_id && rows[0]) {
          pool.query(
            `UPDATE messages SET thread_id = $1,
                    contact_id = (SELECT contact_id FROM appointment_threads WHERE id = $1)
              WHERE id = $2`,
            [engineResult.thread_id, rows[0].id]
          ).catch((err) => console.error('[sms/incoming] linkage stamp failed:', err.message));
        }
      }
    } catch (err) {
      console.error('[sms/incoming] appointment engine error (falling through):', err.message);
    }

    if (!_e2Handled) {
      // Layer 1: emergency keyword gate (see /api/email/incoming above).
      const matched = detectEmergency(rows[0].text);
      if (matched.length) {
        try {
          await pool.query(
            'UPDATE messages SET emergency_flagged = TRUE WHERE id = $1',
            [rows[0].id]
          );
          rows[0].emergency_flagged = true;
        } catch (err) {
          console.error('[emergency-alert] Failed to set emergency_flagged for msg', rows[0].id, err.message);
        }
        sendOwnerEmergencyAlert(userId, rows[0], matched);
      } else {
        const autoData = await getAutomation(userId);
        if (autoData.autoReplyEnabled) autoReplyToMessage(rows[0], userId);
        else suggestTasksFromConversation(rows[0], null, userId);
      }
    }
  }
});

// --- Twilio: Send SMS reply ---
app.post('/api/sms/send', requireAuth, async (req, res) => {
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });
  try {
    const msg = await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body });
    // IB1: the owner's reply finally exists on file (§6: the
    // conversation was missing every owner turn).
    await persistOwnerOutbound(req.session.userId, { channel: 'sms', to, body, sentBy: 'owner' });
    res.json({ success: true, sid: msg.sid });
  } catch (err) {
    console.error('Twilio send error:', err.message);
    res.status(500).json({ error: 'Failed to send SMS', details: err.message });
  }
});

// --- Voice / Voicemail ---
app.post('/api/voice/incoming', validateTwilioSignature, (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers.host}`;
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for calling Modern Management. Please leave your message after the beep and we will get back to you shortly.</Say>
  <Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="${base}/api/voice/transcription" action="${base}/api/voice/recording" />
</Response>`);
});

app.post('/api/voice/recording', validateTwilioSignature, async (req, res) => {
  const { From, To, CallSid } = req.body;
  const phone = From || 'Unknown';
  const route = await lookupWorkspaceByTwilioNumber(To);
  if (!route) {
    console.warn(`Voicemail to unrecognized or inactive Twilio number ${To} from ${phone} — dropped`);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Goodbye!</Say></Response>`);
    return;
  }
  const userId = route.owner_user_id;
  try {
    await pool.query(
      `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone, direction, sent_by) VALUES ($1,$2,$3,$4,$5,'new','inbox',$6,'inbound','customer')`,
      [userId, `Caller ${phone}`, `[CALLSID:${CallSid}] Voicemail from ${phone}`, 'voicemail', '📞 Voicemail received — transcription in progress...', phone]
    );
  } catch (err) {
    console.error('Voice recording save error:', err.message);
  }
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for your message. We will get back to you shortly. Goodbye!</Say>
</Response>`);
});

app.post('/api/voice/transcription', validateTwilioSignature, async (req, res) => {
  const { TranscriptionText, TranscriptionStatus, CallSid, From, To } = req.body;
  const phone = From || 'Unknown';
  const route = await lookupWorkspaceByTwilioNumber(To);
  if (!route) {
    console.warn(`Transcription for unrecognized or inactive Twilio number ${To} — dropped`);
    return res.sendStatus(200);
  }
  const userId = route.owner_user_id;
  const text = TranscriptionStatus === 'completed' && TranscriptionText
    ? `📞 Voicemail: "${TranscriptionText}"`
    : '📞 Voicemail received (transcription unavailable — check your Twilio recordings)';

  try {
    const { rows } = await pool.query(
      `UPDATE messages SET text=$1, subject=$2 WHERE user_id=$3 AND subject LIKE $4 RETURNING *`,
      [text, `Voicemail from ${phone}`, userId, `[CALLSID:${CallSid}]%`]
    );
    if (rows.length) {
      sendNotificationEmail(userId, rows[0]);
      sendPushNotification(userId, rows[0]);

      // Session E2: PS appointment routing for voicemails. Same
      // additive pattern as /api/sms/incoming: load the workspace,
      // hand the transcript to the engine for PS workspaces with
      // appointment_auto_respond=true, and short-circuit existing
      // emergency / auto-reply paths only when the engine handles it.
      // The transcript text is what we send to the engine — the
      // outbound reply (if any) goes by SMS to the caller's number.
      let _e2Handled = false;
      try {
        const { rows: wsRows } = await pool.query(
          `SELECT * FROM workspaces WHERE id = $1 LIMIT 1`,
          [route.workspace_id]
        );
        const workspace = wsRows[0] || null;
        if (workspace && workspace.vertical === 'professional-services' && workspace.appointment_auto_respond) {
          const transcript = TranscriptionStatus === 'completed' && TranscriptionText
            ? String(TranscriptionText)
            : '';
          if (transcript) {
            const engineResult = await appointmentEngine.processInboundMessage({
              workspace,
              contact: null,
              customer_phone: phone,
              customer_email: null,
              channel: 'voicemail',
              body: transcript,
              db: pool,
              twilio: twilioClient,
              sendgrid: sgMail,
              env: process.env,
              logger: console,
            });
            _e2Handled = !!(engineResult && engineResult.handled);
            // FD3-CP1: a voicemail conversation ends as soon as it is
            // processed — the reply (if any) already went out by SMS,
            // and any customer response starts a fresh thread.
            if (engineResult && engineResult.thread_id) {
              // IB1: stamp the voicemail row with its conversation.
              pool.query(
                `UPDATE messages SET thread_id = $1,
                        contact_id = (SELECT contact_id FROM appointment_threads WHERE id = $1)
                  WHERE user_id = $2 AND subject LIKE '[CALLSID:' || $3 || ']%'`,
                [engineResult.thread_id, userId, CallSid]
              ).catch((err) => console.error('[voice/transcription] linkage stamp failed:', err.message));
              closeConversationThread(engineResult.thread_id, 'voicemail');
            }
          }
        }
      } catch (err) {
        console.error('[voice/transcription] appointment engine error (falling through):', err.message);
      }

      if (!_e2Handled) {
        // Layer 1: emergency keyword gate. Defensive short-circuit —
        // if the row was already flagged by some other path (currently
        // none, but defensive against future code), don't re-detect or
        // re-alert. The owner has already been notified.
        if (rows[0].emergency_flagged) {
          console.log('[emergency-alert] Voicemail row', rows[0].id, 'already flagged — skipping re-detection');
        } else {
          const matched = detectEmergency(rows[0].text);
          if (matched.length) {
            try {
              await pool.query(
                'UPDATE messages SET emergency_flagged = TRUE WHERE id = $1',
                [rows[0].id]
              );
              rows[0].emergency_flagged = true;
            } catch (err) {
              console.error('[emergency-alert] Failed to set emergency_flagged for msg', rows[0].id, err.message);
            }
            sendOwnerEmergencyAlert(userId, rows[0], matched);
          } else {
            const autoData = await getAutomation(userId);
            if (autoData.autoReplyEnabled) await autoReplyToMessage(rows[0], userId);
            else suggestTasksFromConversation(rows[0], null, userId);
          }
        }
      }
    }
  } catch (err) {
    console.error('Transcription update error:', err.message);
  }
  res.sendStatus(200);
});

// --- Voice AI prototype: ConversationRelay entry point ---
//
// Alternative to /api/voice/incoming above. When a phone call comes in on
// a number pointed at THIS route (currently only the +1 (646) 917-7820
// test number in the Twilio Console; all other numbers still hit
// /api/voice/incoming and get the voicemail flow), Twilio dials this
// endpoint for the initial TwiML, we look up which workspace owns the
// number, and we return a <Connect><ConversationRelay/> that hands the
// call off to the WebSocket handler at wss://<host>/twilio-relay for
// live AI conversation. The WebSocket message handler is added in a
// later checkpoint — this route only produces the entry TwiML.
//
// Whitelisted as unauthenticated at /api/* around server.js:2775 alongside
// the other Twilio-called routes.
app.post('/api/voice/relay-incoming', validateTwilioSignature, async (req, res) => {
  const to = req.body && req.body.To;

  // Look up the workspace that owns this number, then load the full row so
  // we can greet the caller by business name. Same two-step pattern the
  // transcription handler uses (lookupWorkspaceByTwilioNumber → SELECT *).
  let workspace = null;
  try {
    const route = await lookupWorkspaceByTwilioNumber(to);
    if (route) {
      const { rows } = await pool.query(
        `SELECT * FROM workspaces WHERE id = $1 LIMIT 1`,
        [route.workspace_id]
      );
      workspace = rows[0] || null;
    }
  } catch (err) {
    console.error('[voice/relay-incoming] workspace lookup failed:', err.message);
  }

  const bizName = (workspace && workspace.business_name) || 'our salon';

  // HTML-escape the business name before injecting into an XML attribute.
  // A stray & or " in a business name would otherwise break the TwiML.
  const escapeXmlAttr = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  // FD3-CP4: no workspace, no socket. An unknown number used to get an
  // anonymous relay connection that could never do anything useful; now
  // it gets a polite goodbye and the socket stays closed to it.
  if (!workspace) {
    res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Response>\n' +
      '  <Say>Sorry, this number is not set up yet. Please try again later.</Say>\n' +
      '  <Hangup/>\n' +
      '</Response>'
    );
    return;
  }

  // FD3-CP4: per-workspace socket token, minted lazily on first use and
  // reused thereafter. 24 random bytes (48 hex chars) — unguessable; the
  // upgrade handler below validates it before any WebSocket exists.
  let relayToken = workspace.voice_relay_token;
  if (!relayToken) {
    relayToken = crypto.randomBytes(24).toString('hex');
    try {
      await pool.query(
        'UPDATE workspaces SET voice_relay_token = $1 WHERE id = $2 AND voice_relay_token IS NULL',
        [relayToken, workspace.id]
      );
      // Concurrent first calls: whoever's UPDATE landed wins — re-read.
      const { rows } = await pool.query('SELECT voice_relay_token FROM workspaces WHERE id = $1', [workspace.id]);
      relayToken = (rows[0] && rows[0].voice_relay_token) || relayToken;
    } catch (err) {
      console.error('[voice/relay-incoming] token mint failed:', err.message);
      res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Response>\n' +
        '  <Say>Sorry, we are having trouble connecting your call. Please try again shortly.</Say>\n' +
        '  <Hangup/>\n' +
        '</Response>'
      );
      return;
    }
  }

  // ConversationRelay requires wss:// for the media stream regardless of the
  // request's own protocol. On Render this is served on the same port as
  // HTTP; local dev over http:// would still need a tunneled wss:// URL.
  // /v2/<token> is the versioned authenticated path (FD3-CP4); the bare
  // legacy path survives only inside the post-boot grace window below.
  const wsUrl = 'wss://' + req.headers.host + '/twilio-relay/v2/' + relayToken;
  const greeting = escapeXmlAttr('Hi, thanks for calling ' + bizName + '. How can I help you today?');

  res.type('text/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Response>\n' +
    '  <Connect>\n' +
    '    <ConversationRelay url="' + wsUrl + '" welcomeGreeting="' + greeting + '" />\n' +
    '  </Connect>\n' +
    '</Response>'
  );
});

// ============================================================
// Reports — saved AI-generated reports (Session B4)
//
// Two callers share generateReportContent():
//   1. POST /api/reports (manual New Report from the Reports page)
//   2. The generate_report AI tool (lib/tools/generate_report.js),
//      threaded via ctx.generateReportContent in /api/command's ctx.
// `function` declarations (not const) so they hoist above the
// /api/command route handler that captures them by reference.
// ============================================================

function capitalizeFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

async function deriveReportTitle({ type, prompt }) {
  if (prompt) {
    const trimmed = String(prompt).trim();
    if (trimmed.length <= 60) return capitalizeFirst(trimmed);
    const cutoff = trimmed.slice(0, 50);
    const lastSpace = cutoff.lastIndexOf(' ');
    return capitalizeFirst((lastSpace > 30 ? cutoff.slice(0, lastSpace) : cutoff)) + '...';
  }
  return `${capitalizeFirst(type)} Report — ${new Date().toLocaleDateString()}`;
}

// Build the structured data slice the AI sees when writing a report.
// Different types pull different table slices. Always includes the
// workspace row (vertical column added in migration 026, may be absent
// on workspaces created before that ran).
//
// Schema notes:
//   - budget_transactions / cal_events / tasks / contacts / maintenance_tickets
//     / rent_payments / invoices are user_id-scoped (legacy). Resolve via
//     workspaces.owner_user_id.
//   - entities / offerings / engagements are workspace_id-scoped.
//   - tasks has no created_at; use "dueDate" as the time anchor.
//   - cal_events has only (user_id, date, title); no event_time, no category.
//   - offerings.bedrooms / .bathrooms / .rent live in the metadata JSONB.
// Session E10: vertical-aware snapshot dispatcher. Reads workspace.vertical
// and routes to buildPMSnapshot (property management) or buildPSSnapshot
// (professional services). The two functions return different shapes —
// downstream callers should check snapshot.workspace.vertical and read
// the appropriate fields. generateReportContent's PM report prompt
// continues to read snapshot.budget / .tenants / .inventory / .activity
// (PM shape). For PS workspaces, the prompt builder uses
// buildPSContextSummary() below.
async function buildReportSnapshot({ workspaceId, type, parameters }) {
  let workspace = null;
  try {
    const ws = await pool.query(
      'SELECT id, vertical, owner_user_id, inventory_tracking_enabled FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    if (ws.rows[0]) workspace = ws.rows[0];
  } catch (e) {
    console.error('[snapshot] workspace lookup failed:', e.message);
  }
  if (!workspace) {
    return { type, generated_at: new Date().toISOString(), parameters, workspace: { id: workspaceId }, error: 'Workspace not found' };
  }
  const vertical = workspace.vertical || 'property-management';
  if (vertical === 'professional-services') {
    return buildPSSnapshot({ workspace, type, parameters });
  }
  return buildPMSnapshot({ workspace, type, parameters });
}

// Existing report-snapshot logic (pre-E10). Behavior unchanged — moved
// into a named function so the dispatcher above can route to it.
async function buildPMSnapshot({ workspace, type, parameters }) {
  const workspaceId = workspace.id;
  const ownerUserId = workspace.owner_user_id || null;
  const snapshot = { type, generated_at: new Date().toISOString() };
  if (parameters) snapshot.parameters = parameters;
  snapshot.workspace = { id: workspaceId, vertical: workspace.vertical || 'property-management' };

  // BUDGET / GENERAL — financial slices
  if (type === 'budget' || type === 'general') {
    const budgetRows = ownerUserId ? (await pool.query(
      `SELECT type, category, description, amount, date
       FROM budget_transactions
       WHERE user_id = $1
       ORDER BY date DESC LIMIT 100`,
      [ownerUserId]
    )).rows : [];
    const rentRows = ownerUserId ? (await pool.query(
      `SELECT resident, unit, amount, due_date, status, paid_date
       FROM rent_payments
       WHERE user_id = $1
       ORDER BY due_date DESC LIMIT 100`,
      [ownerUserId]
    )).rows : [];
    const invoiceRows = ownerUserId ? (await pool.query(
      `SELECT vendor, amount, status, description, date
       FROM invoices
       WHERE user_id = $1
       ORDER BY date DESC LIMIT 50`,
      [ownerUserId]
    )).rows : [];
    snapshot.budget = {
      recent_transactions: budgetRows,
      rent_records: rentRows,
      invoices: invoiceRows,
    };
  }

  // TENANT / GENERAL — residents only
  if (type === 'tenant' || type === 'general') {
    const residents = ownerUserId ? (await pool.query(
      `SELECT name, unit, email, phone, monthly_rent, lease_start, lease_end
       FROM contacts
       WHERE user_id = $1 AND type = 'resident'
       ORDER BY name LIMIT 200`,
      [ownerUserId]
    )).rows : [];
    snapshot.tenants = { residents };
  }

  // INVENTORY / GENERAL — properties + units + active engagements
  if (type === 'inventory' || type === 'general') {
    const properties = (await pool.query(
      `SELECT id, name, address, building_type, total_unit_count
       FROM entities
       WHERE workspace_id = $1 AND archived_at IS NULL
       ORDER BY name LIMIT 100`,
      [workspaceId]
    )).rows;
    const units = (await pool.query(
      `SELECT o.id, o.name, o.entity_id, o.metadata, o.price_amount, o.price_frequency, o.status,
              e.name AS property_name
       FROM offerings o
       JOIN entities e ON e.id = o.entity_id
       WHERE o.workspace_id = $1 AND o.status != 'retired'
       ORDER BY e.name, o.name LIMIT 500`,
      [workspaceId]
    )).rows;
    const engagements = (await pool.query(
      `SELECT eng.contact_id, eng.offering_id, eng.status, eng.start_date, eng.end_date,
              c.name AS tenant_name, o.name AS unit_name
       FROM engagements eng
       LEFT JOIN contacts c ON c.id = eng.contact_id
       LEFT JOIN offerings o ON o.id = eng.offering_id
       WHERE eng.workspace_id = $1 AND eng.status = 'active'
       ORDER BY o.name LIMIT 500`,
      [workspaceId]
    )).rows;
    // Flatten metadata so the AI doesn't have to interpret JSONB structure
    const flatUnits = units.map(u => {
      const md = u.metadata || {};
      return {
        id: u.id,
        name: u.name,
        property_name: u.property_name,
        bedrooms: md.bedrooms ?? null,
        bathrooms: md.bathrooms ?? null,
        sqft: md.sqft ?? null,
        rent: u.price_amount,
        frequency: u.price_frequency,
        status: u.status,
      };
    });
    snapshot.inventory = {
      properties,
      units: flatUnits,
      active_engagements: engagements,
      occupancy_rate: flatUnits.length > 0
        ? Math.round((engagements.length / flatUnits.length) * 100)
        : 0,
    };
  }

  // ACTIVITY / GENERAL — recent events + tickets + tasks
  if (type === 'activity' || type === 'general') {
    const recentEvents = ownerUserId ? (await pool.query(
      `SELECT title, date FROM cal_events
       WHERE user_id = $1 AND date >= (NOW() - INTERVAL '30 days')::date::text
       ORDER BY date DESC LIMIT 50`,
      [ownerUserId]
    )).rows : [];
    const recentTickets = (await pool.query(
      `SELECT title, description, status, priority, unit, resident, "createdAt"
       FROM maintenance_tickets
       WHERE user_id = $1 AND "createdAt" >= NOW() - INTERVAL '30 days'
       ORDER BY "createdAt" DESC LIMIT 50`,
      [ownerUserId]
    )).rows;
    const recentTasks = ownerUserId ? (await pool.query(
      `SELECT title, done, "dueDate", category FROM tasks
       WHERE user_id = $1 AND dismissed_at IS NULL
         AND "dueDate" >= (NOW() - INTERVAL '30 days')::date::text
       ORDER BY "dueDate" DESC LIMIT 50`,
      [ownerUserId]
    )).rows : [];
    snapshot.activity = {
      events_last_30_days: recentEvents,
      tickets_last_30_days: recentTickets,
      tasks_last_30_days: recentTasks,
    };
  }

  return snapshot;
}

// Session E10: PS-shaped snapshot. Loads what Sarah-the-salon-owner cares
// about — broader contacts (no type='resident' filter), the workspace's
// menu, today's appointments, recent transactions, active AI conversations,
// low stock (only when tracking enabled), tasks, and recent inbox messages.
// Each section is independently try/caught so one failing query degrades
// to an empty array rather than blanking the whole snapshot.
async function buildPSSnapshot({ workspace, type, parameters }) {
  const workspaceId = workspace.id;
  const ownerUserId = workspace.owner_user_id || null;
  const inventoryEnabled = workspace.inventory_tracking_enabled === true;
  const snapshot = {
    type,
    generated_at: new Date().toISOString(),
    parameters,
    workspace: { id: workspaceId, vertical: 'professional-services' },
  };

  // Contacts — broader framing for PS. No type filter; customers, vendors,
  // and other relationships all show up.
  try {
    const r = ownerUserId ? await pool.query(
      `SELECT id, name, email, phone, type, notes
         FROM contacts
        WHERE user_id = $1
        ORDER BY name LIMIT 200`,
      [ownerUserId]
    ) : { rows: [] };
    snapshot.contacts = r.rows;
  } catch (err) {
    console.error('[snapshot ps] contacts query failed:', err.message);
    snapshot.contacts = [];
  }

  // Menu — services, products, add-ons. Active only.
  try {
    const r = await pool.query(
      `SELECT id, type, name, category, base_price_cents, duration_minutes, description, parent_menu_item_id
         FROM menu_items
        WHERE workspace_id = $1 AND active = TRUE AND archived_at IS NULL
        ORDER BY type, category, name LIMIT 200`,
      [workspaceId]
    );
    snapshot.menu_items = r.rows;
  } catch (err) {
    console.error('[snapshot ps] menu query failed:', err.message);
    snapshot.menu_items = [];
  }

  // Upcoming appointments — start of today through the next 14 days.
  // Today-only was too narrow: the AI couldn't see future bookings the
  // owner is asking about ("confirm Maria's appointment"). 14 days is a
  // pragmatic window — wide enough to cover most "next appointment"
  // questions, narrow enough to keep the prompt small.
  try {
    const r = await pool.query(
      `SELECT id, contact_id, title, starts_at, ends_at, duration_minutes, status, quoted_price_cents
         FROM appointments
        WHERE workspace_id = $1
          AND starts_at >= date_trunc('day', NOW())
          AND starts_at <  date_trunc('day', NOW()) + INTERVAL '14 days'
          AND status NOT IN ('canceled', 'no_show')
        ORDER BY starts_at LIMIT 50`,
      [workspaceId]
    );
    snapshot.appointments_upcoming = r.rows;
  } catch (err) {
    console.error('[snapshot ps] appointments query failed:', err.message);
    snapshot.appointments_upcoming = [];
  }

  // Recent transactions (last 7 days, paid / partially_paid)
  try {
    const r = await pool.query(
      `SELECT id, customer_display_name, total_cents, status, payment_method, payment_received_at
         FROM transactions
        WHERE workspace_id = $1
          AND status IN ('paid', 'partially_paid')
          AND payment_received_at >= NOW() - INTERVAL '7 days'
        ORDER BY payment_received_at DESC LIMIT 20`,
      [workspaceId]
    );
    snapshot.recent_transactions = r.rows;
  } catch (err) {
    console.error('[snapshot ps] transactions query failed:', err.message);
    snapshot.recent_transactions = [];
  }

  // E14: outstanding balances — transactions where the customer still
  // owes money the owner is actively trying to collect. Restricted to
  // 'partially_paid' and 'unpaid' so pure auto-created drafts (a draft
  // transaction with no payment activity is the appointment-completion
  // shell) don't appear as fake debt. amount_paid_cents is the
  // ledger-backed rollup post-E14, so total - paid is the live owed.
  try {
    const r = await pool.query(
      `SELECT id, customer_display_name, contact_id,
              total_cents, amount_paid_cents,
              (total_cents - amount_paid_cents) AS owed_cents,
              status
         FROM transactions
        WHERE workspace_id = $1
          AND status IN ('partially_paid', 'unpaid')
          AND total_cents > amount_paid_cents
        ORDER BY (total_cents - amount_paid_cents) DESC
        LIMIT 30`,
      [workspaceId]
    );
    snapshot.outstanding_balances = r.rows;
  } catch (err) {
    console.error('[snapshot ps] outstanding_balances query failed:', err.message);
    snapshot.outstanding_balances = [];
  }

  // Active AI conversations (appointment_threads)
  try {
    const r = await pool.query(
      `SELECT id, state, customer_phone, customer_email, last_customer_message_at,
              last_ai_message_at, message_count, context_summary
         FROM appointment_threads
        WHERE workspace_id = $1
          AND state NOT IN ('complete', 'closed')
        ORDER BY last_customer_message_at DESC NULLS LAST LIMIT 20`,
      [workspaceId]
    );
    snapshot.ai_conversations = r.rows;
  } catch (err) {
    console.error('[snapshot ps] conversations query failed:', err.message);
    snapshot.ai_conversations = [];
  }

  // Low stock — null sentinel when tracking is disabled (different from
  // empty array; the prompt builder uses null to omit the section entirely)
  if (inventoryEnabled) {
    try {
      const r = await pool.query(
        `SELECT id, name, status, quantity, unit
           FROM inventory_items
          WHERE workspace_id = $1
            AND status IN ('low', 'out')
            AND archived_at IS NULL
          ORDER BY CASE status WHEN 'out' THEN 0 ELSE 1 END, name LIMIT 50`,
        [workspaceId]
      );
      snapshot.low_stock = r.rows;
    } catch (err) {
      console.error('[snapshot ps] inventory query failed:', err.message);
      snapshot.low_stock = [];
    }
  } else {
    snapshot.low_stock = null;
  }

  // Tasks (shared with PM — user-scoped)
  try {
    const r = ownerUserId ? await pool.query(
      `SELECT id, title, "dueDate", done
         FROM tasks
        WHERE user_id = $1 AND done = FALSE AND dismissed_at IS NULL
        ORDER BY "dueDate" NULLS LAST LIMIT 30`,
      [ownerUserId]
    ) : { rows: [] };
    snapshot.tasks = r.rows;
  } catch (err) {
    console.error('[snapshot ps] tasks query failed:', err.message);
    snapshot.tasks = [];
  }

  // Inbox messages (shared with PM — user-scoped, last 7 days)
  try {
    const r = ownerUserId ? await pool.query(
      `SELECT id, resident, subject, category, status, "createdAt"
         FROM messages
        WHERE user_id = $1
          AND folder = 'inbox'
          AND "createdAt" >= NOW() - INTERVAL '7 days'
        ORDER BY "createdAt" DESC LIMIT 30`,
      [ownerUserId]
    ) : { rows: [] };
    snapshot.inbox_messages = r.rows;
  } catch (err) {
    console.error('[snapshot ps] messages query failed:', err.message);
    snapshot.inbox_messages = [];
  }

  return snapshot;
}

// Session E10: render a PS snapshot into the markdown section that gets
// injected into the AI command center's system prompt. Mirrors the shape
// of the PM contextSummary template but with PS-relevant sections.
function buildPSContextSummary(snapshot) {
  const sections = [];
  sections.push('## Current App State');

  // Contacts — broader framing for PS
  if (snapshot.contacts && snapshot.contacts.length > 0) {
    sections.push(
      '### Contacts (customers, vendors, others)\n' +
      snapshot.contacts.map(c => {
        const parts = [`- ${c.name}`];
        if (c.type) parts.push(` [${c.type}]`);
        if (c.phone) parts.push(`, ${c.phone}`);
        if (c.email) parts.push(`, ${c.email}`);
        return parts.join('');
      }).join('\n')
    );
  } else {
    sections.push('### Contacts\nNo contacts yet.');
  }

  // Menu — services / products / add-ons
  if (snapshot.menu_items && snapshot.menu_items.length > 0) {
    const services = snapshot.menu_items.filter(m => m.type === 'service');
    const products = snapshot.menu_items.filter(m => m.type === 'product');
    const addons = snapshot.menu_items.filter(m => m.type === 'addon');
    let body = '';
    if (services.length) {
      body += '\nServices:\n' + services.map(s => {
        const price = '$' + (Number(s.base_price_cents || 0) / 100).toFixed(2);
        const dur = s.duration_minutes ? ` (${s.duration_minutes} min)` : '';
        return `- #${s.id} ${s.name}${dur}: ${price}`;
      }).join('\n');
    }
    if (products.length) {
      body += '\nProducts:\n' + products.map(p => {
        const price = '$' + (Number(p.base_price_cents || 0) / 100).toFixed(2);
        return `- #${p.id} ${p.name}: ${price}`;
      }).join('\n');
    }
    if (addons.length) {
      body += '\nAdd-ons:\n' + addons.map(a => {
        const parent = snapshot.menu_items.find(m => m.id === a.parent_menu_item_id);
        const price = '$' + (Number(a.base_price_cents || 0) / 100).toFixed(2);
        return `- #${a.id} ${a.name} (add-on to ${parent ? parent.name : 'service'}): ${price}`;
      }).join('\n');
    }
    sections.push(`### Services & Products Menu${body}`);
  } else {
    sections.push('### Services & Products Menu\nNo menu items yet. The owner can add services, products, or add-ons.');
  }

  // Upcoming appointments (next 14 days). The list spans multiple days now,
  // so each line carries the full date+time, plus the customer name resolved
  // from snapshot.contacts when possible — both help the AI disambiguate
  // which appointment a command refers to.
  if (snapshot.appointments_upcoming && snapshot.appointments_upcoming.length > 0) {
    sections.push(
      '### Upcoming Appointments (next 14 days)\n' +
      snapshot.appointments_upcoming.map(a => {
        const when = new Date(a.starts_at).toLocaleString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
        });
        const contact = (snapshot.contacts || []).find(c => c.id === a.contact_id);
        const who = contact ? contact.name : (a.contact_id ? `contact #${a.contact_id}` : 'walk-in');
        return `- #${a.id} ${when} — ${a.title} — ${who} (${a.status})`;
      }).join('\n')
    );
  } else {
    sections.push('### Upcoming Appointments (next 14 days)\nNo upcoming appointments.');
  }

  // Recent transactions
  if (snapshot.recent_transactions && snapshot.recent_transactions.length > 0) {
    sections.push(
      '### Recent Transactions (last 7 days)\n' +
      snapshot.recent_transactions.map(t => {
        const d = t.payment_received_at
          ? new Date(t.payment_received_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '—';
        const amt = '$' + (Number(t.total_cents || 0) / 100).toFixed(2);
        return `- #${t.id} ${d} ${t.customer_display_name || 'Walk-in'} ${amt} (${t.status}, ${t.payment_method || 'unrecorded'})`;
      }).join('\n')
    );
  } else {
    sections.push('### Recent Transactions\nNo transactions in the last 7 days.');
  }

  // Outstanding balances — what each customer still owes. Mirrors the
  // recent_transactions section style. Pure 'draft' transactions are
  // intentionally excluded by the snapshot query (see buildPSSnapshot),
  // so 'partially_paid' and 'unpaid' are the only labels that appear.
  if (snapshot.outstanding_balances && snapshot.outstanding_balances.length > 0) {
    sections.push(
      '### Outstanding Balances\n' +
      snapshot.outstanding_balances.map(t => {
        const owed = '$' + (Number(t.owed_cents || 0) / 100).toFixed(2);
        const total = '$' + (Number(t.total_cents || 0) / 100).toFixed(2);
        const name = t.customer_display_name || 'Walk-in';
        const label = t.status === 'partially_paid' ? 'partially paid' : t.status;
        return `- #${t.id} ${name} — owes ${owed} of ${total} (${label})`;
      }).join('\n')
    );
  } else {
    sections.push('### Outstanding Balances\nNo outstanding balances.');
  }

  // Active AI conversations
  if (snapshot.ai_conversations && snapshot.ai_conversations.length > 0) {
    sections.push(
      '### Active AI Conversations\n' +
      snapshot.ai_conversations.map(c => {
        const who = c.customer_phone || c.customer_email || 'unknown';
        const ctx = c.context_summary ? String(c.context_summary).slice(0, 160) : '(no summary)';
        return `- Thread #${c.id} (${c.state}) with ${who}: ${ctx}`;
      }).join('\n')
    );
  } else {
    sections.push('### Active AI Conversations\nNo active AI conversations right now.');
  }

  // Low stock — section is OMITTED entirely when tracking is disabled
  // (null sentinel from buildPSSnapshot). Empty array shows the "looking good" message.
  if (snapshot.low_stock === null) {
    // skip
  } else if (snapshot.low_stock.length > 0) {
    sections.push(
      '### Low Stock\n' +
      snapshot.low_stock.map(i => {
        const qty = (i.quantity != null) ? ` (${i.quantity}${i.unit ? ' ' + i.unit : ''})` : '';
        return `- ${i.name}: ${i.status}${qty}`;
      }).join('\n')
    );
  } else {
    sections.push('### Low Stock\nInventory looking good. Nothing running low.');
  }

  // Tasks
  if (snapshot.tasks && snapshot.tasks.length > 0) {
    sections.push(
      '### Tasks\n' +
      snapshot.tasks.map(t => {
        const due = t.dueDate
          ? ` (due ${new Date(t.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
          : '';
        return `- ${t.title}${due}`;
      }).join('\n')
    );
  } else {
    sections.push('### Tasks\nNo pending tasks.');
  }

  // Inbox messages
  if (snapshot.inbox_messages && snapshot.inbox_messages.length > 0) {
    sections.push(
      '### Inbox Messages (recent)\n' +
      snapshot.inbox_messages.map(m =>
        `- #${m.id}: From ${m.resident || 'unknown'} — "${m.subject || '(no subject)'}" [${m.status}]`
      ).join('\n')
    );
  } else {
    sections.push('### Inbox Messages\nNo recent inbox messages.');
  }

  return sections.join('\n\n');
}

// Session E12: generate one daily "grow your business" suggestion for a
// workspace. Vertical-aware — it builds a compact digest from the same
// buildReportSnapshot the reports feature uses (PM or PS shape), then
// asks Claude for a single concrete action the owner can take today.
// Returns a short string suitable for a calendar event title, or null
// if the model produced nothing usable. Throws only on a hard API error
// so the caller can distinguish "retry later" from "empty result".
async function generateDailyNudge(workspace) {
  const snapshot = await buildReportSnapshot({
    workspaceId: workspace.id,
    type: 'general',
    parameters: null,
  });
  const vertical = (snapshot.workspace && snapshot.workspace.vertical) || workspace.vertical || 'property-management';

  // Build a compact vertical-aware digest — counts and highlights only,
  // not full record lists. Every access is defensive so a missing
  // snapshot section degrades to a zero rather than throwing.
  let digest;
  if (vertical === 'professional-services') {
    const lowStock = snapshot.low_stock; // null when inventory tracking is off
    digest = [
      'Business type: professional services (appointment-based — salon, spa, stylist, trainer, etc.).',
      'Customers/contacts on file: ' + (snapshot.contacts || []).length,
      'Services/products on the menu: ' + (snapshot.menu_items || []).length,
      'Appointments in the next 14 days: ' + (snapshot.appointments_upcoming || []).length,
      'Paid transactions in the last 7 days: ' + (snapshot.recent_transactions || []).length,
      'Active AI customer conversations: ' + (snapshot.ai_conversations || []).length,
      (lowStock === null
        ? 'Inventory tracking: off.'
        : 'Inventory items low or out of stock: ' + lowStock.length),
      'Open tasks: ' + (snapshot.tasks || []).length,
    ].join('\n');
  } else {
    const inv = snapshot.inventory || {};
    const tickets = (snapshot.activity && snapshot.activity.tickets_last_30_days) || [];
    const activeTickets = tickets.filter(t => ['open', 'in_progress', 'on_hold'].includes(t.status)).length;
    const rentRecords = (snapshot.budget && snapshot.budget.rent_records) || [];
    const unpaidRent = rentRecords.filter(r => r.status && r.status !== 'paid').length;
    digest = [
      'Business type: property management (landlord / property manager).',
      'Properties: ' + (inv.properties || []).length,
      'Units: ' + (inv.units || []).length + ', occupancy ' + (inv.occupancy_rate != null ? inv.occupancy_rate : 0) + '%',
      'Residents on file: ' + ((snapshot.tenants && snapshot.tenants.residents) || []).length,
      'Open maintenance tickets: ' + activeTickets,
      'Unpaid / overdue rent records: ' + unpaidRent,
      'Tasks logged in the last 30 days: ' + ((snapshot.activity && snapshot.activity.tasks_last_30_days) || []).length,
    ].join('\n');
  }

  const businessName = workspace.business_name || workspace.name || 'the business';
  const response = await anthropic.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 120,
    system: 'You are a sharp, practical small-business advisor. Given a one-day snapshot of a business, suggest ONE specific, concrete action the owner can take TODAY to grow profit or productivity. It must be doable within a day and grounded in the snapshot you are given. Reply with a SINGLE short imperative sentence under 90 characters. No quotes, no preamble, no emoji, no markdown.',
    messages: [{ role: 'user', content: 'Business name: ' + businessName + '\n' + digest }],
  });

  const textBlock = (response.content || []).find(b => b.type === 'text');
  let suggestion = textBlock ? String(textBlock.text).trim() : '';
  // Strip stray surrounding quotes the model sometimes adds.
  suggestion = suggestion.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '').trim();
  if (!suggestion) return null;
  // Defensive cap — the column is TEXT but a runaway title is ugly on the calendar.
  if (suggestion.length > 140) suggestion = suggestion.slice(0, 137).trimEnd() + '…';
  return suggestion;
}

async function generateReportContent({ workspaceId, type, prompt, parameters }) {
  // Session D4: enforce subscription status + monthly report quota
  // BEFORE generating. Both upstream callers (POST /api/reports manual
  // UI Mode A AND the generate_report AI tool) funnel through here, so
  // one gate covers both. Failures throw so existing try/catch wrappers
  // in the callers surface a clean error to the user.
  const planInfo = await planEnforcement.getWorkspacePlanInfo(pool, workspaceId);
  const statusCheck = planEnforcement.checkSubscriptionStatus(planInfo);
  if (!statusCheck.allowed) {
    const err = new Error(statusCheck.suggestion || 'Subscription not active.');
    err.code = statusCheck.reason;
    throw err;
  }
  const reportQuotaCheck = await planEnforcement.checkReportQuota(pool, planInfo);
  if (!reportQuotaCheck.allowed) {
    const err = new Error(reportQuotaCheck.suggestion || 'Report quota exceeded.');
    err.code = reportQuotaCheck.reason;
    throw err;
  }

  const snapshot = await buildReportSnapshot({ workspaceId, type, parameters });

  const systemPrompt = `You are an expert property management advisor writing a written report for a property manager.

Write the report in well-formatted markdown. Use headers (##), bullet lists, and bold text where helpful. Keep paragraphs short and scannable. Open with a one-paragraph executive summary, then dig into the relevant sections.

Report type: ${type}
User's request: ${prompt || 'Generate a default report of this type.'}

The data snapshot below contains the workspace's current state. Use only data present here — do not invent numbers or events. If the data shows zero of something (no overdue tenants, no recent maintenance), say so plainly rather than padding.

When writing budget content, always include actionable suggestions ("Consider X because Y").
When writing tenant content, surface anyone whose lease is expiring soon or whose rent is overdue.
When writing inventory content, call out occupancy rate and any vacant units.
When writing activity content, summarize what happened in the relevant time window.
When writing general content, give a balanced cross-cutting overview.

Data snapshot:
${JSON.stringify(snapshot, null, 2)}`;

  const userMessage = prompt || `Generate a ${type} report for the current state of the property.`;

  const response = await anthropic.messages.create({
    // Long-form written report — quality dominates cost/latency, so keep
    // the stronger model even after ANTHROPIC_MODEL flipped to Haiku.
    model: config.ANTHROPIC_REPORT_MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const content = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n\n');

  const title = await deriveReportTitle({ type, prompt });

  // Session D2: count this report toward the monthly cap. Both report
  // creation paths (manual UI POST /api/reports Mode A, AND the AI
  // generate_report tool) invoke this helper before INSERTing, so one
  // increment here covers both. Best-effort: never throws.
  // Known gap: POST /api/reports Mode B (caller-provides-content, no
  // prompt) skips this helper and is not counted; no current frontend
  // caller exercises Mode B, so it's a theoretical gap only.
  try {
    await usage.incrementReport(pool, { workspaceId });
  } catch (err) {
    console.error('[reports] Counter increment failed (non-fatal):', err.message);
  }

  return { title, content, data_snapshot: snapshot };
}

// --- Property Report ---
app.post('/api/report', requireAuth, async (req, res) => {
  const { tasks, messages, calEvents, contacts, budget } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const todayFmt = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const pendingTasks = (tasks || []).filter(t => !t.done);
  const overdueTasks = pendingTasks.filter(t => t.dueDate && t.dueDate < today);
  const newMsgs = (messages || []).filter(m => m.status === 'new');
  const upcomingEvents = (calEvents || []).filter(e => e.date >= today).slice(0, 8);

  const prompt = `You are an expert property management advisor with deep knowledge of real estate market trends, landlord best practices, tenant relations, and operational efficiency. Today is ${todayFmt}.

Generate a comprehensive, actionable property management report based on the following live data:

## TASKS
Open tasks (${pendingTasks.length} total, ${overdueTasks.length} overdue):
${pendingTasks.length ? pendingTasks.map(t => `- [${t.dueDate < today ? 'OVERDUE' : 'pending'}] ${t.title} — due ${t.dueDate} (${t.category})`).join('\n') : 'No open tasks.'}

## INBOX
${newMsgs.length} new unread messages out of ${(messages||[]).length} total:
${newMsgs.length ? newMsgs.map(m => `- From ${m.resident}: "${m.subject}"`).join('\n') : 'Inbox is clear.'}

## CALENDAR
Upcoming events:
${upcomingEvents.length ? upcomingEvents.map(e => `- ${e.date}: ${e.title}`).join('\n') : 'No upcoming events scheduled.'}

## CONTACTS
${(contacts||[]).length} contacts on file (${(contacts||[]).filter(c=>c.type==='resident').length} residents, ${(contacts||[]).filter(c=>c.type==='vendor').length} vendors)

## FINANCIALS (current month)
- Total Income: $${(budget.income||0).toLocaleString('en-US', {minimumFractionDigits:2})}
- Total Expenses: $${(budget.expenses||0).toLocaleString('en-US', {minimumFractionDigits:2})}
- Net Balance: $${(budget.net||0).toLocaleString('en-US', {minimumFractionDigits:2})}

---

Write a professional report with EXACTLY these five sections. Use the section titles as written:

**Executive Summary**
2-3 sentences on the overall health of the property right now — what's going well, what needs attention.

**Priority Action Items**
A numbered list of the top 5 most urgent things to do right now. Draw from the tasks, overdue items, and unread messages. Be specific — include resident names, task names, and dates where relevant.

**AI Recommendations**
4-5 smart, proactive suggestions that go BEYOND the existing task list. Include:
- At least one insight based on current property management market trends or best practices (e.g. rent pricing, lease renewal timing, seasonal maintenance, tenant retention)
- At least one workflow or productivity improvement
- At least one financial optimization idea based on the income/expense data

**Activity Insights**
A brief analysis of recent activity — communication patterns, response times, task completion pace. Note any patterns worth paying attention to.

**This Week's Focus**
3 specific things the manager should focus on in the next 7 days to move the property forward. Be concrete and motivating.

Keep the tone professional but direct. Be genuinely useful — not generic.`;

  try {
    const response = await anthropic.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ report: response.content[0].text });
  } catch (err) {
    console.error('Report generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
  }
});

// ============================================================
// Reports CRUD endpoints (Session B4)
//
// All workspace-scoped via getWorkspaceId(req). Match the auth
// pattern other workspace-scoped resources use (requireAuth +
// resolved workspace id, not raw req.user — that shape doesn't
// exist in this codebase).
// ============================================================
app.get('/api/reports', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const type = req.query.type;
    let limit = parseInt(req.query.limit, 10) || 20;
    if (limit > 100) limit = 100;

    let query = `SELECT id, title, type, prompt, created_at, updated_at FROM reports WHERE workspace_id = $1`;
    const params = [workspaceId];
    if (type) {
      query += ` AND type = $2`;
      params.push(type);
    }
    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/reports]', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

app.get('/api/reports/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid report id' });

    const result = await pool.query(
      `SELECT * FROM reports WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[GET /api/reports/:id]', err);
    res.status(500).json({ error: 'Failed to load report' });
  }
});

app.post('/api/reports', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const userId = req.session.userId;
    const body = req.body || {};

    let { title, type, prompt, content, data_snapshot, parameters } = body;
    type = type || 'general';

    // Mode A: prompt-only — generate content via AI
    if (prompt && !content) {
      const generated = await generateReportContent({
        workspaceId,
        type,
        prompt,
        parameters: parameters || null,
      });
      content = generated.content;
      data_snapshot = generated.data_snapshot;
      if (!title) title = generated.title;
    }

    if (!content) {
      return res.status(400).json({ error: 'Either content or prompt must be provided' });
    }
    if (!title) {
      title = `${type.charAt(0).toUpperCase() + type.slice(1)} Report`;
    }

    const result = await pool.query(
      `INSERT INTO reports (workspace_id, user_id, title, type, prompt, content, data_snapshot, parameters)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        workspaceId, userId, title, type, prompt || null, content,
        data_snapshot ? JSON.stringify(data_snapshot) : null,
        parameters ? JSON.stringify(parameters) : null,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    // Session D5: D4's plan gates inside generateReportContent throw with
    // err.code set. Translate to 403/429 so the frontend's handlePlanError
    // surfaces the upgrade prompt.
    const PLAN_ERR = new Set([
      'subscription_canceled', 'feature_not_in_plan', 'limit_reached',
      'ai_quota_exceeded', 'report_quota_exceeded',
    ]);
    if (err && err.code && PLAN_ERR.has(err.code)) {
      const status = err.code === 'report_quota_exceeded' ? 429 : 403;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    console.error('[POST /api/reports]', err);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

app.delete('/api/reports/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid report id' });

    const result = await pool.query(
      `DELETE FROM reports WHERE id = $1 AND workspace_id = $2 RETURNING id`,
      [id, workspaceId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('[DELETE /api/reports/:id]', err);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

// --- Pending Actions (Approval Queue) — Session C1 ---
//
// Workspace-scoped queue of AI tool calls that need human approval
// before execution. /api/command stores them; these endpoints list,
// approve, and reject. Approving runs the executor with the same ctx
// the command bar would have used.

app.get('/api/pending-actions', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const status = req.query.status || 'pending';

    const result = await pool.query(
      `SELECT id, tool_name, ai_summary, status, created_at, resolved_at, result
       FROM pending_actions
       WHERE workspace_id = $1 AND status = $2
       ORDER BY created_at DESC LIMIT 100`,
      [workspaceId, status]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/pending-actions]', err);
    res.status(500).json({ error: 'Failed to load pending actions' });
  }
});

// FD3-CP3 commit 2: close the loop with the customer who asked. Look-
// first (b) found the approve path executed the tool and told NOBODY —
// from the customer's side, an approved booking never happened. Sends
// on the original channel's address (phone → SMS via the workspace
// number; email → SendGrid) and persists the outbound like the engine
// does. Best-effort: a notify failure never fails the approval.
async function notifyPendingActionCustomer(pending, workspaceId, outcomeText) {
  if (!pending || (!pending.customer_phone && !pending.customer_email)) return;
  try {
    const wsR = await pool.query('SELECT owner_user_id, twilio_phone_number FROM workspaces WHERE id = $1', [workspaceId]);
    const ws = wsR.rows[0];
    if (!ws) return;
    if (pending.customer_phone) {
      await twilioClient.messages.create({
        from: ws.twilio_phone_number || process.env.TWILIO_PHONE_NUMBER,
        to: pending.customer_phone,
        body: outcomeText,
      });
      await pool.query(
        `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone, direction, sent_by, thread_id)
         VALUES ($1, $2, $3, 'sms', $4, 'sent', 'inbox', $5, 'outbound', 'system', $6)`,
        [ws.owner_user_id, pending.customer_phone, 'SMS to ' + pending.customer_phone, outcomeText, pending.customer_phone,
          pending.appointment_thread_id || null]
      );
    } else if (pending.customer_email) {
      await sgMail.send({
        to: pending.customer_email,
        from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
        subject: 'About your recent request',
        text: outcomeText,
      });
    }
  } catch (err) {
    console.error('[pending-notify] customer notify failed (approval unaffected):', err.message);
  }
}

// FD3-CP4: pending count for the topbar badge — cheap enough to call
// on every navigation.
app.get('/api/pending-actions/count', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const r = await pool.query(
      `SELECT COUNT(*)::int AS pending FROM pending_actions WHERE workspace_id = $1 AND status = 'pending'`,
      [workspaceId]
    );
    res.json({ pending: r.rows[0].pending });
  } catch (err) {
    console.error('[GET /api/pending-actions/count]', err);
    res.status(500).json({ error: 'Failed to count pending actions' });
  }
});

app.post('/api/pending-actions/:id/approve', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const userId = req.session.userId;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid action id' });

    const fetch = await pool.query(
      `SELECT * FROM pending_actions WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (fetch.rows.length === 0) {
      return res.status(404).json({ error: 'Action not found' });
    }
    const pending = fetch.rows[0];
    if (pending.status !== 'pending') {
      return res.status(400).json({ error: `Action is already ${pending.status}` });
    }

    await pool.query(
      `UPDATE pending_actions
         SET status = 'approved', resolved_at = NOW(), resolved_by = $1
       WHERE id = $2 AND workspace_id = $3`,
      [userId, id, workspaceId]
    );

    const tool = registry.getTool(pending.tool_name);
    if (!tool) {
      await pool.query(
        `UPDATE pending_actions SET status = 'failed', result = $1 WHERE id = $2 AND workspace_id = $3`,
        [JSON.stringify({ success: false, message: `Tool no longer registered: ${pending.tool_name}` }), id, workspaceId]
      );
      return res.status(500).json({ error: 'Tool no longer registered' });
    }

    const ctx = await buildExecutorContext(req);
    // FD3-CP5: a customer-originated queue row executes with the
    // CUSTOMER'S context restored — origin.channel 'ai_inbound' with
    // the identity the engine stamped at queue time. That makes
    // book_appointment link the thread and resolve the right contact
    // by phone, keeps source provenance honest, and re-runs the FD2
    // ownership guards on cancel/update at execution time. The
    // owner's approval is what authorized the execution; the context
    // says who asked. Owner-originated rows (no customer columns) are
    // untouched.
    if (pending.customer_phone || pending.customer_email || pending.appointment_thread_id) {
      ctx.customer_phone = pending.customer_phone || null;
      ctx.customer_email = pending.customer_email || null;
      ctx.origin = {
        channel: 'ai_inbound',
        channel_detail: pending.customer_channel || 'sms',
        appointment_thread_id: pending.appointment_thread_id || null,
      };
    }
    let result;
    try {
      result = await tool.execute(pending.input, ctx);
    } catch (err) {
      console.error(`[approve ${id}] Tool ${pending.tool_name} threw:`, err);
      result = { success: false, message: `Error: ${err.message}` };
    }

    const finalStatus = result.success ? 'executed' : 'failed';
    await pool.query(
      `UPDATE pending_actions SET status = $1, result = $2 WHERE id = $3 AND workspace_id = $4`,
      [finalStatus, JSON.stringify(result), id, workspaceId]
    );

    // FD3-CP3: tell the customer the outcome in their original channel.
    await notifyPendingActionCustomer(
      pending,
      workspaceId,
      result.success
        ? `Good news — your request is confirmed: ${result.message || pending.ai_summary}`
        : `About your recent request: we couldn't complete it automatically — give us a call and we'll take care of it directly.`
    );

    // FD3-CP5: the conversation the customer was waiting in comes back
    // to life — reset the idle clock (the approval may have taken
    // hours) and reopen a sweep-closed thread so their reply to the
    // notification above lands in the SAME conversation. The executed
    // tool has already advanced any booking-specific state via
    // origin.appointment_thread_id; CASE preserves it.
    if (pending.appointment_thread_id) {
      try {
        await pool.query(
          `UPDATE appointment_threads
              SET updated_at = NOW(),
                  state = CASE WHEN state = 'closed' THEN 'active' ELSE state END
            WHERE id = $1 AND workspace_id = $2`,
          [pending.appointment_thread_id, workspaceId]
        );
      } catch (err) {
        console.error('[approve] thread touch failed (approval complete):', err.message);
      }
    }

    res.json({ success: result.success, status: finalStatus, result });
  } catch (err) {
    console.error('[POST /api/pending-actions/:id/approve]', err);
    res.status(500).json({ error: 'Failed to approve action' });
  }
});

app.post('/api/pending-actions/:id/reject', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const userId = req.session.userId;
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid action id' });

    const fetch = await pool.query(
      `SELECT * FROM pending_actions WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (fetch.rows.length === 0) {
      return res.status(404).json({ error: 'Action not found' });
    }
    if (fetch.rows[0].status !== 'pending') {
      return res.status(400).json({ error: `Action is already ${fetch.rows[0].status}` });
    }

    await pool.query(
      `UPDATE pending_actions
         SET status = 'rejected', resolved_at = NOW(), resolved_by = $1
       WHERE id = $2 AND workspace_id = $3`,
      [userId, id, workspaceId]
    );

    // FD3-CP3: a polite notice, no internal reasons leaked.
    await notifyPendingActionCustomer(
      fetch.rows[0],
      workspaceId,
      "About your recent request: we weren't able to take care of that automatically — give us a call and we'll help you directly."
    );

    // FD3-CP5: same conversation-revival touch as the approve path —
    // the customer just got a text and may well reply to it.
    if (fetch.rows[0].appointment_thread_id) {
      try {
        await pool.query(
          `UPDATE appointment_threads
              SET updated_at = NOW(),
                  state = CASE WHEN state = 'closed' THEN 'active' ELSE state END
            WHERE id = $1 AND workspace_id = $2`,
          [fetch.rows[0].appointment_thread_id, workspaceId]
        );
      } catch (err) {
        console.error('[reject] thread touch failed (rejection complete):', err.message);
      }
    }

    res.json({ success: true, status: 'rejected' });
  } catch (err) {
    console.error('[POST /api/pending-actions/:id/reject]', err);
    res.status(500).json({ error: 'Failed to reject action' });
  }
});

// --- Rent Payments ---

app.get('/api/rent', requireAuth, async (req, res) => {
  const { month, year } = req.query;
  let query = 'SELECT * FROM rent_payments WHERE user_id=$1';
  const params = [req.session.userId];
  if (month && year) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    params.push(`${prefix}%`);
    query += ` AND due_date LIKE $${params.length}`;
  }
  query += ' ORDER BY due_date ASC, resident ASC';
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

app.post('/api/rent', requireAuth, async (req, res) => {
  const { resident, unit, amount, due_date, notes } = req.body;
  if (!resident || !amount) return res.status(400).json({ error: 'resident and amount required' });
  const { rows } = await pool.query(
    'INSERT INTO rent_payments (user_id, resident, unit, amount, due_date, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.session.userId, resident, unit || '', Number(amount), due_date || '', notes || '']
  );
  res.status(201).json(rows[0]);
});

app.put('/api/rent/:id', requireAuth, async (req, res) => {
  const { status, notes, amount, due_date } = req.body;
  const paid_date = status === 'paid' ? new Date().toISOString().split('T')[0] : '';
  const { rows } = await pool.query(
    'UPDATE rent_payments SET status=$1, notes=$2, amount=$3, due_date=$4, paid_date=$5 WHERE id=$6 AND user_id=$7 RETURNING *',
    [status, notes || '', Number(amount), due_date || '', paid_date, Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// Generate monthly rent records from resident contacts
app.post('/api/rent/generate-month', requireAuth, async (req, res) => {
  const { month, year, due_day } = req.body; // month 1-12, year YYYY, due_day 1-28
  if (!month || !year) return res.status(400).json({ error: 'month and year required' });
  const day = String(due_day || 1).padStart(2, '0');
  const due_date = `${year}-${String(month).padStart(2, '0')}-${day}`;
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

  // Get all resident contacts with a monthly_rent set
  const { rows: residents } = await pool.query(
    `SELECT * FROM contacts WHERE user_id=$1 AND type='resident' AND monthly_rent > 0`,
    [req.session.userId]
  );

  let created = 0, skipped = 0;
  for (const r of residents) {
    // Skip if a record for this resident already exists in this month
    const { rows: existing } = await pool.query(
      `SELECT id FROM rent_payments WHERE user_id=$1 AND resident=$2 AND due_date LIKE $3`,
      [req.session.userId, r.name, `${monthPrefix}%`]
    );
    if (existing.length) { skipped++; continue; }
    await pool.query(
      `INSERT INTO rent_payments (user_id, resident, unit, amount, due_date, status, notes)
       VALUES ($1,$2,$3,$4,$5,'pending','')`,
      [req.session.userId, r.name, r.unit || '', r.monthly_rent, due_date]
    );
    created++;
  }
  res.json({ created, skipped, total: residents.length });
});

app.delete('/api/rent/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM rent_payments WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  res.json({ success: true });
});

// Send late notice to resident — looks them up in contacts by name
app.post('/api/rent/:id/late-notice', requireAuth, async (req, res) => {
  const { rows: rentRows } = await pool.query('SELECT * FROM rent_payments WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rentRows.length) return res.status(404).json({ error: 'Rent record not found' });
  const rent = rentRows[0];

  // Try to find contact by resident name or unit
  const { rows: contacts } = await pool.query(
    `SELECT * FROM contacts WHERE user_id=$1 AND (LOWER(name) LIKE LOWER($2) OR unit=$3) LIMIT 1`,
    [req.session.userId, `%${rent.resident}%`, rent.unit]
  );
  const contact = contacts[0];

  const noticeText = `Hi ${rent.resident},\n\nThis is a friendly reminder that your rent payment of ${Number(rent.amount).toFixed(2)} was due on ${rent.due_date} and has not been received.\n\nPlease submit your payment as soon as possible to avoid any late fees.\n\nIf you have already sent payment, please disregard this notice.\n\nThank you,\nThe Property Management Team`;
  // IB1: templated notice — persisted as system-authored below once a
  // channel succeeds.
  let sent = false;
  try {
    if (contact?.email) {
      await sgMail.send({
        to: contact.email,
        from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
        replyTo: process.env.SENDGRID_FROM_EMAIL,
        subject: `Rent Payment Reminder — Unit ${rent.unit}`,
        text: noticeText
      });
      sent = true;
      await persistOwnerOutbound(req.session.userId, { channel: 'email', to: contact.email, body: noticeText, subject: `Rent Payment Reminder — Unit ${rent.unit}`, sentBy: 'system' });
    } else if (contact?.phone) {
      const smsText = `Hi ${rent.resident}, your rent of $${Number(rent.amount).toFixed(2)} due ${rent.due_date} has not been received. Please pay ASAP. — Property Management`;
      await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: contact.phone, body: smsText });
      sent = true;
      await persistOwnerOutbound(req.session.userId, { channel: 'sms', to: contact.phone, body: smsText, sentBy: 'system' });
    }
    // Mark as 'late' if not already
    if (rentRows[0].status !== 'late') {
      await pool.query('UPDATE rent_payments SET status=$1 WHERE id=$2', ['late', rent.id]);
    }
    res.json({ success: true, sent, channel: contact?.email ? 'email' : contact?.phone ? 'sms' : 'none', contactFound: !!contact });
  } catch (err) {
    console.error('Late notice error:', err.message);
    res.status(500).json({ error: 'Failed to send notice', details: err.message });
  }
});

// --- Invoices ---

app.get('/api/invoices', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM invoices WHERE user_id=$1 ORDER BY date DESC',
    [req.session.userId]
  );
  res.json(rows);
});

app.post('/api/invoices', requireAuth, async (req, res) => {
  const { vendor, description, amount, date, notes } = req.body;
  if (!vendor || !amount) return res.status(400).json({ error: 'vendor and amount required' });
  const { rows } = await pool.query(
    'INSERT INTO invoices (user_id, vendor, description, amount, date, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.session.userId, vendor, description || '', Number(amount), date || '', notes || '']
  );
  res.status(201).json(rows[0]);
});

app.put('/api/invoices/:id', requireAuth, async (req, res) => {
  const { status, notes } = req.body;
  const { rows } = await pool.query(
    'UPDATE invoices SET status=$1, notes=$2 WHERE id=$3 AND user_id=$4 RETURNING *',
    [status, notes || '', Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.delete('/api/invoices/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM invoices WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  res.json({ success: true });
});

// --- Transactions (E3, professional services) ---
//
// All endpoints workspace-scoped. The transactions table is workspace-scoped
// snake_case (clean break from legacy user_id-scoped tables). The contact
// link is soft (contacts is user_id-scoped legacy); customer_display_name
// is always populated so the row is readable even if the contact is gone.

// Helper: build a parameterized WHERE clause from query filters
function _buildTxFilters(workspaceId, q) {
  const where = ['t.workspace_id = $1'];
  const params = [workspaceId];
  let i = 2;
  if (q.q && String(q.q).trim()) {
    const term = '%' + String(q.q).toLowerCase().trim() + '%';
    where.push(`(LOWER(t.customer_display_name) LIKE $${i} OR LOWER(COALESCE(t.notes_internal,'')) LIKE $${i} OR LOWER(COALESCE(t.notes_customer,'')) LIKE $${i})`);
    params.push(term);
    i++;
  }
  if (q.customer_name) {
    where.push(`LOWER(t.customer_display_name) LIKE $${i++}`);
    params.push('%' + String(q.customer_name).toLowerCase() + '%');
  }
  if (q.payment_method) {
    where.push(`t.payment_method = $${i++}`);
    params.push(String(q.payment_method).toLowerCase());
  }
  if (q.status) {
    where.push(`t.status = $${i++}`);
    params.push(String(q.status).toLowerCase());
  }
  if (q.start_date) {
    where.push(`COALESCE(t.payment_received_at, t.created_at) >= $${i++}::timestamptz`);
    params.push(q.start_date);
  }
  if (q.end_date) {
    where.push(`COALESCE(t.payment_received_at, t.created_at) <= ($${i++}::date + INTERVAL '1 day')`);
    params.push(q.end_date);
  }
  if (q.min_amount != null && q.min_amount !== '') {
    where.push(`t.total_cents >= $${i++}`);
    params.push(parseInt(q.min_amount, 10) || 0);
  }
  if (q.max_amount != null && q.max_amount !== '') {
    where.push(`t.total_cents <= $${i++}`);
    params.push(parseInt(q.max_amount, 10) || 0);
  }
  return { where: where.join(' AND '), params };
}

app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const { where, params } = _buildTxFilters(workspaceId, req.query);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const countR = await pool.query(`SELECT COUNT(*) AS c FROM transactions t WHERE ${where}`, params);
    const total = parseInt(countR.rows[0].c, 10);

    const r = await pool.query(
      `SELECT t.*
         FROM transactions t
        WHERE ${where}
        ORDER BY COALESCE(t.payment_received_at, t.created_at) DESC, t.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    res.json({ transactions: r.rows, total });
  } catch (err) {
    console.error('[GET /api/transactions]', err.message);
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

app.get('/api/transactions/export.csv', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const { where, params } = _buildTxFilters(workspaceId, req.query);
    const r = await pool.query(
      `SELECT t.*
         FROM transactions t
        WHERE ${where}
        ORDER BY COALESCE(t.payment_received_at, t.created_at) DESC, t.id DESC`,
      params
    );

    const escapeCsv = (v) => {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const fmt = (cents) => cents == null ? '0.00' : (cents / 100).toFixed(2);
    const header = ['Date', 'Customer Name', 'Service/Product Description', 'Subtotal', 'Tax', 'Tip', 'Total', 'Payment Method', 'Status', 'Notes', 'Transaction ID'];
    const lines = [header.join(',')];
    for (const t of r.rows) {
      const date = (t.payment_received_at || t.created_at || new Date()).toISOString().slice(0, 10);
      const items = Array.isArray(t.line_items) ? t.line_items : [];
      const desc = items.map(it => `${it.description || ''}${it.quantity > 1 ? ' x' + it.quantity : ''}`).join('; ');
      const notes = [t.notes_internal, t.notes_customer].filter(Boolean).join(' | ');
      lines.push([
        date,
        escapeCsv(t.customer_display_name),
        escapeCsv(desc),
        fmt(t.subtotal_cents),
        fmt(t.tax_cents),
        fmt(t.tip_cents),
        fmt(t.total_cents),
        escapeCsv(t.payment_method || ''),
        escapeCsv(t.status),
        escapeCsv(notes),
        t.id,
      ].join(','));
    }
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${workspaceId}-${today}.csv"`);
    res.send(lines.join('\n') + '\n');
  } catch (err) {
    console.error('[GET /api/transactions/export.csv]', err.message);
    res.status(500).json({ error: 'Failed to export transactions' });
  }
});

app.get('/api/transactions/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid transaction id' });
    const r = await pool.query(
      `SELECT * FROM transactions WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Transaction not found' });
    // Also pull linked refund children
    const children = await pool.query(
      `SELECT id, total_cents, refund_reason, created_at, status
         FROM transactions
        WHERE parent_transaction_id = $1 AND workspace_id = $2
        ORDER BY created_at DESC`,
      [id, workspaceId]
    );
    // E14: ledger rows for this transaction (every cash/card/Stripe payment
    // and pending Checkout link), oldest first so the modal can show the
    // chronological payment history.
    const payments = await pool.query(
      `SELECT id, amount_cents, payment_type, payment_method, status,
              created_at, notes
         FROM transaction_payments
        WHERE transaction_id = $1 AND workspace_id = $2
        ORDER BY created_at ASC`,
      [id, workspaceId]
    );
    res.json({ transaction: r.rows[0], refunds: children.rows, payments: payments.rows });
  } catch (err) {
    console.error('[GET /api/transactions/:id]', err.message);
    res.status(500).json({ error: 'Failed to load transaction' });
  }
});

app.post('/api/transactions/:id/refund', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid transaction id' });
    const amount_cents = parseInt(req.body && req.body.amount_cents, 10);
    const reason = req.body && req.body.reason ? String(req.body.reason).trim() : '';
    if (!amount_cents || amount_cents <= 0) {
      return res.status(400).json({ error: 'amount_cents is required and must be positive' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'reason is required' });
    }

    const parentR = await pool.query(
      `SELECT * FROM transactions WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [id, workspaceId]
    );
    if (parentR.rows.length === 0) return res.status(404).json({ error: 'Transaction not found' });
    const parent = parentR.rows[0];
    if (!['paid', 'partially_paid'].includes(parent.status)) {
      return res.status(400).json({ error: `Cannot refund a ${parent.status} transaction` });
    }
    const remaining = parent.total_cents - parent.amount_refunded_cents;
    if (amount_cents > remaining) {
      return res.status(400).json({ error: `Refund amount exceeds remaining unrefunded amount ($${(remaining / 100).toFixed(2)})` });
    }

    // Create the refund transaction (linked, source='refund')
    const refundLineItems = [{
      description: `Refund: ${reason}`,
      quantity: 1,
      unit_price_cents: -amount_cents,
      total_cents: -amount_cents,
      type: 'fee',
    }];
    const ins = await pool.query(
      `INSERT INTO transactions
         (workspace_id, contact_id, appointment_id, parent_transaction_id,
          customer_display_name, line_items, subtotal_cents, total_cents,
          amount_paid_cents, payment_method, status, source, refund_reason,
          created_by_user_id, payment_received_at, notes_internal)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7,$7,$8,'paid','refund',$9,$10,NOW(),$11)
       RETURNING id`,
      [workspaceId, parent.contact_id, parent.appointment_id, parent.id,
       parent.customer_display_name, JSON.stringify(refundLineItems),
       -amount_cents, parent.payment_method || 'other',
       reason, req.session.userId,
       `Refund of ${(amount_cents / 100).toFixed(2)} from transaction #${parent.id}`]
    );
    const refundId = ins.rows[0].id;

    // Update parent: amount_refunded_cents += amount_cents; status flips to
    // 'refunded' if fully refunded, otherwise stays paid/partially_paid
    const newRefunded = parent.amount_refunded_cents + amount_cents;
    const newStatus = newRefunded >= parent.total_cents ? 'refunded' : parent.status;
    await pool.query(
      `UPDATE transactions SET amount_refunded_cents = $1, status = $2, updated_at = NOW()
        WHERE id = $3 AND workspace_id = $4`,
      [newRefunded, newStatus, parent.id, workspaceId]
    );

    res.json({ success: true, refund_transaction_id: refundId, parent_status: newStatus });
  } catch (err) {
    console.error('[POST /api/transactions/:id/refund]', err.message);
    res.status(500).json({ error: 'Failed to issue refund' });
  }
});

// E14 Step 4 / Stage 1: owner-initiated online card charge via Stripe
// Checkout, direct onto the connected account (salon keeps 100%, no
// platform fee). Thin wrapper — the actual Stripe session creation,
// ledger insert, double-send guard, and SMS send all live in
// lib/payment-requests.createPaymentRequest, shared with the future
// AI tool path. Behavior on the success path is unchanged.
const REQUEST_PAYMENT_STATUS_BY_REASON = {
  stripe_not_configured:    500,
  invalid_input:            400,
  workspace_not_found:      404,
  not_ps_workspace:         400,
  connect_not_ready:        400,
  transaction_not_found:    404,
  nothing_owed:             400,
  amount_exceeds_remaining: 400,
  already_pending:          409,   // NEW (Stage 1 guard)
  stripe_session_failed:    500,
  ledger_insert_failed:     500,
};
app.post('/api/transactions/:id/request-payment', requireAuth, async (req, res) => {
  if (!stripeSignup) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid transaction id' });

    const payment_type = req.body && req.body.payment_type;
    const amount_cents = parseInt(req.body && req.body.amount_cents, 10);
    if (!['deposit', 'payment'].includes(payment_type)) {
      return res.status(400).json({ error: "payment_type must be 'deposit' or 'payment'" });
    }
    if (!amount_cents || amount_cents <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }

    const wsR = await pool.query(
      `SELECT id, vertical, business_name, owner_user_id,
              twilio_phone_number, stripe_connect_account_id, connect_status
         FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    const workspace = wsR.rows[0];
    if (!workspace) return res.status(404).json({ error: 'workspace_not_found' });

    const result = await paymentRequests.createPaymentRequest({
      pool,
      stripe: stripeSignup,
      twilio: twilioClient,
      env: process.env,
      workspace,
      transactionId: id,
      paymentType: payment_type,
      amountCents: amount_cents,
      actorUserId: req.session.userId,
      logger: console,
    });

    if (!result.success) {
      const status = REQUEST_PAYMENT_STATUS_BY_REASON[result.reason] || 500;
      const body = { error: result.message };
      if (result.detail) body.detail = result.detail;
      return res.status(status).json(body);
    }

    res.json({ url: result.url, payment_id: result.payment_id, texted: result.texted });
  } catch (err) {
    console.error('[POST /api/transactions/:id/request-payment]', err.message);
    res.status(500).json({ error: 'Failed to create payment request' });
  }
});

app.post('/api/transactions/:id/send-receipt', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid transaction id' });

    const txR = await pool.query(
      `SELECT * FROM transactions WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (txR.rows.length === 0) return res.status(404).json({ error: 'Transaction not found' });
    const tx = txR.rows[0];

    const wsR = await pool.query(`SELECT * FROM workspaces WHERE id = $1`, [workspaceId]);
    const workspace = wsR.rows[0] || { id: workspaceId };

    let contact = null;
    if (tx.contact_id) {
      const c = await pool.query(
        `SELECT * FROM contacts WHERE id = $1 AND user_id = $2`,
        [tx.contact_id, workspace.owner_user_id]
      );
      contact = c.rows[0] || null;
    }

    const result = await receipts.sendReceipt({
      transaction: tx,
      workspace,
      contact,
      db: pool,
      sendgrid: sgMail,
      twilio: twilioClient,
      env: process.env,
      logger: console,
    });
    res.json(result);
  } catch (err) {
    console.error('[POST /api/transactions/:id/send-receipt]', err.message);
    res.status(500).json({ error: 'Failed to send receipt' });
  }
});

// --- Menu items / inventory items / vendors (E4) ---
//
// All workspace-scoped (snake_case, post-D7 convention). Soft-archive
// pattern (archived_at TIMESTAMPTZ). The CRUD itself for menu_items goes
// through the AI tools (add_menu_item etc.); these REST endpoints are for
// the UI to LIST and DETAIL (and archive/unarchive for inventory + vendors).

// ----- Menu items -----
app.get('/api/menu-items', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const where = ['m.workspace_id = $1'];
    const params = [workspaceId];
    let i = 2;
    if (req.query.type && ['service', 'product', 'addon'].includes(req.query.type)) {
      where.push(`m.type = $${i++}`); params.push(req.query.type);
    }
    if (req.query.category) {
      where.push(`LOWER(m.category) = $${i++}`); params.push(String(req.query.category).toLowerCase());
    }
    const activeOnly = req.query.active_only !== 'false';
    if (activeOnly) {
      where.push(`m.archived_at IS NULL AND m.active = TRUE`);
    }
    if (req.query.q && String(req.query.q).trim()) {
      where.push(`(LOWER(m.name) LIKE $${i} OR LOWER(COALESCE(m.description,'')) LIKE $${i})`);
      params.push('%' + String(req.query.q).toLowerCase().trim() + '%');
      i++;
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const r = await pool.query(
      `SELECT m.*, p.name AS parent_name, inv.name AS inventory_name
         FROM menu_items m
         LEFT JOIN menu_items p ON p.id = m.parent_menu_item_id
         LEFT JOIN inventory_items inv ON inv.id = m.inventory_item_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.type ASC, m.category ASC, m.name ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    res.json({ menu_items: r.rows });
  } catch (err) {
    console.error('[GET /api/menu-items]', err.message);
    res.status(500).json({ error: 'Failed to load menu items' });
  }
});

app.get('/api/menu-items/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid menu item id' });
    const r = await pool.query(
      `SELECT m.*, p.name AS parent_name, inv.name AS inventory_name
         FROM menu_items m
         LEFT JOIN menu_items p ON p.id = m.parent_menu_item_id
         LEFT JOIN inventory_items inv ON inv.id = m.inventory_item_id
        WHERE m.id = $1 AND m.workspace_id = $2`,
      [id, workspaceId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Menu item not found' });
    res.json({ menu_item: r.rows[0] });
  } catch (err) {
    console.error('[GET /api/menu-items/:id]', err.message);
    res.status(500).json({ error: 'Failed to load menu item' });
  }
});

// --- Menu items: direct REST writes (My Business grid) ---
//
// Mirrors validation, defaults, workspace-scoping, and soft-delete
// behavior of the AI tools in lib/tools/{add,update,archive}_menu_item.js.
// The grid drives services + products only (no addons), which is why
// POST rejects type='addon' here. To add addons, use the AI tool.

app.post('/api/menu-items', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

    const body = req.body || {};
    const type = String(body.type || '').trim();
    if (!['service', 'product'].includes(type)) {
      return res.status(400).json({ error: "type must be 'service' or 'product'" });
    }
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const base_price_cents = body.base_price_cents != null
      ? (parseInt(body.base_price_cents, 10) || 0)
      : 0;
    const duration_minutes_in = body.duration_minutes != null
      ? parseInt(body.duration_minutes, 10)
      : null;
    if (type === 'service' && (!duration_minutes_in || duration_minutes_in <= 0)) {
      return res.status(400).json({ error: 'Services require a duration (a positive number of minutes).' });
    }
    // Products never store a duration, regardless of what was sent.
    const duration_minutes = type === 'service' ? duration_minutes_in : null;

    const tax_behavior = ['none', 'included', 'added'].includes(body.tax_behavior)
      ? body.tax_behavior
      : 'none';

    const r = await pool.query(
      `INSERT INTO menu_items
         (workspace_id, type, name, description, category, base_price_cents,
          duration_minutes, tax_behavior, parent_menu_item_id, inventory_item_id, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
       RETURNING id, type, name, description, category, base_price_cents,
                 duration_minutes, tax_behavior, active, archived_at, created_at, updated_at`,
      [
        workspaceId, type, name,
        body.description || null,
        body.category || null,
        base_price_cents,
        duration_minutes,
        tax_behavior,
        null,   // parent_menu_item_id — grid does not create addons
        null,   // inventory_item_id — grid does not link inventory
      ]
    );
    res.status(201).json({ menu_item: r.rows[0] });
  } catch (err) {
    console.error('[POST /api/menu-items]', err.message);
    res.status(500).json({ error: 'Failed to create menu item' });
  }
});

app.patch('/api/menu-items/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid menu item id' });

    // Pre-check workspace scope so a cross-workspace id returns 404 rather
    // than silent 200 with zero rows updated.
    const found = await pool.query(
      `SELECT id FROM menu_items WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    // Only these fields are editable. type and parent_menu_item_id are
    // immutable — matching lib/tools/update_menu_item.js.
    const fieldMap = [
      ['name', 'name'],
      ['description', 'description'],
      ['category', 'category'],
      ['base_price_cents', 'base_price_cents'],
      ['duration_minutes', 'duration_minutes'],
      ['tax_behavior', 'tax_behavior'],
      ['active', 'active'],
    ];
    const body = req.body || {};
    const setClauses = [];
    const params = [];
    let i = 1;
    for (const [inputKey, col] of fieldMap) {
      if (body[inputKey] !== undefined) {
        setClauses.push(`${col} = $${i++}`);
        params.push(body[inputKey]);
      }
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    setClauses.push(`updated_at = NOW()`);
    params.push(id, workspaceId);

    const r = await pool.query(
      `UPDATE menu_items SET ${setClauses.join(', ')}
        WHERE id = $${i++} AND workspace_id = $${i++}
        RETURNING id, type, name, description, category, base_price_cents,
                  duration_minutes, tax_behavior, active, archived_at, created_at, updated_at`,
      params
    );
    res.json({ menu_item: r.rows[0] });
  } catch (err) {
    console.error('[PATCH /api/menu-items/:id]', err.message);
    res.status(500).json({ error: 'Failed to update menu item' });
  }
});

app.delete('/api/menu-items/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid menu item id' });

    // Soft delete only — the row is referenced by past appointments and
    // transactions. Matches lib/tools/archive_menu_item.js.
    const found = await pool.query(
      `SELECT id, type, name, archived_at FROM menu_items WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    const item = found.rows[0];
    if (item.archived_at) {
      return res.status(400).json({ error: `${item.name} is already archived.` });
    }

    await pool.query(
      `UPDATE menu_items
          SET archived_at = NOW(), active = FALSE, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );

    // Cascade-archive add-ons if this is a service so no orphaned add-ons
    // remain on the menu.
    if (item.type === 'service') {
      await pool.query(
        `UPDATE menu_items
            SET archived_at = NOW(), active = FALSE, updated_at = NOW()
          WHERE parent_menu_item_id = $1
            AND workspace_id = $2
            AND archived_at IS NULL`,
        [id, workspaceId]
      );
    }

    res.json({ success: true, id });
  } catch (err) {
    console.error('[DELETE /api/menu-items/:id]', err.message);
    res.status(500).json({ error: 'Failed to archive menu item' });
  }
});

// ----- Inventory items -----
app.get('/api/inventory-items', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const where = ['workspace_id = $1', 'archived_at IS NULL'];
    const params = [workspaceId];
    let i = 2;
    if (req.query.status && ['in_stock', 'low', 'out'].includes(req.query.status)) {
      where.push(`status = $${i++}`); params.push(req.query.status);
    }
    if (req.query.category) {
      where.push(`LOWER(category) = $${i++}`); params.push(String(req.query.category).toLowerCase());
    }
    if (req.query.q && String(req.query.q).trim()) {
      where.push(`LOWER(name) LIKE $${i++}`);
      params.push('%' + String(req.query.q).toLowerCase().trim() + '%');
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const r = await pool.query(
      `SELECT i.*, v.name AS vendor_name
         FROM inventory_items i
         LEFT JOIN vendors v ON v.id = i.preferred_vendor_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.status DESC, i.name ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    res.json({ inventory_items: r.rows });
  } catch (err) {
    console.error('[GET /api/inventory-items]', err.message);
    res.status(500).json({ error: 'Failed to load inventory' });
  }
});

app.get('/api/inventory-items/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid inventory item id' });
    const r = await pool.query(
      `SELECT i.*, v.name AS vendor_name
         FROM inventory_items i
         LEFT JOIN vendors v ON v.id = i.preferred_vendor_id
        WHERE i.id = $1 AND i.workspace_id = $2`,
      [id, workspaceId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Inventory item not found' });
    res.json({ inventory_item: r.rows[0] });
  } catch (err) {
    console.error('[GET /api/inventory-items/:id]', err.message);
    res.status(500).json({ error: 'Failed to load inventory item' });
  }
});

app.post('/api/inventory-items/:id/archive', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query(
      `UPDATE inventory_items SET archived_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        RETURNING id`,
      [id, workspaceId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found or already archived' });
    res.json({ success: true, id });
  } catch (err) {
    console.error('[POST /api/inventory-items/:id/archive]', err.message);
    res.status(500).json({ error: 'Failed to archive' });
  }
});

app.post('/api/inventory-items/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query(
      `UPDATE inventory_items SET archived_at = NULL, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2
        RETURNING id`,
      [id, workspaceId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, id });
  } catch (err) {
    console.error('[POST /api/inventory-items/:id/unarchive]', err.message);
    res.status(500).json({ error: 'Failed to unarchive' });
  }
});

// ----- Vendors -----
app.get('/api/vendors', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const where = ['workspace_id = $1', 'archived_at IS NULL'];
    const params = [workspaceId];
    let i = 2;
    if (req.query.q && String(req.query.q).trim()) {
      where.push(`LOWER(name) LIKE $${i++}`);
      params.push('%' + String(req.query.q).toLowerCase().trim() + '%');
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const r = await pool.query(
      `SELECT * FROM vendors
        WHERE ${where.join(' AND ')}
        ORDER BY name ASC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    res.json({ vendors: r.rows });
  } catch (err) {
    console.error('[GET /api/vendors]', err.message);
    res.status(500).json({ error: 'Failed to load vendors' });
  }
});

app.get('/api/vendors/:id', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid vendor id' });
    const r = await pool.query(
      `SELECT * FROM vendors WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ vendor: r.rows[0] });
  } catch (err) {
    console.error('[GET /api/vendors/:id]', err.message);
    res.status(500).json({ error: 'Failed to load vendor' });
  }
});

app.post('/api/vendors/:id/archive', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query(
      `UPDATE vendors SET archived_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        RETURNING id`,
      [id, workspaceId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found or already archived' });
    res.json({ success: true, id });
  } catch (err) {
    console.error('[POST /api/vendors/:id/archive]', err.message);
    res.status(500).json({ error: 'Failed to archive' });
  }
});

app.post('/api/vendors/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query(
      `UPDATE vendors SET archived_at = NULL, updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2
        RETURNING id`,
      [id, workspaceId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, id });
  } catch (err) {
    console.error('[POST /api/vendors/:id/unarchive]', err.message);
    res.status(500).json({ error: 'Failed to unarchive' });
  }
});

// ----- Inventory tracking toggle (workspace-level setting) -----
app.post('/api/workspace/inventory-tracking', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const enabled = req.body && (req.body.enabled === true || req.body.enabled === 'true');
    await pool.query(
      `UPDATE workspaces SET inventory_tracking_enabled = $1 WHERE id = $2`,
      [enabled, workspaceId]
    );
    res.json({ enabled });
  } catch (err) {
    console.error('[POST /api/workspace/inventory-tracking]', err.message);
    res.status(500).json({ error: 'Failed to toggle inventory tracking' });
  }
});

// --- AI settings: appointment_auto_respond + appointment_auto_confirm ---
//
// appointment_auto_respond is read at lib/appointment-engine.js:56 (master
// gate on the whole engine). appointment_auto_confirm is read at
// lib/tools/book_appointment.js:66 (decides whether AI bookings land
// 'confirmed' vs 'requested'). These two are already load-bearing — this
// endpoint just exposes them to a settings UI without changing any reader.

// Allowed values for the personality fields. Enforced at PATCH; empty
// string / null clears back to default behavior (prompt builder skips
// the injection).
const AI_TONE_VALUES = ['warm', 'professional', 'brief'];
const AI_SALES_POSTURE_VALUES = ['reactive', 'proactive'];

// FD3-CP3: the autonomy matrix store. MODES/DEFAULTS come from the same
// module the engine's choke point consults, so the UI and enforcement
// can never drift apart.
const { CATEGORIES: AUTONOMY_CATEGORIES, MODES: AUTONOMY_MODES, DEFAULTS: AUTONOMY_DEFAULTS } = require('./lib/autonomy');
// FD3-CP6: deposit policy + the live-mode reality gate.
const { depositsLive, depositConfig, DEPOSIT_MODES } = require('./lib/deposits');

app.get('/api/workspace/ai-settings', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });
    const r = await pool.query(
      `SELECT appointment_auto_respond, appointment_auto_confirm,
              ai_tone, ai_sales_posture,
              autonomy_bookings, autonomy_contacts, autonomy_tasks, autonomy_payments,
              deposit_enabled, deposit_mode, deposit_value
         FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    const row = r.rows[0] || {};
    res.json({
      appointment_auto_respond: !!row.appointment_auto_respond,
      appointment_auto_confirm: !!row.appointment_auto_confirm,
      ai_tone: row.ai_tone == null ? null : row.ai_tone,
      ai_sales_posture: row.ai_sales_posture == null ? null : row.ai_sales_posture,
      // Effective autonomy per category: NULL/invalid → the code default,
      // so the UI always shows what the engine will actually do.
      ...AUTONOMY_CATEGORIES.reduce((acc, cat) => {
        const v = row['autonomy_' + cat];
        acc['autonomy_' + cat] = AUTONOMY_MODES.includes(v) ? v : AUTONOMY_DEFAULTS[cat];
        return acc;
      }, {}),
      // FD3-CP6: deposit config + the reality flag the honest toggle
      // renders from. deposits_activatable is COMPUTED, never stored —
      // the UI cannot lie about it and neither can a stale row.
      ...(() => {
        const cfg = depositConfig(row);
        return {
          deposit_enabled: cfg.enabled,
          deposit_mode: cfg.mode,
          deposit_value: cfg.value,
          deposits_activatable: depositsLive(process.env),
        };
      })(),
    });
  } catch (err) {
    console.error('[GET /api/workspace/ai-settings]', err.message);
    res.status(500).json({ error: 'Failed to load AI settings' });
  }
});

app.patch('/api/workspace/ai-settings', requireAuth, async (req, res) => {
  try {
    const workspaceId = await getWorkspaceId(req);
    if (!workspaceId) return res.status(500).json({ error: 'No workspace for user' });

    const body = req.body || {};
    // Only accept fields when they are actually present in the body — so a
    // caller can PATCH a single flag without silently zeroing the other.
    const setClauses = [];
    const params = [];
    let i = 1;
    if (Object.prototype.hasOwnProperty.call(body, 'appointment_auto_respond')) {
      setClauses.push(`appointment_auto_respond = $${i++}`);
      params.push(body.appointment_auto_respond === true || body.appointment_auto_respond === 'true');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'appointment_auto_confirm')) {
      setClauses.push(`appointment_auto_confirm = $${i++}`);
      params.push(body.appointment_auto_confirm === true || body.appointment_auto_confirm === 'true');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'ai_tone')) {
      const raw = body.ai_tone;
      // Empty string / null / undefined all clear the preference back to default.
      const normalized = (raw == null || raw === '') ? null : String(raw);
      if (normalized !== null && !AI_TONE_VALUES.includes(normalized)) {
        return res.status(400).json({ error: `ai_tone must be one of ${AI_TONE_VALUES.join(', ')} or empty` });
      }
      setClauses.push(`ai_tone = $${i++}`);
      params.push(normalized);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'ai_sales_posture')) {
      const raw = body.ai_sales_posture;
      const normalized = (raw == null || raw === '') ? null : String(raw);
      if (normalized !== null && !AI_SALES_POSTURE_VALUES.includes(normalized)) {
        return res.status(400).json({ error: `ai_sales_posture must be one of ${AI_SALES_POSTURE_VALUES.join(', ')} or empty` });
      }
      setClauses.push(`ai_sales_posture = $${i++}`);
      params.push(normalized);
    }
    // FD3-CP3: per-category autonomy. '' / null clears the column back to
    // NULL, which means "use the code default" — a workspace can always
    // return to byte-identical stock behavior.
    for (const cat of AUTONOMY_CATEGORIES) {
      const field = 'autonomy_' + cat;
      if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
      const raw = body[field];
      const normalized = (raw == null || raw === '') ? null : String(raw);
      if (normalized !== null && !AUTONOMY_MODES.includes(normalized)) {
        return res.status(400).json({ error: `${field} must be one of ${AUTONOMY_MODES.join(', ')} or empty` });
      }
      setClauses.push(`${field} = $${i++}`);
      params.push(normalized);
    }
    // FD3-CP6: deposit settings. Amount controls save normally; the
    // ENABLE flag is governed by reality — while Stripe is test-mode,
    // enabling is refused server-side too, not just grayed in the UI.
    if (Object.prototype.hasOwnProperty.call(body, 'deposit_mode')) {
      const v = body.deposit_mode;
      if (!DEPOSIT_MODES.includes(v)) {
        return res.status(400).json({ error: `deposit_mode must be one of ${DEPOSIT_MODES.join(', ')}` });
      }
      setClauses.push(`deposit_mode = $${i++}`);
      params.push(v);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'deposit_value')) {
      const v = parseInt(body.deposit_value, 10);
      if (!Number.isInteger(v) || v <= 0 || (body.deposit_mode === 'percent' && v > 100)) {
        return res.status(400).json({ error: 'deposit_value must be a positive integer (1-100 for percent mode)' });
      }
      setClauses.push(`deposit_value = $${i++}`);
      params.push(v);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'deposit_enabled')) {
      const want = body.deposit_enabled === true || body.deposit_enabled === 'true';
      if (want && !depositsLive(process.env)) {
        return res.status(400).json({ error: 'Deposits activate when live payments are connected.' });
      }
      setClauses.push(`deposit_enabled = $${i++}`);
      params.push(want);
    }
    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No settings to update' });
    }
    params.push(workspaceId);
    await pool.query(
      `UPDATE workspaces SET ${setClauses.join(', ')} WHERE id = $${i++}`,
      params
    );

    // Return the current state so the frontend refreshes from source of truth.
    const r = await pool.query(
      `SELECT appointment_auto_respond, appointment_auto_confirm,
              ai_tone, ai_sales_posture,
              autonomy_bookings, autonomy_contacts, autonomy_tasks, autonomy_payments,
              deposit_enabled, deposit_mode, deposit_value
         FROM workspaces WHERE id = $1`,
      [workspaceId]
    );
    const row = r.rows[0] || {};
    res.json({
      appointment_auto_respond: !!row.appointment_auto_respond,
      appointment_auto_confirm: !!row.appointment_auto_confirm,
      ai_tone: row.ai_tone == null ? null : row.ai_tone,
      ai_sales_posture: row.ai_sales_posture == null ? null : row.ai_sales_posture,
      // Effective autonomy per category: NULL/invalid → the code default,
      // so the UI always shows what the engine will actually do.
      ...AUTONOMY_CATEGORIES.reduce((acc, cat) => {
        const v = row['autonomy_' + cat];
        acc['autonomy_' + cat] = AUTONOMY_MODES.includes(v) ? v : AUTONOMY_DEFAULTS[cat];
        return acc;
      }, {}),
      // FD3-CP6: deposit config + the reality flag the honest toggle
      // renders from. deposits_activatable is COMPUTED, never stored —
      // the UI cannot lie about it and neither can a stale row.
      ...(() => {
        const cfg = depositConfig(row);
        return {
          deposit_enabled: cfg.enabled,
          deposit_mode: cfg.mode,
          deposit_value: cfg.value,
          deposits_activatable: depositsLive(process.env),
        };
      })(),
    });
  } catch (err) {
    console.error('[PATCH /api/workspace/ai-settings]', err.message);
    res.status(500).json({ error: 'Failed to update AI settings' });
  }
});

// --- Broadcasts ---

app.get('/api/broadcasts', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM broadcasts WHERE user_id=$1 ORDER BY "createdAt" DESC LIMIT 50',
    [req.session.userId]
  );
  res.json(rows);
});

app.post('/api/broadcast', requireAuth, async (req, res) => {
  const { channel, subject, body, recipientFilter, contactIds } = req.body;
  if (!channel || !body) return res.status(400).json({ error: 'channel and body are required' });

  // Build recipient list from contacts
  let query = 'SELECT * FROM contacts WHERE user_id=$1';
  const params = [req.session.userId];
  if (contactIds && contactIds.length) {
    query += ` AND id = ANY($2::int[])`;
    params.push(contactIds);
  } else if (recipientFilter && recipientFilter !== 'all') {
    query += ` AND type=$2`;
    params.push(recipientFilter);
  }
  const { rows: contacts } = await pool.query(query, params);

  // Filter to contacts that have the right channel info
  const eligible = channel === 'email'
    ? contacts.filter(c => c.email && c.email.includes('@'))
    : contacts.filter(c => c.phone && c.phone.trim());

  if (!eligible.length) {
    return res.status(400).json({ error: `No contacts found with a valid ${channel === 'email' ? 'email address' : 'phone number'}.` });
  }

  // Save broadcast record
  const { rows: bRows } = await pool.query(
    `INSERT INTO broadcasts (user_id, channel, subject, body, recipient_filter, recipient_count)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.session.userId, channel, subject || '', body, recipientFilter || 'custom', eligible.length]
  );
  const broadcast = bRows[0];

  // Respond immediately — send async
  res.json({ broadcastId: broadcast.id, recipientCount: eligible.length, status: 'sending' });

  // Fire sends in background
  let sent = 0, failed = 0;
  for (const contact of eligible) {
    try {
      if (channel === 'email') {
        await sgMail.send({
          to: contact.email,
          from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
          replyTo: process.env.SENDGRID_FROM_EMAIL,
          subject: subject || 'Message from your property manager',
          text: body,
          html: body.replace(/\n/g, '<br>')
        });
      } else {
        await twilioClient.messages.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to: contact.phone,
          body
        });
      }
      // IB1: each broadcast recipient gets a conversation row —
      // owner-typed content, owner authorship.
      await persistOwnerOutbound(req.session.userId, {
        channel,
        to: channel === 'email' ? contact.email : contact.phone,
        body,
        subject: channel === 'email' ? (subject || 'Message from your property manager') : undefined,
        sentBy: 'owner',
      });
      sent++;
    } catch (err) {
      console.error(`Broadcast send failed for contact ${contact.id}:`, err.message);
      failed++;
    }
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 120));
  }

  await pool.query(
    'UPDATE broadcasts SET sent_count=$1, failed_count=$2 WHERE id=$3',
    [sent, failed, broadcast.id]
  );
  console.log(`Broadcast ${broadcast.id}: ${sent} sent, ${failed} failed`);
});

// --- CSV Contact Import ---
app.post('/api/contacts/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const csv = req.file.buffer.toString('utf-8');
    const lines = csv.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });

    // Detect header positions (case-insensitive)
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
    const col = (name) => headers.indexOf(name);
    const nameIdx = col('name');
    if (nameIdx === -1) return res.status(400).json({ error: 'CSV must have a "name" column' });

    const typeIdx = col('type');
    const unitIdx = col('unit');
    const emailIdx = col('email');
    const phoneIdx = col('phone');
    const notesIdx = col('notes');

    const parseRow = (line) => {
      // Handle quoted fields with commas
      const fields = [];
      let cur = '', inQuote = false;
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; }
        else { cur += ch; }
      }
      fields.push(cur.trim());
      return fields;
    };

    let imported = 0;
    const errors = [];
    for (let i = 1; i < lines.length; i++) {
      const fields = parseRow(lines[i]);
      const name = fields[nameIdx]?.replace(/['"]/g, '').trim();
      if (!name) continue;
      try {
        await pool.query(
          'INSERT INTO contacts (user_id, name, type, unit, email, phone, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [
            req.session.userId,
            name,
            typeIdx >= 0 ? (fields[typeIdx]?.replace(/['"]/g, '').trim() || 'resident') : 'resident',
            unitIdx >= 0 ? (fields[unitIdx]?.replace(/['"]/g, '').trim() || '') : '',
            emailIdx >= 0 ? (fields[emailIdx]?.replace(/['"]/g, '').trim() || '') : '',
            phoneIdx >= 0 ? (fields[phoneIdx]?.replace(/['"]/g, '').trim() || '') : '',
            notesIdx >= 0 ? (fields[notesIdx]?.replace(/['"]/g, '').trim() || '') : ''
          ]
        );
        imported++;
      } catch (rowErr) {
        errors.push(`Row ${i + 1}: ${rowErr.message}`);
      }
    }
    res.json({ imported, errors });
  } catch (err) {
    console.error('CSV import error:', err.message);
    res.status(500).json({ error: 'Failed to parse CSV', details: err.message });
  }
});

// --- Stripe Billing (legacy — retired in Session D7) ---
//
// These three routes were the original single-tenant billing flow:
//   POST /api/billing/create-checkout — created Stripe customer + checkout
//                                       session with hardcoded Pro price
//   GET  /api/billing/portal           — opened Stripe Customer Portal
//   POST /api/billing/webhook          — processed checkout.session.completed,
//                                       customer.subscription.updated/deleted
//                                       and updated users.plan to 'pro'/'free'
//
// All of them used the legacy `stripe` client (STRIPE_SECRET_KEY) and the
// legacy users.plan vocabulary ('free'/'pro'/'admin'). The new flow lives
// at /api/signup/create-checkout-session, /api/billing/portal-session, and
// /api/stripe/webhook (using `stripeSignup`, the new tier names, and
// workspaces.plan / workspaces.subscription_status as the source of truth).
//
// The handlers below stay registered (rather than being deleted) so that
// any caller — including a misconfigured Stripe Dashboard webhook still
// pointed at the old URL — gets an explanatory response instead of a 404
// the operator might mistake for a routing bug.
//
// To migrate Stripe Dashboard config: delete the webhook endpoint that
// points to /api/billing/webhook. Only /api/stripe/webhook should remain.
app.post('/api/billing/create-checkout', requireAuth, async (_req, res) => {
  return res.status(410).json({
    error: 'route_retired',
    message: 'This signup endpoint has been replaced. New signups go through /api/signup/create-checkout-session.',
  });
});

app.get('/api/billing/portal', requireAuth, async (_req, res) => {
  return res.status(410).json({
    error: 'route_retired',
    message: 'This billing portal endpoint has been replaced. Use POST /api/billing/portal-session instead.',
  });
});

// Stripe webhook — must use raw body (the app.use at the top of server.js
// already mounts express.raw for this path; preserved here for clarity).
app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (_req, res) => {
    // Acknowledge with 200 so Stripe doesn't retry indefinitely. Log a
    // warning so we know if the Stripe Dashboard is still routing events
    // to the legacy URL — that means the operator needs to delete the
    // legacy webhook config in Stripe.
    console.warn('[legacy billing webhook] Received event after retirement (D7). The Stripe Dashboard webhook config should point to /api/stripe/webhook only — delete the legacy endpoint there.');
    return res.status(200).json({ received: true, retired: true });
  }
);

// --- Debug: test endpoint to verify Sentry is receiving events ---
// Enabled when ENABLE_DEBUG_ENDPOINTS is any truthy-looking value.
// Protected by requireAuth so anonymous requests can't spam errors.
// After verifying Sentry captures the test event, unset the env var to disable.
//
// Session D8: hardened with an outer NODE_ENV !== 'production' guard so the
// route is unreachable in production even if ENABLE_DEBUG_ENDPOINTS is
// accidentally set there. Belt and suspenders.
const debugRaw = process.env.ENABLE_DEBUG_ENDPOINTS;
const debugEnabled = ['true', '1', 'yes', 'on'].includes(
  (debugRaw || '').trim().toLowerCase()
);
if (process.env.NODE_ENV !== 'production') {
  if (debugEnabled) {
    app.get('/api/debug/trigger-error', requireAuth, (_req, _res) => {
      throw new Error('Intentional Sentry test error at ' + new Date().toISOString());
    });
    console.log('Debug endpoints ENABLED: GET /api/debug/trigger-error');
  } else {
    console.log('Debug endpoints disabled (ENABLE_DEBUG_ENDPOINTS=' + JSON.stringify(debugRaw) + ')');
  }
} else {
  console.log('Debug endpoints disabled in production (NODE_ENV=production)');
}

// --- Sentry Express error handler ---
// Must be registered AFTER all routes but BEFORE our custom error handler.
// Sentry captures the exception, then the request continues through to our
// handler which returns the 500 response to the client.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// --- Global async error handler — wraps all async route handlers ---
// Catches any unhandled thrown error and returns a 500 instead of crashing the process
app.use((err, _req, res, _next) => {
  console.error('Unhandled route error:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// --- Catch unhandled promise rejections so the process never crashes ---
// Also forward to Sentry so these silent failures surface in the dashboard.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
});

// --- Health check endpoint so Render can verify the service is up ---
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- Start server immediately; run DB init in background with retry ---
// Render must see an open port quickly, and Neon's serverless DB can take a
// few seconds to warm up on cold starts. Retry the DB init rather than exit.
//
// Voice-AI prototype prep: create the http.Server explicitly instead of
// letting app.listen() do it, so a WebSocket server (Twilio
// ConversationRelay) can attach to the same underlying HTTP server / port
// in a later checkpoint. Behavior is identical to the previous
// app.listen(PORT) — same port, same startup log, same routes.
const server = http.createServer(app);

// --- Twilio ConversationRelay WebSocket handler (voice-AI prototype) ---
//
// Attached to the SAME http.Server as the Express app, on path
// /twilio-relay. The <ConversationRelay url="wss://<host>/twilio-relay"/>
// TwiML returned by /api/voice/relay-incoming causes Twilio to open a
// WebSocket here for each inbound call. Each connection is one call.
//
// Message shape (Twilio ConversationRelay protocol):
//   setup    — sent once at connect. { type, from, to, callSid, ... }
//   prompt   — one caller utterance transcribed. { type, voicePrompt, ... }
//   interrupt— caller talked over the AI. { type, ... }
//   dtmf     — keypad press (unused here). { type, digit, ... }
//
// AI replies are sent back as:
//   { type: 'text', token: '<what to say>', last: true }
//
// Per-call state (workspace, callSid, callerPhone) lives in the
// connection's closure — NOT global. No cross-call bleed possible.
//
// The prompt path delegates to lib/appointment-engine.processInboundMessage
// with channel:'voice' — the same booking brain the SMS route uses. That
// gives the voice AI the salon's real menu / knowledge / calendar and the
// ability to book, update, cancel, propose times, and escalate. The engine
// keeps per-caller memory in appointment_threads.context_summary (keyed by
// customer_phone), so no local conversation array is needed here. The
// executeAIResult voice-branch guard (in appointment-engine.js) skips the
// auto-SMS send when channel==='voice' — the reply is spoken live via the
// WS instead.
const { WebSocketServer } = require('ws');
// FD3-CP4: noServer — upgrades reach the WebSocket only after
// handleRelayUpgrade validates the per-workspace token in the path.
// Previously ANY upgrade on /twilio-relay was accepted with zero auth.
const wss = new WebSocketServer({ noServer: true });

// In-flight deploy grace: TwiML issued by the PREVIOUS deploy carries
// the bare legacy path. A call answered seconds before a deploy must
// still connect (and ConversationRelay reconnects after the restart),
// so the bare path is honored for a short window after each boot, then
// rejected forever. Tokened paths are validated against the workspace
// row; every rejection is a silent socket.destroy() — no status line,
// no reason, nothing to probe.
const RELAY_BOOT_TIME = Date.now();
const LEGACY_RELAY_GRACE_MS = 15 * 60 * 1000;
async function handleRelayUpgrade(req, socket, head) {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch (err) {
    socket.destroy();
    return;
  }
  const tokenMatch = pathname.match(/^\/twilio-relay\/v2\/([a-f0-9]{48})$/);
  if (tokenMatch) {
    try {
      const { rows } = await pool.query(
        'SELECT id FROM workspaces WHERE voice_relay_token = $1 LIMIT 1',
        [tokenMatch[1]]
      );
      if (rows.length) {
        // Remember which workspace this token belongs to so the setup
        // handler can refuse a cross-workspace 'to' number.
        req._relayWorkspaceId = rows[0].id;
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        return;
      }
    } catch (err) {
      console.error('[twilio-relay] token validation error:', err.message);
    }
    socket.destroy();
    return;
  }
  if (pathname === '/twilio-relay' && Date.now() - RELAY_BOOT_TIME < LEGACY_RELAY_GRACE_MS) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }
  socket.destroy();
}
server.on('upgrade', handleRelayUpgrade);

wss.on('connection', (ws, req) => {
  // Per-call closure state — replaced on every new connection.
  let workspace = null;
  let callSid = null;
  let callerPhone = null;
  // FD3-CP1: per-call transcript row + the engine thread this call used.
  let transcriptId = null;
  let lastThreadId = null;
  // FD3-CP2: once-per-call guards for the voice safety fallbacks.
  let emergencyAlerted = false;
  let callbackTaskCreated = false;

  // Strip Markdown/formatting characters so Twilio's TTS doesn't read them
  // aloud (e.g. ** would otherwise be spoken as "asterisk asterisk"). Only
  // removes formatting markers and tidies whitespace — never changes the
  // actual words. Applied inside sendText below so every spoken string
  // (engine replies and hardcoded fallbacks alike) is cleaned in one place.
  const stripSpeechMarkup = (text) => {
    if (text == null || typeof text !== 'string') return '';
    return text
      .replace(/[*_`~]/g, '')     // markdown emphasis + code + strikethrough markers
      .replace(/^#+\s*/gm, '')    // leading '#' header hashes at the start of any line
      .replace(/\s+/g, ' ')       // collapse runs of whitespace/newlines
      .trim();
  };

  const sendText = (token) => {
    try {
      ws.send(JSON.stringify({ type: 'text', token: stripSpeechMarkup(token), last: true }));
    } catch (err) {
      console.error('[twilio-relay] ws.send failed:', err && err.message);
    }
  };

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.error('[twilio-relay] bad JSON from Twilio:', err.message);
      return;
    }

    try {
      if (msg.type === 'setup') {
        callSid = msg.callSid || null;
        callerPhone = msg.from || null;
        try {
          const route = await lookupWorkspaceByTwilioNumber(msg.to);
          if (route) {
            const { rows } = await pool.query(
              `SELECT * FROM workspaces WHERE id = $1 LIMIT 1`,
              [route.workspace_id]
            );
            workspace = rows[0] || null;
          }
        } catch (lookupErr) {
          console.error('[twilio-relay] workspace lookup failed for setup:', lookupErr.message);
        }
        // FD3-CP4: a tokened connection is bound to ONE workspace. A
        // setup whose 'to' number resolves elsewhere (someone with a
        // valid token for workspace A probing workspace B) is closed,
        // not served.
        if (req && req._relayWorkspaceId && workspace && workspace.id !== req._relayWorkspaceId) {
          console.error('[twilio-relay] setup workspace mismatch: token=' + req._relayWorkspaceId + ' to-number=' + workspace.id + ' — closing');
          try { ws.close(); } catch (closeErr) { /* already gone */ }
          return;
        }
        const bizName = (workspace && workspace.business_name) || '(unknown business)';
        console.log('[twilio-relay] setup callSid=' + (callSid || 'unknown') + ' business=' + bizName + ' from=' + (callerPhone || '?'));
        // FD3-CP1: open the per-call transcript row immediately so even
        // a call dropped mid-sentence has its turns on record.
        if (workspace) {
          try {
            transcriptId = await voiceTranscript.beginCallTranscript(pool, {
              userId: workspace.owner_user_id,
              callSid,
              phone: callerPhone,
            });
          } catch (err) {
            console.error('[twilio-relay] transcript begin failed (call continues):', err.message);
          }
        }
        return;
      }

      if (msg.type === 'prompt') {
        const utterance = String(msg.voicePrompt || '').trim();
        if (!utterance) return;

        // The engine's thread lookup requires a phone or email. Without a
        // caller number, we can't route the turn — offer a callback and stop.
        if (!callerPhone) {
          sendText("I'm sorry, I'm having trouble identifying your number — let me have someone call you back.");
          return;
        }

        // FD3-CP1: persist the caller's turn before the model runs.
        try { await voiceTranscript.appendCallTurn(pool, transcriptId, 'Customer', utterance); } catch (err) { console.error('[twilio-relay] transcript append failed:', err.message); }

        // FD3-CP2 (delta sweep): the emergency keyword gate now covers
        // live voice — SMS and voicemail had it, voice did not. Flags
        // the call transcript and alerts the owner once per call; the
        // caller-facing flow is unchanged.
        if (!emergencyAlerted && workspace) {
          try {
            const matched = detectEmergency(utterance);
            if (matched.length && transcriptId) {
              emergencyAlerted = true;
              await pool.query('UPDATE messages SET emergency_flagged = TRUE WHERE id = $1', [transcriptId]);
              const rowR = await pool.query('SELECT * FROM messages WHERE id = $1', [transcriptId]);
              if (rowR.rows[0]) sendOwnerEmergencyAlert(workspace.owner_user_id, rowR.rows[0], matched);
            }
          } catch (err) {
            console.error('[twilio-relay] emergency gate failed (call continues):', err.message);
          }
        }

        const result = await appointmentEngine.processInboundMessage({
          workspace,
          contact: null,
          customer_phone: callerPhone,
          customer_email: null,
          channel: 'voice',
          body: utterance,
          db: pool,
          twilio: twilioClient,
          sendgrid: sgMail,
          env: process.env,
          logger: console,
        });
        if (result && result.thread_id) lastThreadId = result.thread_id;

        let spoken;
        if (result && result.handled && result.outbound_text) {
          spoken = result.outbound_text;
        } else if (result && result.handled) {
          // Engine handled the turn but produced no text to speak.
          spoken = "Sorry, I didn't catch that — could you say it again?";
        } else {
          console.log('[twilio-relay] engine did not handle: reason=' + ((result && result.reason) || 'unknown') + ' callSid=' + (callSid || 'unknown'));
          spoken = "Thanks for calling. Let me take a message and have someone get back to you.";
          // FD3-CP2 (delta sweep): the canned line used to be a lie —
          // no message was taken. Now a suggested callback task is
          // created once per call, so the promise is kept.
          if (!callbackTaskCreated && workspace) {
            callbackTaskCreated = true;
            try {
              await pool.query(
                'INSERT INTO tasks (user_id, title, category, "dueDate", notes, suggested, "aiReason") VALUES ($1, $2, $3, $4, $5, true, $6)',
                [workspace.owner_user_id,
                  'Return call from ' + (callerPhone || 'unknown number'),
                  'other',
                  new Date().toISOString().slice(0, 10),
                  'The AI answered a live call but could not handle it (auto-respond off or an error). The caller was told someone would get back to them.',
                  'Voice call fell through to the take-a-message line.']
              );
            } catch (err) {
              console.error('[twilio-relay] callback task failed:', err.message);
            }
          }
        }
        sendText(spoken);
        // FD3-CP1: persist what was actually said back.
        try { await voiceTranscript.appendCallTurn(pool, transcriptId, 'AI', spoken); } catch (err) { console.error('[twilio-relay] transcript append failed:', err.message); }
        return;
      }

      if (msg.type === 'interrupt') {
        console.log('[twilio-relay] interrupt callSid=' + (callSid || 'unknown'));
        return;
      }

      // Unknown message type — log and drop.
      console.log('[twilio-relay] unhandled message type=' + msg.type + ' callSid=' + (callSid || 'unknown'));
    } catch (err) {
      console.error('[twilio-relay] handler error callSid=' + (callSid || 'unknown') + ':', err && err.message);
      // Speak a graceful fallback so the caller isn't left in silence.
      sendText("Sorry, I'm having a little trouble — could you say that again?");
    }
  });

  ws.on('close', (code, reason) => {
    console.log('[twilio-relay] close callSid=' + (callSid || 'unknown') + ' code=' + code + ' reason=' + (reason ? reason.toString() : ''));
    // FD3-CP1: hangup — stamp the transcript (already persisted per
    // turn) and end the conversation. closeConversationThread is
    // idempotent, so close+error double-fires end it exactly once.
    if (transcriptId) {
      voiceTranscript.endCallTranscript(pool, transcriptId).catch((err) =>
        console.error('[twilio-relay] transcript end failed:', err.message));
      // IB1: the call row learns its conversation (and the thread's
      // contact) once the call is over — the WS closure held both ids.
      if (lastThreadId) {
        pool.query(
          `UPDATE messages SET thread_id = $1,
                  contact_id = (SELECT contact_id FROM appointment_threads WHERE id = $1)
            WHERE id = $2`,
          [lastThreadId, transcriptId]
        ).catch((err) => console.error('[twilio-relay] linkage stamp failed:', err.message));
      }
    }
    if (lastThreadId) closeConversationThread(lastThreadId, 'voice');
    transcriptId = null;
    lastThreadId = null;
    workspace = null;
    callSid = null;
    callerPhone = null;
  });

  ws.on('error', (err) => {
    console.error('[twilio-relay] ws error callSid=' + (callSid || 'unknown') + ':', err && err.message);
  });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

async function initDBWithRetry(attempt = 1) {
  try {
    await initDB();
  } catch (err) {
    console.error(`DB init attempt ${attempt} failed:`, err.message);
    if (attempt < 5) {
      const delay = Math.min(2000 * attempt, 10000);
      console.log(`Retrying DB init in ${delay}ms...`);
      setTimeout(() => initDBWithRetry(attempt + 1), delay);
    } else {
      console.error('DB init failed after 5 attempts. Routes that need the DB will return 500 until the DB is reachable.');
    }
    return;
  }

  // Session D8: file-based migration runner. Reads migrations/phase1-additive
  // and applies any not yet recorded in schema_migrations. Fail-loud: any
  // migration error halts startup with process.exit(1). Runs AFTER initDB()
  // so the legacy inline schema (CREATE TABLE IF NOT EXISTS, ALTERs via the
  // migrate() helper) is in place before the file-based deltas apply.
  try {
    const migrations = require('./lib/migrations');
    const result = await migrations.runPendingMigrations(pool);
    if (result.applied.length > 0) {
      console.log(`[migrations] Auto-applied: ${result.applied.join(', ')}`);
    }
  } catch (err) {
    console.error('[migrations] FATAL:', err.message);
    process.exit(1);
  }
}
initDBWithRetry();

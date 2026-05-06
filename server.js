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

// Session D3: subscription lifecycle event processors. Handle
// customer.subscription.updated, customer.subscription.deleted, and
// invoice.payment_failed so workspaces.subscription_status tracks
// Stripe's source-of-truth state instead of staying 'active' forever.
const subscriptionLifecycle = require('./lib/subscription-lifecycle');

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
app.use(session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
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
    'SELECT id FROM workspaces WHERE owner_user_id = $1 LIMIT 1',
    [req.session.userId]
  );
  req._workspaceId = rows[0]?.id ?? null;
  return req._workspaceId;
}

// --- Page routes ---
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/workspace');
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
  const area_code       = String(body.area_code || '').trim();
  const area_code_backup = String(body.area_code_backup || '').trim();
  const alert_phone     = String(body.alert_phone || '').trim();
  const billing         = String(body.billing || '');
  const plan            = String(body.plan || '');

  // Server-side re-validation (mirrors client regexes in views/signup.html).
  if (!/^[a-z0-9_]{3,30}$/.test(username))                  return res.status(400).json({ error: 'Invalid username format' });
  if (!password || password.length < 8)                     return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))            return res.status(400).json({ error: 'Invalid email' });
  if (!business_name || business_name.length > 100)         return res.status(400).json({ error: 'Business name is required (1-100 chars)' });
  if (!Number.isFinite(units) || units < 1 || units > 1000) return res.status(400).json({ error: 'Units must be a number between 1 and 1000' });
  const PROPERTY_TYPES = ['residential_apartment', 'condo', 'single_family', 'mixed_use', 'commercial'];
  if (!PROPERTY_TYPES.includes(property_type))              return res.status(400).json({ error: 'Invalid property type' });
  if (area_code && !/^[0-9]{3}$/.test(area_code))           return res.status(400).json({ error: 'Area code must be exactly 3 digits' });
  if (area_code_backup && !/^[0-9]{3}$/.test(area_code_backup)) return res.status(400).json({ error: 'Backup area code must be exactly 3 digits' });
  if (alert_phone && !/^\+1[0-9]{10}$/.test(alert_phone))   return res.status(400).json({ error: 'Alert phone must be +1 followed by 10 digits' });
  if (!['monthly', 'annual'].includes(billing))             return res.status(400).json({ error: 'Invalid billing cadence' });
  if (!['solo', 'team', 'enterprise'].includes(plan))       return res.status(400).json({ error: 'Invalid plan' });

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

  // Resolve Stripe price ID
  const lookup_key = `${plan}_${billing}`;
  let price_id;
  try {
    price_id = await getSignupPriceIdByLookupKey(lookup_key);
  } catch (err) {
    console.error('[signup-checkout] price lookup failed:', err.message);
    return res.status(500).json({ error: 'Pricing temporarily unavailable; please try again' });
  }

  // Persist the draft (do NOT log this row — draft_data has password_hash).
  try {
    await pool.query(
      'INSERT INTO signup_drafts (id, draft_data) VALUES ($1, $2::jsonb)',
      [draft_id, JSON.stringify({
        username, email, business_name, units, property_type,
        area_code, area_code_backup, alert_phone, billing, plan,
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

  // Session D3: optional 7-day trial gating. The flag is opt-in and
  // applies ONLY to the Solo plan — Team and Enterprise never receive
  // a trial regardless of the flag. The current signup form does not
  // pass `trial`, so behavior is unchanged for existing callers; a
  // future trial-CTA flow can pass `trial: true` to activate it.
  const wantsTrial = req.body && (req.body.trial === true || req.body.trial === 'true');
  const shouldApplyTrial = wantsTrial && plan === 'solo';

  const sessionConfig = {
    mode: 'subscription',
    line_items: [{ price: price_id, quantity: 1 }],
    customer_email: email,
    client_reference_id: draft_id,
    metadata: {
      draft_id,
      signup_username: username,
      signup_email: email,
    },
    success_url,
    cancel_url,
  };
  if (shouldApplyTrial) {
    sessionConfig.subscription_data = { trial_period_days: 7 };
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
        try {
          const result = await processCheckoutCompletedEvent(event, pool);
          console.log('[stripe-webhook] orchestrator result:', JSON.stringify(result));
        } catch (orchErr) {
          // Should not throw — processCheckoutCompletedEvent catches its own
          // errors and returns { ok: false }. But defensive in case of bug.
          console.error('[stripe-webhook] orchestrator threw unexpectedly:', orchErr.message);
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
      default:
        console.log('[stripe-webhook] event stored, no handler:', event.type, event.id);
    }
  } else {
    console.log('[stripe-webhook] received (not stored):', event.type, event.id);
  }

  res.json({ received: true });
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

    res.json({
      plan: planName,
      plan_display_name: planConfig.displayName,
      monthly_price: planConfig.monthlyPrice,
      subscription_status: planInfo.subscription_status || 'active',
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
  const open = ['/login', '/signup', '/sms/incoming', '/email/incoming', '/voice/incoming', '/voice/recording', '/voice/transcription', '/billing/webhook'];
  if (open.some(p => req.path === p)) return next();
  if (req.session && req.session.authenticated && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// --- Contacts ---
app.get('/api/contacts', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM contacts WHERE user_id=$1 ORDER BY name ASC', [req.session.userId]);
  res.json(rows);
});

app.post('/api/contacts', async (req, res) => {
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

app.put('/api/contacts/:id', async (req, res) => {
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

app.delete('/api/contacts/:id', async (req, res) => {
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
app.get('/api/tasks', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE user_id=$1 ORDER BY suggested DESC, "dueDate" ASC', [req.session.userId]);
  res.json(rows);
});

app.post('/api/tasks', async (req, res) => {
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

app.put('/api/tasks/:id', async (req, res) => {
  const { done, title, category, dueDate, notes } = req.body;
  const { rows } = await pool.query(
    'UPDATE tasks SET done=$1, title=$2, category=$3, "dueDate"=$4, notes=$5 WHERE id=$6 AND user_id=$7 RETURNING *',
    [done, title, category, dueDate, notes || '', Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  res.json(rows[0]);
});

app.put('/api/tasks/:id/approve', async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE tasks SET suggested=false WHERE id=$1 AND user_id=$2 RETURNING *',
    [Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  res.json(rows[0]);
});

app.delete('/api/tasks/:id/reject', async (req, res) => {
  await pool.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  res.json({ success: true });
});

app.delete('/api/tasks/:id', async (req, res) => {
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

app.get('/api/maintenance', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM maintenance_tickets WHERE user_id=$1 ORDER BY priority DESC, "createdAt" DESC',
    [req.session.userId]
  );
  res.json(rows);
});

app.post('/api/maintenance', async (req, res) => {
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

app.put('/api/maintenance/:id', async (req, res) => {
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

app.delete('/api/maintenance/:id', async (req, res) => {
  await pool.query('DELETE FROM maintenance_tickets WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  res.json({ success: true });
});

// --- Calendar Events ---
app.get('/api/calevents', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM cal_events WHERE user_id=$1 ORDER BY date ASC', [req.session.userId]);
  res.json(rows);
});

app.post('/api/calevents', async (req, res) => {
  const { date, title } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO cal_events (user_id, date, title) VALUES ($1,$2,$3) RETURNING *',
    [req.session.userId, date, title]
  );
  res.status(201).json(rows[0]);
});

app.delete('/api/calevents/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cal_events WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Event not found' });
  res.json({ success: true });
});

// --- Budget ---
app.get('/api/budget', async (req, res) => {
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

app.post('/api/budget', async (req, res) => {
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

app.delete('/api/budget/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM budget_transactions WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ success: true });
});

// --- Automation ---
app.get('/api/automation', async (req, res) => {
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
app.get('/api/messages', async (req, res) => {
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

app.get('/api/messages/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM messages WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  const msg = rows[0];
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

app.post('/api/messages', async (req, res) => {
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
    'INSERT INTO messages (user_id, resident, subject, category, text, status, folder) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.session.userId, resident, _subject || '(no subject)', category, text, 'new', 'inbox']
  );
  res.status(201).json(rows[0]);
});

app.put('/api/messages/:id/folder', async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE messages SET folder=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
    [req.body.folder, Number(req.params.id), req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json(rows[0]);
});

app.delete('/api/messages/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM messages WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rowCount) return res.status(404).json({ error: 'Message not found' });
  res.json({ success: true });
});

app.delete('/api/messages/folder/deleted', async (req, res) => {
  await pool.query("DELETE FROM messages WHERE folder='deleted' AND user_id=$1", [req.session.userId]);
  res.json({ success: true });
});

app.put('/api/messages/:id/status', async (req, res) => {
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
app.post('/api/generate', async (req, res) => {
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
    if (!action || !action.type) continue;
    const tool = registry.getTool(action.type);
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

  const knowledgeDocs = await getKnowledge(req.session.userId);
  const knowledgeSection = knowledgeDocs.length
    ? `\n## Property Policies & Procedures (Knowledge Base)\nThe property manager has provided the following policies, procedures, and reference documents. Treat these as authoritative. When drafting messages, answering questions, or taking actions, always follow the guidance here:\n\n${knowledgeDocs.map(d => `### ${d.title} (${d.type})\n${d.content}`).join('\n\n')}\n`
    : '';

  const contextSummary = `
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
  const vertical = _workspaceRow.vertical || 'property-management';
  const planForTools = planInfo && planInfo.plan ? planInfo.plan : null;
  const toolsForAI = registry.getAnthropicSchemaForPlan(vertical, planForTools);

  try {
    const response = await anthropic.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: `You are an AI command center assistant for a property management app called Modern Management.
You help property managers get things done by taking action within the app.

${contextSummary}

Today's date is ${new Date().toISOString().split('T')[0]}.

You have access to the following tools. Use them proactively when the user's intent is clear:
- add_calendar_event: schedule events and appointments
- delete_calendar_event: cancel/delete a calendar event by title (and optionally date)
- add_task: create tasks with categories and due dates
- update_task: change a task's status (mark done / pending), title, due date, category, or notes
- compose_message: draft and save messages to residents or contacts
- add_contact: add residents, vendors, or important contacts (including lease dates and monthly rent)
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

CRITICAL DISAMBIGUATION RULE for inventory tools: when the user references a property, unit, or contact by name, that name may match more than one record in the snapshot above (e.g., two properties both starting with "Riverside", or two contacts named "Maria"). NEVER guess or pick the first match. Before calling create_unit / update_unit / set_unit_off_market / retire_unit / assign_tenant_to_unit / move_tenant_to_unit / update_property / archive_property, scan the Properties / Units / Contacts sections of the snapshot. If a name is ambiguous, do NOT call the tool — instead reply with a clarifying question that lists the candidates (e.g., "Which Riverside — Riverside Lofts (#4) or Riverside North (#7)?"). Only call the tool once the user has clarified.

For READ questions about inventory ("what's vacant?", "who lives in Unit 3B?", "how many units at Glenwood?", "show my properties", "what's the occupancy rate at Glenwood?"), answer directly from the snapshot — do NOT call any tools.`,
      tools: toolsForAI,
      messages: [{ role: 'user', content: prompt }]
    });

    const actions = [];
    let reply = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        reply += block.text;
      } else if (block.type === 'tool_use') {
        actions.push({ type: block.name, ...block.input });
      }
    }

    if (!reply && actions.length) {
      reply = `Done! I've completed ${actions.length} action${actions.length > 1 ? 's' : ''} for you.`;
    }

    if (actions.length && response.stop_reason === 'tool_use') {
      // Session B2 mixed-mode dispatch:
      //   - Registered tools (lib/tools/*) execute server-side via
      //     tool.execute(action, ctx) and the AI sees real outcomes
      const ctx = {
        workspace: _workspaceRow,
        user: { id: req.session.userId },
        db: pool,
        logger: console,
        mailer: sgMail,            // SendGrid client (for late notices, etc.)
        sms: twilioClient,         // Twilio client (for late notices, emergency SMS)
        env: process.env,          // for TWILIO_PHONE_NUMBER, SENDGRID_FROM_EMAIL, MAINTENANCE_PHONE
        generateReportContent,     // Session B4: shared report-generation helper
      };

      const executionResults = [];
      for (const action of actions) {
        const tool = registry.getTool(action.type);
        if (!tool) {
          // Should never happen since the AI only sees registered tools,
          // but defensive: surface a clean error rather than crashing.
          executionResults.push({
            action,
            result: { success: false, message: `Unknown tool: ${action.type}` },
          });
          continue;
        }

        // Session C1: tools tagged requiresApproval are queued instead
        // of executed. The user must approve before the executor runs.
        if (tool.requiresApproval) {
          try {
            const summary = buildPendingActionSummary(action.type, action);
            const inserted = await pool.query(
              `INSERT INTO pending_actions (workspace_id, user_id, tool_name, input, ai_summary, status)
               VALUES ($1, $2, $3, $4, $5, 'pending')
               RETURNING id, tool_name, ai_summary, created_at`,
              [
                ctx.workspace.id,
                ctx.user.id,
                action.type,
                JSON.stringify(action),
                summary,
              ]
            );
            const pending = inserted.rows[0];
            executionResults.push({
              action,
              result: {
                success: true,
                queued: true,
                pendingId: pending.id,
                summary,
                message: `Queued for approval: ${summary}`,
                data: { pending_action_id: pending.id, tool_name: action.type },
              },
            });
          } catch (err) {
            console.error(`[command] Failed to queue ${action.type}:`, err);
            executionResults.push({
              action,
              result: { success: false, message: `Failed to queue action: ${err.message}` },
            });
          }
          continue;
        }

        try {
          const result = await tool.execute(action, ctx);
          executionResults.push({ action, result });
        } catch (err) {
          console.error(`[command] Tool ${action.type} threw:`, err);
          executionResults.push({
            action,
            result: { success: false, message: `Error executing ${action.type}: ${err.message}` },
          });
        }
      }

      const toolResults = executionResults.map(({ action, result }) => ({
        type: 'tool_result',
        tool_use_id: response.content.find(b => b.type === 'tool_use' && b.name === action.type)?.id || '',
        content: result.message || (result.success ? `Completed ${action.type}` : `Failed: ${action.type}`),
        is_error: !result.success,
      }));

      const followUp = await anthropic.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: 512,
        system: `You are an AI command center assistant for Modern Management. Be brief and friendly.`,
        tools: toolsForAI,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults }
        ]
      });

      const followText = followUp.content.find(b => b.type === 'text');
      if (followText) reply = followText.text;

      // Build action chips for the frontend — every chip reflects a real
      // server-side outcome since there is no client-side dispatch path.
      // Session C1: queued/pendingId/summary surface so the frontend can
      // render approve/reject buttons inline for requiresApproval tools.
      const actionChips = executionResults.map(({ action, result }) => ({
        type: action.type,
        success: result.success,
        message: result.message,
        data: result.data || null,
        queued: !!result.queued,
        pendingId: result.pendingId || null,
        summary: result.summary || null,
      }));

      const navigation = selectNavigation(executionResults, currentPage, registry);
      // Session D2: count this AI command toward the daily cap. Approval-
      // queued tools count too — the Anthropic API call itself is what
      // the daily cap is meant to limit. Best-effort: increment failures
      // are logged but never break the response.
      try {
        await usage.incrementAICommand(pool, {
          workspaceId: _workspaceRow.id,
          userId: req.session.userId,
        });
      } catch (err) {
        console.error('[command] Counter increment failed (non-fatal):', err.message);
      }
      return res.json({ reply: reply || 'Done!', actions: actionChips, navigation });
    }

    // Session D2: text-only AI reply (no tools called) still consumed
    // an Anthropic call; count it toward the daily cap.
    try {
      await usage.incrementAICommand(pool, {
        workspaceId: _workspaceRow.id,
        userId: req.session.userId,
      });
    } catch (err) {
      console.error('[command] Counter increment failed (non-fatal):', err.message);
    }
    res.json({ reply: reply || 'Done!', actions, navigation: null });
  } catch (err) {
    console.error('Command error:', err.message);
    res.status(500).json({ error: 'Command failed', details: err.message });
  }
});

// --- AI Task Suggestion ---
async function suggestTasksFromConversation(message, replyText, userId) {
  const today = new Date().toISOString().split('T')[0];
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

// sendOwnerEmergencyAlert: SMS to users.alert_phone first, fall back to
// email via SendGrid (notification_email or email), log + return if
// both are missing. Soft errors only — the message is already flagged
// in the DB; failure here means the owner finds out next time they
// open the inbox rather than instantly.
async function sendOwnerEmergencyAlert(userId, message, matchedKeywords) {
  try {
    const { rows } = await pool.query(
      'SELECT id, alert_phone, notification_email, email FROM users WHERE id = $1',
      [userId]
    );
    if (!rows.length) {
      console.error('[emergency-alert] No user row for userId=', userId);
      return;
    }
    const user = rows[0];
    const sender = (message.resident && String(message.resident).trim())
      || message.phone
      || message.email
      || '(no sender label)';
    const keywords = matchedKeywords.join(', ');
    const smsBody = `Modern Management URGENT: Message from ${sender} flagged for review (keywords: ${keywords}). Reply in app.`;

    const phone = (user.alert_phone || '').trim();
    if (phone) {
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone,
          body: smsBody,
        });
        console.log('[emergency-alert] SMS sent to', phone, 'for message', message.id);
        return;
      } catch (err) {
        console.error('[emergency-alert] SMS send failed:', err.message, '— falling back to email');
        // fall through
      }
    }

    const toEmail = (user.notification_email && user.notification_email.trim())
      || (user.email && user.email.trim())
      || '';
    if (toEmail) {
      try {
        await sgMail.send({
          to: toEmail,
          from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
          subject: 'URGENT: Tenant message flagged for review',
          text: smsBody + '\n\nMessage preview:\n' + String(message.text || '').slice(0, 500),
        });
        console.log('[emergency-alert] Email sent to', toEmail, 'for message', message.id);
        return;
      } catch (err) {
        console.error('[emergency-alert] Email send also failed:', err.message);
      }
    }

    console.error(
      '[emergency-alert] No alert_phone or email on file for userId=', userId,
      '— message', message.id, 'is flagged in the DB but owner not actively notified'
    );
  } catch (err) {
    console.error('[emergency-alert] Outer error:', err.message);
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
    } else if (message.phone) {
      await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: message.phone, body: draft });
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
      'INSERT INTO messages (user_id, resident, subject, category, text, status, folder, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [userId, resident, subject, 'email', text || '(No message body)', 'new', 'inbox', email]
    );
    if (rows[0]) {
      sendNotificationEmail(userId, rows[0]);

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
app.post('/api/email/send', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Missing to, subject, or body' });

  // Prefer user's connected account if available — replies appear from their real address
  if (req.session?.userId) {
    const { rows } = await pool.query('SELECT 1 FROM email_accounts WHERE user_id=$1', [req.session.userId]);
    if (rows.length) {
      const result = await sendViaConnectedAccount(req.session.userId, { to, subject, text: body });
      if (result.success) return res.json({ success: true, via: 'connected' });
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

app.post('/api/sms/incoming', async (req, res) => {
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
    'INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [userId, from, `SMS from ${from}`, 'sms', body, 'new', 'inbox', from]
  ).catch(err => { console.error('DB insert error:', err.message); return { rows: [] }; });

  if (rows[0]) {
    sendNotificationEmail(userId, rows[0]);

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
});

// --- Twilio: Send SMS reply ---
app.post('/api/sms/send', async (req, res) => {
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });
  try {
    const msg = await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body });
    res.json({ success: true, sid: msg.sid });
  } catch (err) {
    console.error('Twilio send error:', err.message);
    res.status(500).json({ error: 'Failed to send SMS', details: err.message });
  }
});

// --- Voice / Voicemail ---
app.post('/api/voice/incoming', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers.host}`;
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for calling Modern Management. Please leave your message after the beep and we will get back to you shortly.</Say>
  <Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="${base}/api/voice/transcription" action="${base}/api/voice/recording" />
</Response>`);
});

app.post('/api/voice/recording', async (req, res) => {
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
      `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone) VALUES ($1,$2,$3,$4,$5,'new','inbox',$6)`,
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

app.post('/api/voice/transcription', async (req, res) => {
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
  } catch (err) {
    console.error('Transcription update error:', err.message);
  }
  res.sendStatus(200);
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
async function buildReportSnapshot({ workspaceId, type, parameters }) {
  const snapshot = { type, generated_at: new Date().toISOString() };
  if (parameters) snapshot.parameters = parameters;

  // Workspace row (defensive: vertical column may not exist on this row)
  let ownerUserId = null;
  try {
    const ws = await pool.query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
    if (ws.rows[0]) {
      snapshot.workspace = { id: ws.rows[0].id, vertical: ws.rows[0].vertical || 'property-management' };
      ownerUserId = ws.rows[0].owner_user_id;
    } else {
      snapshot.workspace = { id: workspaceId };
    }
  } catch (e) {
    snapshot.workspace = { id: workspaceId };
  }

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
       WHERE user_id = $1 AND "dueDate" >= (NOW() - INTERVAL '30 days')::date::text
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
    model: config.ANTHROPIC_MODEL,
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
app.post('/api/report', async (req, res) => {
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
      `SELECT status FROM pending_actions WHERE id = $1 AND workspace_id = $2`,
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

  const noticeText = `Hi ${rent.resident},\n\nThis is a friendly reminder that your rent payment of $${Number(rent.amount).toFixed(2)} was due on ${rent.due_date} and has not been received.\n\nPlease submit your payment as soon as possible to avoid any late fees.\n\nIf you have already sent payment, please disregard this notice.\n\nThank you,\nThe Property Management Team`;

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
    } else if (contact?.phone) {
      const smsText = `Hi ${rent.resident}, your rent of $${Number(rent.amount).toFixed(2)} due ${rent.due_date} has not been received. Please pay ASAP. — Property Management`;
      await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to: contact.phone, body: smsText });
      sent = true;
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
app.post('/api/contacts/import', upload.single('file'), async (req, res) => {
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
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

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

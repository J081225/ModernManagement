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
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// SESSION_SECRET is required — refuse to start with a weak default
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set.');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 4000;
const BCRYPT_ROUNDS = 10;

app.use(cors());
// Raw body needed for Stripe webhook signature verification — must be before bodyParser
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
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
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
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
    'SELECT notification_email, notifications_enabled, twilio_phone_number, inbound_email_alias FROM users WHERE id=$1', [req.session.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

app.put('/api/settings', requireAuth, async (req, res) => {
  const { notification_email, notifications_enabled } = req.body;
  const { rows } = await pool.query(
    'UPDATE users SET notification_email=$1, notifications_enabled=$2 WHERE id=$3 RETURNING notification_email, notifications_enabled',
    [notification_email || '', notifications_enabled !== false, req.session.userId]
  );
  res.json(rows[0]);
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

// --- Tasks ---
app.get('/api/tasks', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tasks WHERE user_id=$1 ORDER BY suggested DESC, "dueDate" ASC', [req.session.userId]);
  res.json(rows);
});

app.post('/api/tasks', async (req, res) => {
  const { title, category, dueDate, notes, suggested, aiReason } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO tasks (user_id, title, category, "dueDate", notes, done, suggested, "aiReason") VALUES ($1,$2,$3,$4,$5,false,$6,$7) RETURNING *',
    [req.session.userId, title, category, dueDate, notes || '', suggested || false, aiReason || '']
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
  const { rows } = await pool.query(
    'INSERT INTO budget_transactions (user_id, type, category, description, amount, date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.session.userId, type, category, description || '', Number(amount), date, notes || '']
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

app.put('/api/automation', async (req, res) => {
  const autoReplyEnabled = !!req.body.autoReplyEnabled;
  await pool.query(
    'INSERT INTO automation (user_id, "autoReplyEnabled") VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET "autoReplyEnabled"=$2',
    [req.session.userId, autoReplyEnabled]
  );
  res.json({ autoReplyEnabled, managerReviewRequired: !autoReplyEnabled });
});

// --- Messages ---
app.get('/api/messages', async (req, res) => {
  const folder = req.query.folder || 'inbox';
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE user_id=$1 AND folder=$2 ORDER BY "createdAt" DESC',
    [req.session.userId, folder]
  );
  res.json(rows);
});

app.get('/api/messages/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM messages WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.session.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json(rows[0]);
});

app.post('/api/messages', async (req, res) => {
  const { resident, subject, category, text } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO messages (user_id, resident, subject, category, text, status, folder) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [req.session.userId, resident, subject, category, text, 'new', 'inbox']
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
      model: 'claude-opus-4-6',
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
app.post('/api/command', requireAuth, async (req, res) => {
  const { prompt, contacts, calEvents, tasks, messages: msgList, rentRecords, maintenanceTickets } = req.body;

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

### Open Maintenance Tickets
${maintenanceTickets && maintenanceTickets.length ? maintenanceTickets.filter(t => t.status === 'open').map(t => `- #${t.id}: ${t.title}${t.unit ? ` (Unit ${t.unit})` : ''} [${t.priority}]`).join('\n') : 'No open tickets.'}
`.trim();

  const tools = [
    {
      name: 'add_calendar_event',
      description: 'Add an event to the calendar',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format' }
        },
        required: ['title', 'date']
      }
    },
    {
      name: 'add_task',
      description: 'Create a new task in the task list',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          category: { type: 'string', enum: ['vendor', 'maintenance', 'lease', 'finance', 'other'] },
          dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
          notes: { type: 'string', description: 'Optional notes' }
        },
        required: ['title', 'category', 'dueDate']
      }
    },
    {
      name: 'compose_message',
      description: 'Compose and save a message to a resident or contact in the inbox',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient name (must match a contact name)' },
          subject: { type: 'string', description: 'Message subject' },
          body: { type: 'string', description: 'Full message body — write a complete, professional message' }
        },
        required: ['to', 'subject', 'body']
      }
    },
    {
      name: 'add_contact',
      description: 'Add a new contact (resident, vendor, or important person)',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Full name' },
          contact_type: { type: 'string', enum: ['resident', 'vendor', 'important'], description: 'Contact type' },
          unit: { type: 'string', description: 'Unit number (residents only)' },
          email: { type: 'string', description: 'Email address' },
          phone: { type: 'string', description: 'Phone number' },
          monthly_rent: { type: 'number', description: 'Monthly rent amount in dollars (residents only)' },
          lease_start: { type: 'string', description: 'Lease start date YYYY-MM-DD (residents only)' },
          lease_end: { type: 'string', description: 'Lease end date YYYY-MM-DD (residents only)' },
          notes: { type: 'string', description: 'Optional notes' }
        },
        required: ['name', 'contact_type']
      }
    },
    {
      name: 'mark_rent_paid',
      description: 'Mark a resident\'s rent as paid. Use the resident name and/or unit from the rent records.',
      input_schema: {
        type: 'object',
        properties: {
          resident: { type: 'string', description: 'Resident name (partial match ok)' },
          unit: { type: 'string', description: 'Unit number (optional, helps narrow down)' }
        },
        required: ['resident']
      }
    },
    {
      name: 'send_late_notice',
      description: 'Send a late payment notice to a resident who has not paid rent',
      input_schema: {
        type: 'object',
        properties: {
          resident: { type: 'string', description: 'Resident name (partial match ok)' },
          unit: { type: 'string', description: 'Unit number (optional)' }
        },
        required: ['resident']
      }
    },
    {
      name: 'add_budget_transaction',
      description: 'Log an income or expense transaction in the budget tracker',
      input_schema: {
        type: 'object',
        properties: {
          transaction_type: { type: 'string', enum: ['income', 'expense'], description: 'Income or expense' },
          category: { type: 'string', description: 'Category, e.g. Rent, Repairs, Utilities, Insurance, Landscaping' },
          description: { type: 'string', description: 'What the transaction is for' },
          amount: { type: 'number', description: 'Dollar amount (positive number)' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
          notes: { type: 'string', description: 'Optional notes' }
        },
        required: ['transaction_type', 'category', 'description', 'amount', 'date']
      }
    },
    {
      name: 'add_maintenance_ticket',
      description: 'Create a maintenance ticket for a repair or issue at the property',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Brief title of the issue' },
          description: { type: 'string', description: 'Full description of the problem' },
          unit: { type: 'string', description: 'Unit number where the issue is' },
          resident: { type: 'string', description: 'Resident name reporting the issue' },
          category: { type: 'string', enum: ['plumbing', 'electrical', 'hvac', 'appliance', 'structural', 'pest', 'general'], description: 'Issue category' }
        },
        required: ['title']
      }
    },
    {
      name: 'generate_rent',
      description: 'Generate monthly rent records for all residents who have a monthly rent amount set on their contact. Creates one pending record per resident.',
      input_schema: {
        type: 'object',
        properties: {
          month: { type: 'number', description: 'Month number 1-12' },
          year: { type: 'number', description: 'Four-digit year' },
          due_day: { type: 'number', description: 'Day of month rent is due (1-28, default 1)' }
        },
        required: ['month', 'year']
      }
    }
  ];

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: `You are an AI command center assistant for a property management app called Modern Management.
You help property managers get things done by taking action within the app.

${contextSummary}

Today's date is ${new Date().toISOString().split('T')[0]}.

You have access to the following tools. Use them proactively when the user's intent is clear:
- add_calendar_event: schedule events and appointments
- add_task: create tasks with categories and due dates
- compose_message: draft and save messages to residents or contacts
- add_contact: add residents, vendors, or important contacts (including lease dates and monthly rent)
- mark_rent_paid: mark a resident's rent as paid — match by name from the rent records
- send_late_notice: send a payment reminder to an unpaid resident
- add_budget_transaction: log income or expenses to the budget tracker
- add_maintenance_ticket: create maintenance/repair tickets
- generate_rent: create pending rent records for all residents for a given month

You can use multiple tools in one response if needed (e.g. "add Maria and generate May rent" → add_contact + generate_rent).
Always explain what you did clearly. For mark_rent_paid and send_late_notice, identify the closest matching resident from the rent records. If no match, say so.`,
      tools,
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
      const toolResults = actions.map(a => ({
        type: 'tool_result',
        tool_use_id: response.content.find(b => b.type === 'tool_use' && b.name === a.type)?.id || '',
        content: `Successfully executed ${a.type}`
      }));

      const followUp = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 512,
        system: `You are an AI command center assistant for Modern Management. Be brief and friendly.`,
        tools,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults }
        ]
      });

      const followText = followUp.content.find(b => b.type === 'text');
      if (followText) reply = followText.text;
    }

    res.json({ reply: reply || 'Done!', actions });
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
      model: 'claude-opus-4-6',
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
      model: 'claude-opus-4-6',
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
      model: 'claude-opus-4-6',
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
      const autoData = await getAutomation(userId);
      if (autoData.autoReplyEnabled) autoReplyToMessage(rows[0], userId);
      else suggestTasksFromConversation(rows[0], null, userId);
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
async function lookupUserByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE twilio_phone_number=$1 LIMIT 1',
    [phoneNumber]
  );
  return rows[0]?.id || null;
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

  const userId = await lookupUserByPhone(to);
  if (!userId) {
    console.warn(`Inbound SMS to unrecognized number ${to} from ${from} — dropped (no user match)`);
    return;
  }

  const { rows } = await pool.query(
    'INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [userId, from, `SMS from ${from}`, 'sms', body, 'new', 'inbox', from]
  ).catch(err => { console.error('DB insert error:', err.message); return { rows: [] }; });

  if (rows[0]) {
    sendNotificationEmail(userId, rows[0]);
    const autoData = await getAutomation(userId);
    if (autoData.autoReplyEnabled) autoReplyToMessage(rows[0], userId);
    else suggestTasksFromConversation(rows[0], null, userId);
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
  const userId = await lookupUserByPhone(To);
  if (!userId) {
    console.warn(`Voicemail to unrecognized number ${To} from ${phone} — dropped`);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Goodbye!</Say></Response>`);
    return;
  }
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
  const userId = await lookupUserByPhone(To);
  if (!userId) {
    console.warn(`Transcription for unrecognized number ${To} — dropped`);
    return res.sendStatus(200);
  }
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
      const autoData = await getAutomation(userId);
      if (autoData.autoReplyEnabled) await autoReplyToMessage(rows[0], userId);
      else suggestTasksFromConversation(rows[0], null, userId);
    }
  } catch (err) {
    console.error('Transcription update error:', err.message);
  }
  res.sendStatus(200);
});

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
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ report: response.content[0].text });
  } catch (err) {
    console.error('Report generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate report', details: err.message });
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

// --- Stripe Billing ---
app.post('/api/billing/create-checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const appUrl = process.env.APP_URL || 'https://modernmanagement.onrender.com';
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId]);
    const user = rows[0];
    // Reuse existing customer or create new
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { userId: String(user.id), username: user.username }
      });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [customerId, user.id]);
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
      success_url: `${appUrl}/workspace?upgraded=1`,
      cancel_url: `${appUrl}/workspace`,
      allow_promotion_codes: true,
      subscription_data: { trial_period_days: 14 }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
  }
});

app.get('/api/billing/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const appUrl = process.env.APP_URL || 'https://modernmanagement.onrender.com';
  try {
    const { rows } = await pool.query('SELECT stripe_customer_id FROM users WHERE id=$1', [req.session.userId]);
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'No billing account found' });
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/workspace`
    });
    res.json({ url: portal.url });
  } catch (err) {
    console.error('Stripe portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal', details: err.message });
  }
});

// Stripe webhook — must use raw body
app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.sendStatus(200);
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Stripe webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerId = session.customer;
        await pool.query(
          'UPDATE users SET plan=$1, stripe_subscription_id=$2 WHERE stripe_customer_id=$3',
          ['pro', session.subscription, customerId]
        );
        console.log('User upgraded to Pro:', customerId);
      } else if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        await pool.query(
          'UPDATE users SET plan=$1, stripe_subscription_id=$2 WHERE stripe_customer_id=$3',
          ['free', '', sub.customer]
        );
        console.log('User downgraded to free:', sub.customer);
      } else if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        const plan = sub.status === 'active' || sub.status === 'trialing' ? 'pro' : 'free';
        await pool.query(
          'UPDATE users SET plan=$1 WHERE stripe_customer_id=$2',
          [plan, sub.customer]
        );
      }
    } catch (err) {
      console.error('Stripe webhook handler error:', err.message);
    }
    res.sendStatus(200);
  }
);

// --- Debug: test endpoint to verify Sentry is receiving events ---
// Enabled when ENABLE_DEBUG_ENDPOINTS is any truthy-looking value.
// Protected by requireAuth so anonymous requests can't spam errors.
// After verifying Sentry captures the test event, unset the env var to disable.
const debugRaw = process.env.ENABLE_DEBUG_ENDPOINTS;
const debugEnabled = ['true', '1', 'yes', 'on'].includes(
  (debugRaw || '').trim().toLowerCase()
);
if (debugEnabled) {
  app.get('/api/debug/trigger-error', requireAuth, (_req, _res) => {
    throw new Error('Intentional Sentry test error at ' + new Date().toISOString());
  });
  console.log('Debug endpoints ENABLED: GET /api/debug/trigger-error');
} else {
  console.log('Debug endpoints disabled (ENABLE_DEBUG_ENDPOINTS=' + JSON.stringify(debugRaw) + ')');
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
  }
}
initDBWithRetry();

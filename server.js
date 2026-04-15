require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk').default;
const twilio = require('twilio');
const sgMail = require('@sendgrid/mail');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Stripe = require('stripe');
const { Pool } = require('pg');
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 4000;
const BCRYPT_ROUNDS = 10;
// User ID that receives all inbound webhooks (Twilio/SendGrid) — always the first admin account
const WEBHOOK_USER_ID = 1;

app.use(cors());
// Raw body needed for Stripe webhook signature verification — must be before bodyParser
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mm-session-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
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
app.get('/features/ai', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'ai.html')));
app.get('/features/inbox', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'inbox.html')));
app.get('/features/rent-and-leases', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'rent-and-leases.html')));
app.get('/features/broadcasts-and-contacts', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'features', 'broadcasts-and-contacts.html')));

// --- Database setup & migrations ---
// Safe migration helper — logs errors but never crashes the server
async function migrate(sql, label) {
  try {
    await pool.query(sql);
  } catch (err) {
    console.warn(`Migration skipped [${label}]:`, err.message);
  }
}

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
  // Ensure admin row exists
  await pool.query(`INSERT INTO automation (user_id, "autoReplyEnabled") VALUES (1, false) ON CONFLICT DO NOTHING`);

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
    'SELECT notification_email, notifications_enabled FROM users WHERE id=$1', [req.session.userId]
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
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, email, plan) VALUES ($1,$2,$3,$4) RETURNING *',
      [username.trim().toLowerCase(), hash, email || '', 'free']
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

// --- In-memory drafts & knowledge (not user-scoped, ephemeral) ---
let drafts = [];
let docs = [
  { id: 1, title: 'Renewal Guidelines', type: 'policy', content: 'Send 90-day renewal reminders; verify 30-day notice for rent increases.' },
  { id: 2, title: 'Maintenance Escalation', type: 'procedure', content: 'For emergency leaks, dispatch within 2 hours and notify resident within 30 min.' }
];

app.get('/api/drafts', (_req, res) => res.json(drafts));

app.post('/api/drafts', (req, res) => {
  const { messageId, content, status } = req.body;
  const id = drafts.length ? Math.max(...drafts.map(d => d.id)) + 1 : 1;
  drafts.push({ id, messageId, content, status: status || 'pending', createdAt: new Date().toISOString() });
  res.status(201).json(drafts[drafts.length - 1]);
});

app.put('/api/drafts/:id', (req, res) => {
  const draft = drafts.find(d => d.id === Number(req.params.id));
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  Object.assign(draft, req.body);
  res.json(draft);
});

app.get('/api/knowledge', (_req, res) => res.json(docs));
app.post('/api/knowledge', (req, res) => {
  const { title, type, content } = req.body;
  const id = docs.length ? Math.max(...docs.map(d => d.id)) + 1 : 1;
  const doc = { id, title, type, content };
  docs.push(doc);
  res.status(201).json(doc);
});
app.put('/api/knowledge/:id', (req, res) => {
  const doc = docs.find(d => d.id === Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Knowledge doc not found' });
  Object.assign(doc, req.body);
  res.json(doc);
});

app.post('/api/knowledge/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filename = req.file.originalname;
  const ext = path.extname(filename).toLowerCase();
  let content = '';
  try {
    if (ext === '.pdf') {
      const parsed = await pdfParse(req.file.buffer);
      content = parsed.text.trim();
    } else if (ext === '.txt') {
      content = req.file.buffer.toString('utf-8').trim();
    } else {
      return res.status(400).json({ error: 'Only PDF and TXT files are supported' });
    }
    const title = path.basename(filename, ext);
    const id = docs.length ? Math.max(...docs.map(d => d.id)) + 1 : 1;
    const doc = { id, title, type: 'uploaded', content };
    docs.push(doc);
    res.status(201).json(doc);
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

  const knowledgeContext = docs.length
    ? docs.map(d => `## ${d.title} (${d.type})\n${d.content}`).join('\n\n')
    : 'No company policies or procedures have been uploaded yet.';

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
app.post('/api/command', async (req, res) => {
  const { prompt, contacts, calEvents, tasks, messages: msgList, rentRecords, maintenanceTickets } = req.body;

  const contextSummary = `
## Current App State

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
    const knowledgeContext = docs.length
      ? docs.map(d => `## ${d.title} (${d.type})\n${d.content}`).join('\n\n')
      : 'No company policies uploaded.';

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
app.post('/api/email/incoming', upload.none(), async (req, res) => {
  const fromRaw = req.body.from || req.body.sender || 'Unknown';
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1] : fromRaw;
  const nameMatch = fromRaw.match(/^([^<]+)</);
  const resident = nameMatch ? nameMatch[1].trim() : email;
  const subject = req.body.subject || '(No subject)';
  const text = (req.body.text || req.body.html || '').replace(/<[^>]*>/g, '').trim();

  const { rows } = await pool.query(
    'INSERT INTO messages (user_id, resident, subject, category, text, status, folder, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [WEBHOOK_USER_ID, resident, subject, 'email', text || '(No message body)', 'new', 'inbox', email]
  );
  res.sendStatus(200);

  if (rows[0]) {
    sendNotificationEmail(WEBHOOK_USER_ID, rows[0]);
    const autoData = await getAutomation(WEBHOOK_USER_ID);
    if (autoData.autoReplyEnabled) autoReplyToMessage(rows[0], WEBHOOK_USER_ID);
    else suggestTasksFromConversation(rows[0], null, WEBHOOK_USER_ID);
  }
});

// --- SendGrid: Send Email ---
app.post('/api/email/send', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Missing to, subject, or body' });
  try {
    await sgMail.send({
      to,
      from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
      replyTo: process.env.SENDGRID_FROM_EMAIL,
      subject,
      text: body
    });
    res.json({ success: true });
  } catch (err) {
    console.error('SendGrid error:', err.message);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

// --- Twilio: Incoming SMS ---
app.post('/api/sms/incoming', async (req, res) => {
  const from = req.body.From || 'Unknown';
  const body = req.body.Body || '';
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const { rows } = await pool.query(
    'INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [WEBHOOK_USER_ID, from, `SMS from ${from}`, 'sms', body, 'new', 'inbox', from]
  ).catch(err => { console.error('DB insert error:', err.message); return { rows: [] }; });

  if (rows[0]) {
    sendNotificationEmail(WEBHOOK_USER_ID, rows[0]);
    const autoData = await getAutomation(WEBHOOK_USER_ID);
    if (autoData.autoReplyEnabled) autoReplyToMessage(rows[0], WEBHOOK_USER_ID);
    else suggestTasksFromConversation(rows[0], null, WEBHOOK_USER_ID);
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
  const { From, CallSid } = req.body;
  const phone = From || 'Unknown';
  try {
    await pool.query(
      `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone) VALUES ($1,$2,$3,$4,$5,'new','inbox',$6)`,
      [WEBHOOK_USER_ID, `Caller ${phone}`, `[CALLSID:${CallSid}] Voicemail from ${phone}`, 'voicemail', '📞 Voicemail received — transcription in progress...', phone]
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
  const { TranscriptionText, TranscriptionStatus, CallSid, From } = req.body;
  const phone = From || 'Unknown';
  const text = TranscriptionStatus === 'completed' && TranscriptionText
    ? `📞 Voicemail: "${TranscriptionText}"`
    : '📞 Voicemail received (transcription unavailable — check your Twilio recordings)';

  try {
    const { rows } = await pool.query(
      `UPDATE messages SET text=$1, subject=$2 WHERE user_id=$3 AND subject LIKE $4 RETURNING *`,
      [text, `Voicemail from ${phone}`, WEBHOOK_USER_ID, `[CALLSID:${CallSid}]%`]
    );
    if (rows.length) {
      sendNotificationEmail(WEBHOOK_USER_ID, rows[0]);
      const autoData = await getAutomation(WEBHOOK_USER_ID);
      if (autoData.autoReplyEnabled) await autoReplyToMessage(rows[0], WEBHOOK_USER_ID);
      else suggestTasksFromConversation(rows[0], null, WEBHOOK_USER_ID);
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

// --- Global async error handler — wraps all async route handlers ---
// Catches any unhandled thrown error and returns a 500 instead of crashing the process
app.use((err, _req, res, _next) => {
  console.error('Unhandled route error:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// --- Catch unhandled promise rejections so the process never crashes ---
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
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

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
const { Pool } = require('pg');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'mm-session-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Serve public static files (landing, login pages)
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// --- Auth helpers ---
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
function requireAuthPage(req, res, next) {
  if (req.session && req.session.authenticated) return next();
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
app.get('/workspace', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'app.html'));
});

// --- Login / Logout ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.ADMIN_USERNAME || 'admin';
  const validPass = process.env.ADMIN_PASSWORD || 'modernmgmt2026';
  if (username === validUser && password === validPass) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});
app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Protect all /api/* routes except login and inbound webhooks
app.use('/api', (req, res, next) => {
  const open = ['/login', '/sms/incoming', '/email/incoming', '/voice/incoming', '/voice/recording', '/voice/transcription'];
  if (open.some(p => req.path === p)) return next();
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

// --- PostgreSQL setup ---
pool.query(`
  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
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
`).then(async () => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM messages');
  if (rows[0].count === '0') {
    await pool.query(`INSERT INTO messages (resident, subject, category, text, status, folder) VALUES
      ('Alex Rivera', 'Maintenance: Leaky faucet', 'maintenance', 'My kitchen faucet is leaking and spraying water.', 'new', 'inbox'),
      ('Mira Chen', 'Renewal question', 'renewal', 'When should I confirm renewal terms?', 'new', 'inbox')`);
  }
}).catch(err => console.error('DB init error:', err.message));

// --- Contacts table ---
pool.query(`
  CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    name TEXT,
    type TEXT,
    unit TEXT,
    email TEXT,
    phone TEXT,
    notes TEXT
  )
`).then(async () => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM contacts');
  if (rows[0].count === '0') {
    await pool.query(`INSERT INTO contacts (name, type, unit, email, phone, notes) VALUES
      ('Alex Rivera', 'resident', '101', 'alex.rivera@email.com', '555-201-1111', 'Lease ends June 2026. Prefers email contact.'),
      ('Mira Chen', 'resident', '204', 'mira.chen@email.com', '555-201-2222', 'Has two pets. Renewal pending.'),
      ('Jordan Lee', 'resident', '305', 'jordan.lee@email.com', '555-201-3333', 'Monthly lease. Works night shifts.')`);
  }
}).catch(err => console.error('Contacts DB init error:', err.message));

app.get('/api/contacts', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM contacts ORDER BY name ASC');
  res.json(rows);
});

app.post('/api/contacts', async (req, res) => {
  const { name, type, unit, email, phone, notes } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO contacts (name, type, unit, email, phone, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [name, type, unit || '', email || '', phone || '', notes || '']
  );
  res.status(201).json(rows[0]);
});

app.delete('/api/contacts/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM contacts WHERE id=$1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Contact not found' });
  res.json({ success: true });
});

// --- Tasks table ---
pool.query(`
  CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    title TEXT,
    category TEXT,
    "dueDate" TEXT,
    notes TEXT,
    done BOOLEAN DEFAULT false
  )
`).then(async () => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM tasks');
  if (rows[0].count === '0') {
    await pool.query(`INSERT INTO tasks (title, category, "dueDate", notes, done) VALUES
      ('Alert vendors of insurance renewal', 'vendor', '2026-04-10', 'Contact AcePlumbing and GreenLawn before policy expires.', false),
      ('Follow up on lease renewals', 'lease', '2026-04-15', 'Alex Rivera and Mira Chen leases up in 60 days.', false)`);
  }
}).catch(err => console.error('Tasks DB init error:', err.message));

app.get('/api/tasks', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM tasks ORDER BY "dueDate" ASC');
  res.json(rows);
});
app.post('/api/tasks', async (req, res) => {
  const { title, category, dueDate, notes } = req.body;
  const { rows } = await pool.query('INSERT INTO tasks (title, category, "dueDate", notes, done) VALUES ($1,$2,$3,$4,false) RETURNING *', [title, category, dueDate, notes || '']);
  res.status(201).json(rows[0]);
});
app.put('/api/tasks/:id', async (req, res) => {
  const { done, title, category, dueDate, notes } = req.body;
  const { rows } = await pool.query('UPDATE tasks SET done=$1, title=$2, category=$3, "dueDate"=$4, notes=$5 WHERE id=$6 RETURNING *', [done, title, category, dueDate, notes || '', Number(req.params.id)]);
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  res.json(rows[0]);
});
app.delete('/api/tasks/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id=$1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
});

// --- Calendar Events table ---
pool.query(`
  CREATE TABLE IF NOT EXISTS cal_events (
    id SERIAL PRIMARY KEY,
    date TEXT,
    title TEXT
  )
`).then(async () => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM cal_events');
  if (rows[0].count === '0') {
    await pool.query(`INSERT INTO cal_events (date, title) VALUES
      ('2026-04-10', 'Maintenance inspection')`);
  }
}).catch(err => console.error('CalEvents DB init error:', err.message));

app.get('/api/calevents', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM cal_events ORDER BY date ASC');
  res.json(rows);
});
app.post('/api/calevents', async (req, res) => {
  const { date, title } = req.body;
  const { rows } = await pool.query('INSERT INTO cal_events (date, title) VALUES ($1,$2) RETURNING *', [date, title]);
  res.status(201).json(rows[0]);
});
app.delete('/api/calevents/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cal_events WHERE id=$1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Event not found' });
  res.json({ success: true });
});

// --- Budget Transactions table ---
pool.query(`
  CREATE TABLE IF NOT EXISTS budget_transactions (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    category TEXT,
    description TEXT,
    amount NUMERIC(10,2) NOT NULL,
    date TEXT,
    notes TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT NOW()
  )
`).then(async () => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM budget_transactions');
  if (rows[0].count === '0') {
    await pool.query(`INSERT INTO budget_transactions (type, category, description, amount, date, notes) VALUES
      ('income',  'Rent Received',  'Unit 101 — April rent',       1800.00, '2026-04-01', ''),
      ('income',  'Rent Received',  'Unit 204 — April rent',       1600.00, '2026-04-01', ''),
      ('income',  'Rent Received',  'Unit 305 — April rent',       1600.00, '2026-04-01', ''),
      ('income',  'Late Fee',       'Unit 305 late payment fee',    75.00,  '2026-04-03', ''),
      ('expense', 'Maintenance',    'Plumbing repair — Unit 101',  320.00,  '2026-04-02', 'AcePlumbing Co.'),
      ('expense', 'Landscaping',    'Monthly lawn care',           450.00,  '2026-04-01', 'GreenLawn Services'),
      ('expense', 'Utilities',      'Common area electricity',     210.00,  '2026-04-01', ''),
      ('expense', 'Insurance',      'Monthly property insurance',  380.00,  '2026-04-01', '')`);
  }
}).catch(err => console.error('Budget DB init error:', err.message));

app.get('/api/budget', async (req, res) => {
  const { month, year } = req.query;
  let q = 'SELECT * FROM budget_transactions';
  const params = [];
  if (month && year) {
    q += ` WHERE date LIKE $1`;
    params.push(`${year}-${String(month).padStart(2,'0')}%`);
  }
  q += ' ORDER BY date ASC, "createdAt" ASC';
  const { rows } = await pool.query(q, params);
  res.json(rows);
});

app.post('/api/budget', async (req, res) => {
  const { type, category, description, amount, date, notes } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO budget_transactions (type, category, description, amount, date, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [type, category, description || '', Number(amount), date, notes || '']
  );
  res.status(201).json(rows[0]);
});

app.delete('/api/budget/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM budget_transactions WHERE id=$1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Transaction not found' });
  res.json({ success: true });
});

let drafts = [];
let docs = [
  { id: 1, title: 'Renewal Guidelines', type: 'policy', content: 'Send 90-day renewal reminders; verify 30-day notice for rent increases.' },
  { id: 2, title: 'Maintenance Escalation', type: 'procedure', content: 'For emergency leaks, dispatch within 2 hours and notify resident within 30 min.' }
];
let automation = { autoReplyEnabled: false, managerReviewRequired: true };

// Persist automation in DB
pool.query(`CREATE TABLE IF NOT EXISTS automation (id INTEGER PRIMARY KEY, "autoReplyEnabled" BOOLEAN DEFAULT false)`)
  .then(async () => {
    const { rows } = await pool.query('SELECT * FROM automation WHERE id=1');
    if (rows.length) {
      automation.autoReplyEnabled = rows[0].autoReplyEnabled;
      automation.managerReviewRequired = !rows[0].autoReplyEnabled;
    } else {
      await pool.query('INSERT INTO automation (id, "autoReplyEnabled") VALUES (1, false)');
    }
  }).catch(err => console.error('Automation DB init error:', err.message));

app.get('/api/automation', (req, res) => res.json(automation));
app.put('/api/automation', async (req, res) => {
  const autoReplyEnabled = !!req.body.autoReplyEnabled;
  automation.autoReplyEnabled = autoReplyEnabled;
  automation.managerReviewRequired = !autoReplyEnabled;
  await pool.query('UPDATE automation SET "autoReplyEnabled"=$1 WHERE id=1', [autoReplyEnabled]);
  res.json(automation);
});

app.get('/api/messages', async (req, res) => {
  const folder = req.query.folder || 'inbox';
  const { rows } = await pool.query('SELECT * FROM messages WHERE folder=$1 ORDER BY "createdAt" DESC', [folder]);
  res.json(rows);
});

app.get('/api/messages/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM messages WHERE id=$1', [Number(req.params.id)]);
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json(rows[0]);
});

app.post('/api/messages', async (req, res) => {
  const { resident, subject, category, text } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO messages (resident, subject, category, text, status, folder) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [resident, subject, category, text, 'new', 'inbox']
  );
  res.status(201).json(rows[0]);
});

app.put('/api/messages/:id/folder', async (req, res) => {
  const { rows } = await pool.query('UPDATE messages SET folder=$1 WHERE id=$2 RETURNING *', [req.body.folder, Number(req.params.id)]);
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json(rows[0]);
});

app.delete('/api/messages/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM messages WHERE id=$1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Message not found' });
  res.json({ success: true });
});

app.delete('/api/messages/folder/deleted', async (_req, res) => {
  await pool.query("DELETE FROM messages WHERE folder='deleted'");
  res.json({ success: true });
});

app.put('/api/messages/:id/status', async (req, res) => {
  const { rows } = await pool.query('UPDATE messages SET status=$1 WHERE id=$2 RETURNING *', [req.body.status, Number(req.params.id)]);
  if (!rows.length) return res.status(404).json({ error: 'Message not found' });
  res.json(rows[0]);
});

app.get('/api/drafts', (req, res) => res.json(drafts));

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

app.get('/api/knowledge', (req, res) => res.json(docs));
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


app.post('/api/generate', async (req, res) => {
  const { messageId, contacts } = req.body;
  const { rows } = await pool.query('SELECT * FROM messages WHERE id=$1', [Number(messageId)]);
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
- If relevant contacts (vendors, staff) are mentioned, you may reference them by name
- Keep responses to 3-5 short paragraphs
- End with "Best regards,\\nThe Property Management Team"`,
      messages: [
        {
          role: 'user',
          content: `Please draft a response to this resident message:\n\nFrom: ${message.resident}\nSubject: ${message.subject}\nCategory: ${message.category}\n\nMessage:\n${message.text}`
        }
      ]
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

app.post('/api/command', async (req, res) => {
  const { prompt, contacts, calEvents, tasks, messages: msgList } = req.body;

  const contextSummary = `
## Current App State

### Contacts
${contacts && contacts.length ? contacts.map(c => `- ${c.name} (${c.type})${c.unit ? `, Unit ${c.unit}` : ''}${c.email ? `, ${c.email}` : ''}${c.phone ? `, ${c.phone}` : ''}`).join('\n') : 'No contacts.'}

### Calendar Events
${calEvents && calEvents.length ? calEvents.map(e => `- ${e.date}: ${e.title}`).join('\n') : 'No events.'}

### Tasks
${tasks && tasks.length ? tasks.map(t => `- [${t.done ? 'done' : 'pending'}] ${t.title} (due ${t.dueDate})`).join('\n') : 'No tasks.'}

### Inbox Messages
${msgList && msgList.length ? msgList.map(m => `- #${m.id}: From ${m.resident} — "${m.subject}" [${m.status}]`).join('\n') : 'No messages.'}
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
      description: 'Compose and send a message to a resident or contact',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient name' },
          subject: { type: 'string', description: 'Message subject' },
          body: { type: 'string', description: 'Full message body' }
        },
        required: ['to', 'subject', 'body']
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

When the user asks you to do something, use the available tools to carry out the action. Always explain what you did in a friendly, concise way. If you need to compose a message, write the full professional message body. If they ask a question, answer it directly using the context above.`,
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

    // If Claude used tools but gave no text, generate a confirmation
    if (!reply && actions.length) {
      reply = `Done! I've completed ${actions.length} action${actions.length > 1 ? 's' : ''} for you.`;
    }

    // If tools were used, get Claude's follow-up text response
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

// Helper: auto-generate and send AI reply for a message
async function autoReplyToMessage(message) {
  try {
    const knowledgeContext = docs.length
      ? docs.map(d => `## ${d.title} (${d.type})\n${d.content}`).join('\n\n')
      : 'No company policies uploaded.';

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: `You are a professional property management assistant. Draft concise, friendly, and helpful responses to resident messages on behalf of the property management team.\n\n${knowledgeContext}\n\nGuidelines:\n- Address the resident by first name\n- Be warm but professional\n- Keep responses to 3-5 short paragraphs\n- End with "Best regards,\\nThe Property Management Team"`,
      messages: [{ role: 'user', content: `Please draft a response to this message:\n\nFrom: ${message.resident}\nSubject: ${message.subject}\n\n${message.text}` }]
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
  } catch (err) {
    console.error('Auto-reply error:', err.message);
  }
}

// --- SendGrid: Incoming Email ---
app.post('/api/email/incoming', upload.none(), async (req, res) => {
  console.log('Incoming email fields:', JSON.stringify(Object.keys(req.body)));
  console.log('From:', req.body.from, '| Subject:', req.body.subject, '| Text length:', (req.body.text || '').length);

  const fromRaw = req.body.from || req.body.sender || 'Unknown';
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1] : fromRaw;
  const nameMatch = fromRaw.match(/^([^<]+)</);
  const resident = nameMatch ? nameMatch[1].trim() : email;

  const subject = req.body.subject || '(No subject)';
  const text = (req.body.text || req.body.html || '').replace(/<[^>]*>/g, '').trim();

  const { rows } = await pool.query('INSERT INTO messages (resident, subject, category, text, status, folder, email) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [resident, subject, 'email', text || '(No message body)', 'new', 'inbox', email]);
  res.sendStatus(200);

  if (automation.autoReplyEnabled && rows[0]) {
    autoReplyToMessage(rows[0]);
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

  const { rows } = await pool.query('INSERT INTO messages (resident, subject, category, text, status, folder, phone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [from, `SMS from ${from}`, 'sms', body, 'new', 'inbox', from]).catch(err => { console.error('DB insert error:', err.message); return { rows: [] }; });
  if (automation.autoReplyEnabled && rows[0]) {
    autoReplyToMessage(rows[0]);
  }
});

// --- Twilio: Send SMS reply ---
app.post('/api/sms/send', async (req, res) => {
  const { to, body } = req.body;
  if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });
  try {
    const msg = await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body
    });
    res.json({ success: true, sid: msg.sid });
  } catch (err) {
    console.error('Twilio send error:', err.message);
    res.status(500).json({ error: 'Failed to send SMS', details: err.message });
  }
});

// --- Voice / Voicemail ---

// Step 1: Twilio calls this when someone dials your number
app.post('/api/voice/incoming', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers.host}`;
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for calling Modern Management. Please leave your message after the beep and we will get back to you shortly.</Say>
  <Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="${base}/api/voice/transcription" action="${base}/api/voice/recording" />
</Response>`);
});

// Step 2: Called immediately when recording ends — save placeholder to inbox
app.post('/api/voice/recording', async (req, res) => {
  const { From, CallSid } = req.body;
  const phone = From || 'Unknown';
  try {
    await pool.query(
      `INSERT INTO messages (resident, subject, category, text, status, folder, phone) VALUES ($1,$2,$3,$4,'new','inbox',$5)`,
      [`Caller ${phone}`, `[CALLSID:${CallSid}] Voicemail from ${phone}`, 'voicemail', '📞 Voicemail received — transcription in progress...', phone]
    );
  } catch (err) {
    console.error('Voice recording save error:', err.message);
  }
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for your message. We will get back to you shortly. Goodbye!</Say>
</Response>`);
});

// Step 3: Called ~1-2 min later when Twilio finishes transcribing
app.post('/api/voice/transcription', async (req, res) => {
  const { TranscriptionText, TranscriptionStatus, CallSid, From } = req.body;
  const phone = From || 'Unknown';
  const text = TranscriptionStatus === 'completed' && TranscriptionText
    ? `📞 Voicemail: "${TranscriptionText}"`
    : '📞 Voicemail received (transcription unavailable — check your Twilio recordings)';

  try {
    // Update the placeholder message saved in step 2
    const { rows } = await pool.query(
      `UPDATE messages SET text=$1, subject=$2 WHERE subject LIKE $3 RETURNING *`,
      [text, `Voicemail from ${phone}`, `[CALLSID:${CallSid}]%`]
    );
    // If auto-reply is on, SMS the caller back
    if (rows.length && automation.autoReplyEnabled) {
      await autoReplyToMessage(rows[0]);
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

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

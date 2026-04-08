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
const Database = require('better-sqlite3');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage() });

// --- SQLite Database ---
const db = new Database('modernmanagement.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resident TEXT,
    subject TEXT,
    category TEXT,
    text TEXT,
    status TEXT DEFAULT 'new',
    folder TEXT DEFAULT 'inbox',
    email TEXT,
    phone TEXT,
    createdAt TEXT
  )
`);

// Seed sample messages if empty
const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get();
if (msgCount.c === 0) {
  const ins = db.prepare('INSERT INTO messages (resident, subject, category, text, status, folder, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('Alex Rivera', 'Maintenance: Leaky faucet', 'maintenance', 'My kitchen faucet is leaking and spraying water.', 'new', 'inbox', new Date().toISOString());
  ins.run('Mira Chen', 'Renewal question', 'renewal', 'When should I confirm renewal terms?', 'new', 'inbox', new Date().toISOString());
}

let drafts = [];
let docs = [
  { id: 1, title: 'Renewal Guidelines', type: 'policy', content: 'Send 90-day renewal reminders; verify 30-day notice for rent increases.' },
  { id: 2, title: 'Maintenance Escalation', type: 'procedure', content: 'For emergency leaks, dispatch within 2 hours and notify resident within 30 min.' }
];
let automation = { autoReplyEnabled: true, managerReviewRequired: true, model: 'claude-opus-4-6', rules: ['renewal', 'maintenance', 'availability'] };

app.get('/api/messages', (req, res) => {
  const folder = req.query.folder || 'inbox';
  const rows = db.prepare('SELECT * FROM messages WHERE folder = ? ORDER BY createdAt DESC').all(folder);
  res.json(rows);
});

app.get('/api/messages/:id', (req, res) => {
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id));
  if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json(message);
});

app.post('/api/messages', (req, res) => {
  const { resident, subject, category, text } = req.body;
  const result = db.prepare('INSERT INTO messages (resident, subject, category, text, status, folder, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(resident, subject, category, text, 'new', 'inbox', new Date().toISOString());
  const newMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(newMessage);
});

// Move message to a folder (inbox / archive / deleted)
app.put('/api/messages/:id/folder', (req, res) => {
  const { folder } = req.body;
  const result = db.prepare('UPDATE messages SET folder = ? WHERE id = ?').run(folder, Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Message not found' });
  res.json(db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id)));
});

// Permanently delete a single message
app.delete('/api/messages/:id', (req, res) => {
  const result = db.prepare('DELETE FROM messages WHERE id = ?').run(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Message not found' });
  res.json({ success: true });
});

// Empty all messages in deleted folder
app.delete('/api/messages/folder/deleted', (_req, res) => {
  db.prepare("DELETE FROM messages WHERE folder = 'deleted'").run();
  res.json({ success: true });
});

app.put('/api/messages/:id/status', (req, res) => {
  const result = db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(req.body.status, Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Message not found' });
  res.json(db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(req.params.id)));
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

app.get('/api/automation', (req, res) => res.json(automation));
app.put('/api/automation', (req, res) => {
  Object.assign(automation, req.body);
  res.json(automation);
});

app.post('/api/generate', async (req, res) => {
  const { messageId, contacts } = req.body;
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
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

// --- SendGrid: Incoming Email ---
app.post('/api/email/incoming', upload.none(), (req, res) => {
  console.log('Incoming email fields:', JSON.stringify(Object.keys(req.body)));
  console.log('From:', req.body.from, '| Subject:', req.body.subject, '| Text length:', (req.body.text || '').length);

  const fromRaw = req.body.from || req.body.sender || 'Unknown';
  const emailMatch = fromRaw.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1] : fromRaw;
  const nameMatch = fromRaw.match(/^([^<]+)</);
  const resident = nameMatch ? nameMatch[1].trim() : email;

  const subject = req.body.subject || '(No subject)';
  const text = (req.body.text || req.body.html || '').replace(/<[^>]*>/g, '').trim();

  db.prepare('INSERT INTO messages (resident, subject, category, text, status, folder, email, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(resident, subject, 'email', text || '(No message body)', 'new', 'inbox', email, new Date().toISOString());
  res.sendStatus(200);
});

// --- SendGrid: Send Email ---
app.post('/api/email/send', async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Missing to, subject, or body' });
  try {
    await sgMail.send({
      to,
      from: process.env.SENDGRID_FROM_EMAIL,
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
app.post('/api/sms/incoming', (req, res) => {
  const from = req.body.From || 'Unknown';
  const body = req.body.Body || '';
  db.prepare('INSERT INTO messages (resident, subject, category, text, status, folder, phone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(from, `SMS from ${from}`, 'sms', body, 'new', 'inbox', from, new Date().toISOString());
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

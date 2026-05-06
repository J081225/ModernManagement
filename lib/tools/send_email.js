// lib/tools/send_email.js
//
// Real outbound email via SendGrid. Persists the sent email in the
// messages table.
//
// Schema reality check: messages columns are (user_id, resident, subject,
//   category, text, status, folder, email, phone, "createdAt"). The
//   spec's `sender`/`body`/`channel`/`direction` columns don't exist —
//   we use `resident`/`text`/`category` and store status='sent' in
//   folder='inbox' (same pattern the auto-reply path uses on outbound
//   mutations).
//
// SendGrid pattern matches send_late_notice.js exactly:
//   from = { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' }
//   replyTo = ctx.env.SENDGRID_FROM_EMAIL  (so replies route back to the workspace)
// requiresApproval=true: never executes until the user clicks Approve.
const registry = require('../tool-registry');

registry.register({
  name: 'send_email',
  description: 'Send a real email to a contact via SendGrid. Identify the recipient by name (fuzzy-matched against the contact list). Use this when the user wants to email someone — e.g., "email the property accountant the Q3 budget summary" or "send an email to John about the lease renewal." For replies to existing inbox emails, use reply_to_message instead. Requires approval before sending.',
  vertical: 'core',
  category: 'external-facing',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Name of the contact to send the email to. Fuzzy matched against the contact list.' },
      subject: { type: 'string', description: 'Email subject line.' },
      body: { type: 'string', description: 'Email body content. Plain text or basic markdown.' }
    },
    required: ['to', 'subject', 'body']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    const { to, subject, body } = input;
    if (!to || !subject || !body) {
      return { success: false, message: 'Missing required fields: to, subject, body.' };
    }

    const matches = await ctx.db.query(
      `SELECT * FROM contacts WHERE user_id = $1 AND LOWER(name) LIKE $2 ORDER BY name LIMIT 5`,
      [ctx.user.id, `%${to.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No contact found matching "${to}".` };
    }
    const recipient = matches.rows[0];
    if (!recipient.email || !String(recipient.email).trim()) {
      return { success: false, message: `${recipient.name} has no email address on file. Add an email first, or use send_sms instead if they have a phone number.` };
    }

    let sentMsgId = null;
    try {
      const result = await ctx.mailer.send({
        to: recipient.email,
        from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
        replyTo: ctx.env.SENDGRID_FROM_EMAIL,
        subject,
        text: body,
        html: body.replace(/\n/g, '<br>')
      });
      sentMsgId = Array.isArray(result) && result[0] && result[0].headers && result[0].headers['x-message-id'];
    } catch (err) {
      ctx.logger.error('[send_email] SendGrid error:', err.message);
      return { success: false, message: `SendGrid failed to send: ${err.message}` };
    }

    let savedId = null;
    try {
      const saved = await ctx.db.query(
        `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, email)
         VALUES ($1, $2, $3, 'email', $4, 'sent', 'inbox', $5)
         RETURNING id`,
        [ctx.user.id, recipient.name, subject, body, recipient.email]
      );
      savedId = saved.rows[0].id;
    } catch (err) {
      ctx.logger.error('[send_email] Failed to record sent message (email still went out):', err.message);
    }

    return {
      success: true,
      data: { recipient: recipient.name, email: recipient.email, channel: 'email', subject, message_id: savedId, sendgrid_message_id: sentMsgId || null },
      message: `Sent email to ${recipient.name} (${recipient.email}) — "${subject}"`
    };
  }
});

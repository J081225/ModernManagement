// lib/tools/reply_to_message.js
//
// Replies to an existing inbound message. Auto-detects channel (SMS or
// email) from the original message's `category` column. Looks up the
// sender's contact for the actual phone/email and sends via Twilio or
// SendGrid. Persists the reply as an outbound row.
//
// Schema reality check: messages columns (user_id, resident, subject,
//   category, text, status, folder, email, phone, "createdAt"). There's
//   no `direction` column; inbound rows live in folder='inbox' with
//   status='new' or 'read'. Outbound replies are written as separate
//   rows with status='sent' (we do NOT mutate the original — keeps
//   history intact).
//
// Channel detection: original.category is the canonical source. Values
// observed in the schema include 'sms' and 'email' (set by the inbound
// webhook handlers) plus task-categories like 'maintenance' / 'general'
// for legacy seeded rows. Maintenance/general fall back to email.
//
// requiresApproval=true: queue first, fire only on Approve.
const registry = require('../tool-registry');

registry.register({
  name: 'reply_to_message',
  description: 'Reply to an existing inbox message. The user identifies which message to reply to by sender name, partial subject, or description; the tool fuzzy-matches against recent inbound messages. The channel (SMS or email) is auto-detected from the original message — replies to texts go via SMS, replies to emails go via email. Use this for any reply context: "reply to Maria saying we\'ll send a plumber Tuesday" or "reply to the noise complaint email saying we\'ve spoken with the unit upstairs." Requires approval before sending.',
  vertical: 'core',
  category: 'external-facing',
  schema: {
    type: 'object',
    properties: {
      message_reference: { type: 'string', description: 'Identifier for the message to reply to. Can be a sender name ("Maria"), a partial subject, or a brief description of the message ("the noise complaint from last week"). Fuzzy-matched against recent inbox messages.' },
      body: { type: 'string', description: 'The reply body content.' },
      subject: { type: 'string', description: 'Optional. New subject for the reply (defaults to "Re: <original subject>").' }
    },
    required: ['message_reference', 'body']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    const { message_reference, body, subject } = input;
    if (!message_reference || !body) {
      return { success: false, message: 'Missing required fields: message_reference and body.' };
    }

    // Match recent inbound messages: fuzzy on resident (sender),
    // subject, or text body. Inbound rows are anything in the inbox
    // folder that hasn't been marked 'sent'.
    const matches = await ctx.db.query(
      `SELECT * FROM messages
       WHERE user_id = $1
         AND folder = 'inbox' AND status != 'sent'
         AND (LOWER(COALESCE(resident, '')) LIKE $2
              OR LOWER(COALESCE(subject, '')) LIKE $2
              OR LOWER(COALESCE(text, '')) LIKE $2)
       ORDER BY id DESC LIMIT 10`,
      [ctx.user.id, `%${message_reference.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No inbound message found matching "${message_reference}". Check the inbox for the message you want to reply to.` };
    }
    const original = matches.rows[0];

    // Determine channel from the original's category. SMS rows are
    // explicitly 'sms'; legacy/email rows include 'email', 'general',
    // 'maintenance', 'renewal', etc. — anything non-SMS replies via email.
    const channel = original.category === 'sms' ? 'sms' : 'email';

    // Resolve the sender's contact for the outbound address. Prefer
    // the email/phone stored on the original row if present (set by
    // the SMS/email webhooks), and fall back to a contact lookup by
    // name otherwise.
    let toPhone = original.phone || null;
    let toEmail = original.email || null;
    let contactName = original.resident || 'Unknown';

    if ((channel === 'sms' && !toPhone) || (channel === 'email' && !toEmail)) {
      const contactMatch = await ctx.db.query(
        `SELECT * FROM contacts WHERE user_id = $1 AND LOWER(name) LIKE $2 LIMIT 1`,
        [ctx.user.id, `%${(original.resident || '').toLowerCase()}%`]
      );
      if (contactMatch.rows.length === 0) {
        return { success: false, message: `Original message is from "${original.resident}" but no matching contact found. Add ${original.resident} to your contacts first.` };
      }
      const contact = contactMatch.rows[0];
      contactName = contact.name;
      if (channel === 'sms') toPhone = contact.phone || toPhone;
      if (channel === 'email') toEmail = contact.email || toEmail;
    }

    if (channel === 'sms' && !toPhone) {
      return { success: false, message: `Cannot reply via SMS — ${contactName} has no phone number on file.` };
    }
    if (channel === 'email' && !toEmail) {
      return { success: false, message: `Cannot reply via email — ${contactName} has no email address on file.` };
    }

    const replySubject = subject
      || (original.subject
            ? (original.subject.startsWith('Re:') ? original.subject : `Re: ${original.subject}`)
            : `Re: your message`);

    try {
      if (channel === 'sms') {
        await ctx.sms.messages.create({
          from: ctx.env.TWILIO_PHONE_NUMBER,
          to: toPhone,
          body
        });
      } else {
        await ctx.mailer.send({
          to: toEmail,
          from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
          replyTo: ctx.env.SENDGRID_FROM_EMAIL,
          subject: replySubject,
          text: body,
          html: body.replace(/\n/g, '<br>')
        });
      }
    } catch (err) {
      ctx.logger.error('[reply_to_message] Send failed:', err.message);
      return { success: false, message: `Failed to send reply: ${err.message}` };
    }

    let savedId = null;
    try {
      if (channel === 'sms') {
        const saved = await ctx.db.query(
          `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone)
           VALUES ($1, $2, $3, 'sms', $4, 'sent', 'inbox', $5)
           RETURNING id`,
          [ctx.user.id, contactName, replySubject, body, toPhone]
        );
        savedId = saved.rows[0].id;
      } else {
        const saved = await ctx.db.query(
          `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, email)
           VALUES ($1, $2, $3, 'email', $4, 'sent', 'inbox', $5)
           RETURNING id`,
          [ctx.user.id, contactName, replySubject, body, toEmail]
        );
        savedId = saved.rows[0].id;
      }
    } catch (err) {
      ctx.logger.error('[reply_to_message] Failed to record sent reply:', err.message);
    }

    const channelDisplay = channel === 'sms' ? `SMS (${toPhone})` : `email (${toEmail})`;
    return {
      success: true,
      data: { recipient: contactName, channel, message_id: savedId, original_message_id: original.id },
      message: `Replied to ${contactName} via ${channelDisplay}: "${body.length > 80 ? body.slice(0, 77) + '...' : body}"`
    };
  }
});

// lib/tools/send_sms.js
//
// Real outbound SMS via Twilio. Writes the sent message to the messages
// table so the user has a record in the inbox view.
//
// Schema reality check (matches the messages table actually defined in
// server.js, NOT the column names suggested in the C3 spec):
//   columns are (user_id, resident, subject, category, text, status,
//                folder, email, phone, "createdAt").
//   - `resident` = recipient name (legacy column name)
//   - `text` = body
//   - `category` = channel encoding ('sms' here)
//   - `status='sent'` + `folder='inbox'` = mirrors how the auto-reply
//     path marks outbound mutations on existing rows
//
// Twilio pattern matches send_late_notice.js: from = TWILIO_PHONE_NUMBER.
// requiresApproval=true: never executes until the user clicks Approve.
const registry = require('../tool-registry');

registry.register({
  name: 'send_sms',
  description: 'Send a real SMS text message to a contact via Twilio. Identify the recipient by name (fuzzy-matched against the contact list). Use this when the user wants to text someone — e.g., "send Maria a text saying we\'ll send a plumber Tuesday at 10am" or "text the electrician to confirm Friday at 9". The AI should NOT use this for replies to existing inbox messages (use reply_to_message for that). Requires approval before sending.',
  vertical: 'core',
  category: 'external-facing',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Name of the contact (resident, vendor, or other) to send the SMS to. Use fuzzy matching against the contact list.' },
      body: { type: 'string', description: 'The full text of the SMS message. Keep concise — SMS works best under 160 characters.' }
    },
    required: ['to', 'body']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    const { to, body } = input;
    if (!to || !body) {
      return { success: false, message: 'Missing required fields: to (recipient name) and body (message text).' };
    }

    const matches = await ctx.db.query(
      `SELECT * FROM contacts WHERE user_id = $1 AND LOWER(name) LIKE $2 ORDER BY name LIMIT 5`,
      [ctx.user.id, `%${to.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No contact found matching "${to}". Add the contact first or check the spelling.` };
    }
    const recipient = matches.rows[0];
    if (!recipient.phone || !String(recipient.phone).trim()) {
      return { success: false, message: `${recipient.name} has no phone number on file. Add a phone number first, or use send_email instead if they have an email address.` };
    }

    let sentSid = null;
    try {
      const result = await ctx.sms.messages.create({
        from: ctx.env.TWILIO_PHONE_NUMBER,
        to: recipient.phone,
        body
      });
      sentSid = result && result.sid;
    } catch (err) {
      ctx.logger.error('[send_sms] Twilio error:', err.message);
      return { success: false, message: `Twilio failed to send: ${err.message}` };
    }

    let savedId = null;
    try {
      const subject = `SMS to ${recipient.name}`;
      const saved = await ctx.db.query(
        `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone)
         VALUES ($1, $2, $3, 'sms', $4, 'sent', 'inbox', $5)
         RETURNING id`,
        [ctx.user.id, recipient.name, subject, body, recipient.phone]
      );
      savedId = saved.rows[0].id;
    } catch (err) {
      ctx.logger.error('[send_sms] Failed to record sent message (SMS still went out):', err.message);
    }

    return {
      success: true,
      data: { recipient: recipient.name, phone: recipient.phone, channel: 'sms', message_id: savedId, twilio_sid: sentSid },
      message: `Sent SMS to ${recipient.name} (${recipient.phone}): "${body.length > 80 ? body.slice(0, 77) + '...' : body}"`
    };
  }
});

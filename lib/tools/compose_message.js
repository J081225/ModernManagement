// lib/tools/compose_message.js
//
// messages schema: (user_id, resident, subject, category, text, status,
//   folder, phone, ...). user_id-scoped. The legacy applyActions
//   dispatcher used category='general' on AI-composed messages — match
//   that here.
//
// Session A behavior preserved: subject is optional; if omitted, derive
// from the first ~50 chars of body, trimmed at the nearest word boundary.
const registry = require('../tool-registry');

registry.register({
  name: 'compose_message',
  description: 'Compose and save a message to a resident or contact in the inbox.',
  vertical: 'core',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient name (must match a contact name).' },
      subject: { type: 'string', description: 'Optional. Message subject. If omitted, a sensible subject is derived from the first words of the body.' },
      body: { type: 'string', description: 'Full message body — write a complete, professional message.' }
    },
    required: ['to', 'body']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    const { to, body } = input;
    if (!to || !body) {
      return { success: false, message: 'Missing required fields: to and body.' };
    }
    let subject = (input.subject && String(input.subject).trim()) || '';
    if (!subject) {
      const oneLine = String(body).replace(/\s+/g, ' ').trim();
      if (oneLine.length <= 50) {
        subject = oneLine;
      } else {
        const cut = oneLine.slice(0, 50);
        const lastSpace = cut.lastIndexOf(' ');
        subject = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '...';
      }
    }
    const result = await ctx.db.query(
      `INSERT INTO messages (user_id, resident, subject, category, text, status, folder)
       VALUES ($1, $2, $3, $4, $5, 'new', 'inbox')
       RETURNING *`,
      [ctx.user.id, to, subject || '(no subject)', 'general', body]
    );
    return {
      success: true,
      data: result.rows[0],
      message: `Composed message to ${to}: "${subject}"`
    };
  }
});

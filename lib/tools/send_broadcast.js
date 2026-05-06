// lib/tools/send_broadcast.js
//
// Sends the same SMS or email to many recipients in one approved batch.
// Audience parsing is intentionally simple for C3:
//   - default / "everyone" / "all residents" → contacts.type='resident'
//   - "vendor"/"vendors" → contacts.type='vendor'
//   - "staff" → contacts.type='staff'
//   - if the audience string mentions a property name (fuzzy substring),
//     the recipient set is narrowed to residents currently engaged with
//     a unit in that property (engagements + offerings + entities join).
// Per-recipient persistence: each delivery writes its own row to
// messages so the user has a record of every send. Failures are
// reported in the message but the tool reports success if at least
// one recipient went out.
//
// Schema reality check: messages columns (user_id, resident, subject,
//   category, text, status, folder, email, phone, "createdAt"). We use
//   `resident`=recipient name, `text`=body, `category`=channel encoding.
//
// requiresApproval=true: ALL of the broadcast queues until the user
// approves. The buildPendingActionSummary chip shows audience + channel
// + body preview so the user can reject if the audience is unexpectedly
// large.
const registry = require('../tool-registry');

registry.register({
  name: 'send_broadcast',
  description: 'Send the same message to multiple recipients at once. Used for property-wide announcements like "tell all residents the parking lot will be repaved Saturday" or "email everyone in Sunset Heights about the new gym hours." The audience parameter is natural language that the executor parses to find matching contacts. Channel is required (sms or email). For email broadcasts, subject is required; for SMS broadcasts, subject is ignored. Requires approval before sending — the queued chip will show how many recipients will receive the message, so the user can reject if the count is unexpectedly large.',
  vertical: 'property-management',
  category: 'external-facing',
  schema: {
    type: 'object',
    properties: {
      audience: { type: 'string', description: 'Who to send to. Free-text natural language: "all residents", "all residents in Sunset Heights", "everyone in unit 3", "all vendors". Defaults to all residents if blank.' },
      channel: { type: 'string', enum: ['sms', 'email'], description: 'Delivery channel. Required.' },
      subject: { type: 'string', description: 'Subject line (used for email; ignored for SMS).' },
      body: { type: 'string', description: 'The message body to send to everyone in the audience.' }
    },
    required: ['channel', 'body']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    const { audience, channel, subject, body } = input;
    if (!channel || !body) {
      return { success: false, message: 'Missing required fields: channel and body.' };
    }
    if (!['sms', 'email'].includes(channel)) {
      return { success: false, message: `Invalid channel: ${channel}. Use 'sms' or 'email'.` };
    }
    if (channel === 'email' && !subject) {
      return { success: false, message: 'Email broadcasts require a subject line.' };
    }

    const aud = (audience || '').toLowerCase();
    let recipientType = 'resident';
    if (aud.includes('vendor')) recipientType = 'vendor';
    else if (aud.includes('staff')) recipientType = 'staff';

    let recipientsQuery = `SELECT * FROM contacts WHERE user_id = $1 AND type = $2`;
    const params = [ctx.user.id, recipientType];

    let propertyFilter = null;
    if (recipientType === 'resident' && audience) {
      const props = await ctx.db.query(
        `SELECT id, name FROM entities WHERE workspace_id = $1 AND archived_at IS NULL`,
        [ctx.workspace.id]
      );
      for (const p of props.rows) {
        if (p.name && aud.includes(p.name.toLowerCase())) {
          propertyFilter = p;
          break;
        }
      }
    }

    if (propertyFilter) {
      recipientsQuery = `
        SELECT DISTINCT c.* FROM contacts c
        JOIN engagements eng ON eng.contact_id = c.id
        JOIN offerings o ON o.id = eng.offering_id
        WHERE c.user_id = $1 AND c.type = $2
          AND eng.workspace_id = $3 AND eng.status = 'active'
          AND o.entity_id = $4
      `;
      params.push(ctx.workspace.id, propertyFilter.id);
    }

    recipientsQuery += ` ORDER BY name`;
    const recipientsResult = await ctx.db.query(recipientsQuery, params);
    const recipients = recipientsResult.rows;

    if (recipients.length === 0) {
      return {
        success: false,
        message: `No recipients matched audience "${audience || 'all residents'}".`
      };
    }

    const channelField = channel === 'sms' ? 'phone' : 'email';
    const sendable = recipients.filter(r => r[channelField] && String(r[channelField]).trim());
    const skipped = recipients.length - sendable.length;
    if (sendable.length === 0) {
      return {
        success: false,
        message: `Found ${recipients.length} recipient(s) but none have a ${channel === 'sms' ? 'phone number' : 'email address'} on file.`
      };
    }

    let succeeded = 0;
    const failures = [];
    for (const r of sendable) {
      try {
        if (channel === 'sms') {
          await ctx.sms.messages.create({
            from: ctx.env.TWILIO_PHONE_NUMBER,
            to: r.phone,
            body
          });
        } else {
          await ctx.mailer.send({
            to: r.email,
            from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
            replyTo: ctx.env.SENDGRID_FROM_EMAIL,
            subject,
            text: body,
            html: body.replace(/\n/g, '<br>')
          });
        }
        try {
          if (channel === 'sms') {
            await ctx.db.query(
              `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone)
               VALUES ($1, $2, $3, 'sms', $4, 'sent', 'inbox', $5)`,
              [ctx.user.id, r.name, subject || `Broadcast (SMS)`, body, r.phone]
            );
          } else {
            await ctx.db.query(
              `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, email)
               VALUES ($1, $2, $3, 'email', $4, 'sent', 'inbox', $5)`,
              [ctx.user.id, r.name, subject, body, r.email]
            );
          }
        } catch (e) {
          ctx.logger.error('[send_broadcast] Failed to record message for', r.name, e.message);
        }
        succeeded++;
      } catch (err) {
        ctx.logger.error('[send_broadcast] Failed to send to', r.name, err.message);
        failures.push({ name: r.name, error: err.message });
      }
    }

    let summary = `Broadcast sent to ${succeeded} recipient${succeeded !== 1 ? 's' : ''} via ${channel.toUpperCase()}`;
    if (skipped > 0) summary += ` (${skipped} skipped — no ${channel === 'sms' ? 'phone' : 'email'})`;
    if (failures.length > 0) summary += ` (${failures.length} failed: ${failures.slice(0, 3).map(f => f.name).join(', ')}${failures.length > 3 ? '...' : ''})`;

    return {
      success: succeeded > 0,
      data: {
        channel,
        total_attempted: sendable.length,
        succeeded,
        skipped,
        failed: failures.length,
        audience_summary: propertyFilter ? `${recipientType}s in ${propertyFilter.name}` : `all ${recipientType}s`
      },
      message: summary
    };
  }
});

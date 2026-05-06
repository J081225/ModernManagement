// lib/tools/send_late_notice.js
//
// External-facing tool: actually contacts the resident via SendGrid
// (email) or Twilio SMS. Mirrors the body of POST /api/rent/:id/late-notice.
// The dependencies (sgMail, twilioClient, env) are passed via ctx so the
// executor stays leaf — no direct require of server.js modules.
//
// Behavior parity:
//   - Fuzzy-match the resident's most recent non-paid rent record.
//   - Look up contact by name OR unit.
//   - Email if contact has email, else SMS if contact has phone.
//   - Update rent status to 'late' if not already paid/late.
const registry = require('../tool-registry');

registry.register({
  name: 'send_late_notice',
  description: 'Send a late payment notice to a resident who has not paid rent.',
  vertical: 'property-management',
  category: 'external-facing',
  schema: {
    type: 'object',
    properties: {
      resident: { type: 'string', description: 'Resident name (partial match ok).' },
      unit: { type: 'string', description: 'Unit number (optional).' }
    },
    required: ['resident']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    const { resident, unit } = input;
    if (!resident) {
      return { success: false, message: 'No resident name provided.' };
    }
    // Find the matching unpaid rent record (any non-paid status).
    let query = `
      SELECT * FROM rent_payments
      WHERE user_id = $1 AND status != 'paid' AND LOWER(resident) LIKE $2
    `;
    const params = [ctx.user.id, `%${resident.toLowerCase()}%`];
    if (unit) {
      query += ` AND LOWER(unit) = $3`;
      params.push(unit.toLowerCase());
    }
    query += ` ORDER BY due_date ASC LIMIT 1`;
    const rentMatches = await ctx.db.query(query, params);
    if (rentMatches.rows.length === 0) {
      return {
        success: false,
        message: `No unpaid rent record found for "${resident}"${unit ? ` in unit ${unit}` : ''}.`
      };
    }
    const rent = rentMatches.rows[0];

    // Look up the contact for email/phone routing.
    const contactRows = await ctx.db.query(
      `SELECT * FROM contacts
       WHERE user_id = $1 AND (LOWER(name) LIKE LOWER($2) OR unit = $3)
       LIMIT 1`,
      [ctx.user.id, `%${rent.resident}%`, rent.unit || '']
    );
    const contact = contactRows.rows[0];

    const noticeText = `Hi ${rent.resident},\n\nThis is a friendly reminder that your rent payment of $${Number(rent.amount).toFixed(2)} was due on ${rent.due_date} and has not been received.\n\nPlease submit your payment as soon as possible to avoid any late fees.\n\nIf you have already sent payment, please disregard this notice.\n\nThank you,\nThe Property Management Team`;

    let channel = 'none';
    let sent = false;
    try {
      if (contact && contact.email) {
        await ctx.mailer.send({
          to: contact.email,
          from: { name: 'Modern Management', email: 'noreply@modernmanagementapp.com' },
          replyTo: ctx.env.SENDGRID_FROM_EMAIL,
          subject: `Rent Payment Reminder — Unit ${rent.unit || ''}`,
          text: noticeText,
        });
        channel = 'email';
        sent = true;
      } else if (contact && contact.phone) {
        const smsText = `Hi ${rent.resident}, your rent of $${Number(rent.amount).toFixed(2)} due ${rent.due_date} has not been received. Please pay ASAP. — Property Management`;
        await ctx.sms.messages.create({
          from: ctx.env.TWILIO_PHONE_NUMBER,
          to: contact.phone,
          body: smsText,
        });
        channel = 'sms';
        sent = true;
      }
      if (rent.status !== 'late') {
        await ctx.db.query(
          `UPDATE rent_payments SET status = 'late' WHERE id = $1 AND user_id = $2`,
          [rent.id, ctx.user.id]
        );
      }
      if (!sent) {
        return {
          success: false,
          message: `Found unpaid rent for ${rent.resident} but no contact email or phone on file. Marked as late but no notice sent.`
        };
      }
      return {
        success: true,
        data: { id: rent.id, resident: rent.resident, unit: rent.unit, channel },
        message: `Sent late notice to ${rent.resident}${rent.unit ? ` (Unit ${rent.unit})` : ''} via ${channel}.`
      };
    } catch (err) {
      ctx.logger.error('[send_late_notice] Send failed:', err.message);
      return {
        success: false,
        message: `Failed to send late notice to ${rent.resident}: ${err.message}`
      };
    }
  }
});

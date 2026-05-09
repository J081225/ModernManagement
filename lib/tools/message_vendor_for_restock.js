// lib/tools/message_vendor_for_restock.js
//
// Drafts a restock message to a vendor and queues for approval (the
// pending_actions flow from C1, identical to send_sms / send_email).
// requiresApproval: true — Sarah taps approve in the UI before the SMS
// or email actually goes out.
//
// Channel preference: SMS if vendor has phone, else email if email,
// else fail with explanation.
//
// At AI-call time the queue summary built by buildPendingActionSummary
// in server.js shows: "message_vendor_for_restock: <args>". The actual
// drafting happens at execute time — when approve fires, the executor
// runs and either calls Twilio or SendGrid based on what's available.

const registry = require('../tool-registry');

registry.register({
  name: 'message_vendor_for_restock',
  description: 'Draft and send a restock message to a vendor. SMS if the vendor has a phone, otherwise email if they have an email. Requires the owner to approve before the message is sent. Use when inventory items run low or out and need reordering.',
  vertical: 'professional-services',
  category: 'external-facing',
  schema: {
    type: 'object',
    properties: {
      vendor_id_or_name: { type: 'string', description: 'Vendor name (fuzzy match) or numeric id.' },
      inventory_item_ids: {
        type: 'array',
        description: 'Inventory item ids that need restocking. Their names are inserted into the message body.',
        items: { type: 'integer' },
      },
      additional_message: { type: 'string', description: 'Optional free-text addendum from the owner.' },
    },
    required: ['vendor_id_or_name'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    const ref = String(input.vendor_id_or_name || '').trim();
    if (!ref) return { success: false, message: 'vendor_id_or_name is required.' };

    // Resolve vendor
    let vendor = null;
    const asInt = parseInt(ref, 10);
    if (Number.isInteger(asInt) && String(asInt) === ref) {
      const r = await ctx.db.query(
        `SELECT * FROM vendors WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [asInt, ctx.workspace.id]
      );
      vendor = r.rows[0] || null;
      if (!vendor) return { success: false, message: `No active vendor #${asInt} in this workspace.` };
    } else {
      const matches = await ctx.db.query(
        `SELECT * FROM vendors
          WHERE workspace_id = $1 AND archived_at IS NULL
            AND LOWER(name) LIKE $2
          ORDER BY name LIMIT 5`,
        [ctx.workspace.id, '%' + ref.toLowerCase() + '%']
      );
      if (matches.rows.length === 0) {
        return { success: false, message: `No vendor matching "${ref}".` };
      }
      if (matches.rows.length > 1) {
        const list = matches.rows.map(m => `#${m.id} ${m.name}`).join(', ');
        return { success: false, message: `Multiple vendors match "${ref}": ${list}. Specify which (use the id).` };
      }
      vendor = matches.rows[0];
    }

    // Pick channel
    const channel = vendor.contact_phone ? 'sms'
      : vendor.contact_email ? 'email'
      : null;
    if (!channel) {
      return { success: false, message: `${vendor.name} has no phone or email on file. Add contact info before sending restock messages.` };
    }
    const recipient = channel === 'sms' ? vendor.contact_phone : vendor.contact_email;

    // Compose message body from inventory items
    let itemList = '';
    if (Array.isArray(input.inventory_item_ids) && input.inventory_item_ids.length > 0) {
      const ids = input.inventory_item_ids
        .map(x => parseInt(x, 10))
        .filter(Boolean);
      if (ids.length > 0) {
        const r = await ctx.db.query(
          `SELECT id, name, quantity, unit FROM inventory_items
            WHERE id = ANY($1::int[]) AND workspace_id = $2 AND archived_at IS NULL`,
          [ids, ctx.workspace.id]
        );
        if (r.rows.length > 0) {
          itemList = r.rows
            .map(it => `- ${it.name}${it.quantity != null ? ' (current: ' + it.quantity + (it.unit ? ' ' + it.unit : '') + ')' : ''}`)
            .join('\n');
        }
      }
    }

    const businessName = ctx.workspace.business_name || ctx.workspace.name || 'our shop';
    const itemsBlock = itemList
      ? `\n\nThe following items are running low or out:\n${itemList}\n\n`
      : '\n\n';
    const userAddendum = input.additional_message ? String(input.additional_message).trim() + '\n\n' : '';
    const body = `Hi ${vendor.name},${itemsBlock}${userAddendum}Could you let us know your availability for a restock? Thanks!\n\n— ${businessName}`;

    // Send (this fires after approval; the queue is handled by /api/command's
    // pending_actions interception based on requiresApproval=true).
    try {
      if (channel === 'sms') {
        await ctx.sms.messages.create({
          from: ctx.workspace.twilio_phone_number || ctx.env.TWILIO_PHONE_NUMBER,
          to: recipient,
          body,
        });
      } else {
        await ctx.mailer.send({
          to: recipient,
          from: { name: businessName, email: 'noreply@modernmanagementapp.com' },
          replyTo: ctx.env.SENDGRID_FROM_EMAIL,
          subject: `Restock request from ${businessName}`,
          text: body,
          html: body.replace(/\n/g, '<br>'),
        });
      }
    } catch (err) {
      ctx.logger.error('[message_vendor_for_restock] send failed:', err.message);
      return { success: false, message: `Failed to send to ${vendor.name}: ${err.message}` };
    }

    // Persist as an outbound message row (mirrors C3 send_sms/send_email).
    let savedId = null;
    try {
      if (channel === 'sms') {
        const saved = await ctx.db.query(
          `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, phone)
           VALUES ($1, $2, $3, 'sms', $4, 'sent', 'inbox', $5)
           RETURNING id`,
          [ctx.user.id, vendor.name, `Restock request to ${vendor.name}`, body, recipient]
        );
        savedId = saved.rows[0].id;
      } else {
        const saved = await ctx.db.query(
          `INSERT INTO messages (user_id, resident, subject, category, text, status, folder, email)
           VALUES ($1, $2, $3, 'email', $4, 'sent', 'inbox', $5)
           RETURNING id`,
          [ctx.user.id, vendor.name, `Restock request from ${businessName}`, body, recipient]
        );
        savedId = saved.rows[0].id;
      }
    } catch (err) {
      ctx.logger.error('[message_vendor_for_restock] message persist failed (send already happened):', err.message);
    }

    return {
      success: true,
      data: { vendor_id: vendor.id, vendor_name: vendor.name, channel, message_id: savedId },
      message: `Sent restock request to ${vendor.name} via ${channel.toUpperCase()} (${recipient}).`,
    };
  },
});

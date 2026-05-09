// lib/tools/add_vendor.js
//
// Create a vendor (supplier) for the workspace. Vendors are workspace-scoped
// — distinct from contacts (which are user_id-scoped legacy). At least one
// of phone/email/url is recommended; if all three are blank, we still
// allow it but flag in the message so Sarah knows to fill in later.

const registry = require('../tool-registry');

registry.register({
  name: 'add_vendor',
  description: 'Add a vendor (supplier) to the workspace. Provide name and at least one contact channel (phone, email, or URL) for restock messaging to work.',
  vertical: 'professional-services',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      contact_phone: { type: 'string' },
      contact_email: { type: 'string' },
      contact_url: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['name'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const name = String(input.name || '').trim();
    if (!name) return { success: false, message: 'name is required.' };
    const phone = input.contact_phone ? String(input.contact_phone).trim() : null;
    const email = input.contact_email ? String(input.contact_email).trim() : null;
    const url = input.contact_url ? String(input.contact_url).trim() : null;

    try {
      const r = await ctx.db.query(
        `INSERT INTO vendors
           (workspace_id, name, contact_phone, contact_email, contact_url, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name`,
        [ctx.workspace.id, name, phone, email, url, input.notes || null]
      );
      const out = r.rows[0];
      const noContact = !phone && !email && !url;
      const warn = noContact ? ' (no contact info — add phone, email, or URL before sending restock messages)' : '';
      return {
        success: true,
        data: { vendor_id: out.id, name: out.name },
        message: `Added vendor: ${out.name}${warn}.`,
      };
    } catch (err) {
      ctx.logger.error('[add_vendor] insert failed:', err.message);
      return { success: false, message: `Could not add vendor: ${err.message}` };
    }
  },
});

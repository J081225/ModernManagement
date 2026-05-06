// lib/tools/add_contact.js
//
// The contacts table column is named `type` (not `contact_type`); the
// AI tool schema uses `contact_type` to be clearer to the model.
// The executor maps input.contact_type → the `type` column.
const registry = require('../tool-registry');

registry.register({
  name: 'add_contact',
  description: 'Add a new contact to the workspace. Contacts include residents, vendors, staff, and important professional contacts. Captures name, type, optional contact info, and (for residents) lease details.',
  vertical: 'core',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Full name of the contact.' },
      contact_type: { type: 'string', enum: ['resident', 'vendor', 'important'], description: 'Type of contact.' },
      unit: { type: 'string', description: 'Optional. Unit number/name if a resident.' },
      email: { type: 'string', description: 'Optional.' },
      phone: { type: 'string', description: 'Optional.' },
      monthly_rent: { type: 'number', description: 'Optional. Monthly rent amount in dollars (residents only).' },
      lease_start: { type: 'string', description: 'Optional. Lease start date YYYY-MM-DD (residents only).' },
      lease_end: { type: 'string', description: 'Optional. Lease end date YYYY-MM-DD (residents only).' },
      notes: { type: 'string', description: 'Optional.' }
    },
    required: ['name', 'contact_type']
  },
  navigationPolicy: 'home_only',
  navigateTo: { page: 'contacts', focus: { type: 'newest_contact' } },
  async execute(input, ctx) {
    const { name, contact_type, unit, email, phone, monthly_rent, lease_start, lease_end, notes } = input;
    if (!name || !contact_type) {
      return { success: false, message: 'Missing required fields: name and contact_type.' };
    }
    const result = await ctx.db.query(
      `INSERT INTO contacts (user_id, name, type, unit, email, phone, notes, lease_start, lease_end, monthly_rent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        ctx.user.id,
        name,
        contact_type,
        unit || '',
        email || '',
        phone || '',
        notes || '',
        lease_start || '',
        lease_end || '',
        Number(monthly_rent) || 0,
      ]
    );
    return {
      success: true,
      data: result.rows[0],
      message: `Added contact: ${name} (${contact_type})`,
      navigateHint: { page: 'contacts', focus: { type: 'newest_contact' } }
    };
  }
});

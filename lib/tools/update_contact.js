// lib/tools/update_contact.js
//
// The DB column is `type`, not `contact_type`. AI input is mapped
// accordingly. monthly_rent is stored as a numeric; coerce on input.
const registry = require('../tool-registry');

registry.register({
  name: 'update_contact',
  description: "Update an existing contact (resident, vendor, staff, or other). Use this for changes like updating a phone number, email, lease dates, monthly rent, unit assignment, or notes. The user identifies the contact by name. Use fuzzy matching against the contact list in context.",
  vertical: 'core',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      contact: { type: 'string', description: 'Name or partial name identifying the contact.' },
      name: { type: 'string', description: 'Optional. New name.' },
      contact_type: { type: 'string', description: 'Optional. New type (resident, vendor, staff, important).' },
      email: { type: 'string', description: 'Optional.' },
      phone: { type: 'string', description: 'Optional.' },
      unit: { type: 'string', description: 'Optional.' },
      monthly_rent: { type: 'number', description: 'Optional.' },
      lease_start: { type: 'string', description: 'Optional. YYYY-MM-DD.' },
      lease_end: { type: 'string', description: 'Optional. YYYY-MM-DD.' },
      notes: { type: 'string', description: 'Optional.' }
    },
    required: ['contact']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { contact } = input;
    if (!contact) {
      return { success: false, message: 'No contact identifier provided.' };
    }
    const matches = await ctx.db.query(
      `SELECT * FROM contacts WHERE user_id = $1 AND LOWER(name) LIKE $2 ORDER BY name ASC LIMIT 5`,
      [ctx.user.id, `%${contact.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No contact found matching "${contact}".` };
    }
    const target = matches.rows[0];
    // Map AI input field names → DB column names. The AI uses
    // `contact_type` for clarity; the DB column is `type`.
    const fieldMap = [
      { input: 'name', column: 'name' },
      { input: 'contact_type', column: 'type' },
      { input: 'email', column: 'email' },
      { input: 'phone', column: 'phone' },
      { input: 'unit', column: 'unit' },
      { input: 'monthly_rent', column: 'monthly_rent' },
      { input: 'lease_start', column: 'lease_start' },
      { input: 'lease_end', column: 'lease_end' },
      { input: 'notes', column: 'notes' },
    ];
    const updates = [];
    const params = [];
    let i = 1;
    for (const { input: inputKey, column } of fieldMap) {
      if (input[inputKey] !== undefined) {
        updates.push(`${column} = $${i++}`);
        const v = input[inputKey];
        params.push(column === 'monthly_rent' ? (Number(v) || 0) : v);
      }
    }
    if (updates.length === 0) {
      return { success: false, message: `Found contact "${target.name}" but no fields to update were specified.` };
    }
    params.push(target.id, ctx.user.id);
    const result = await ctx.db.query(
      `UPDATE contacts SET ${updates.join(', ')} WHERE id = $${i++} AND user_id = $${i++} RETURNING *`,
      params
    );
    const fieldList = fieldMap
      .filter(f => input[f.input] !== undefined)
      .map(f => f.input === 'contact_type' ? 'type' : f.input)
      .join(', ');
    const more = matches.rows.length > 1 ? ` (matched ${matches.rows.length}; updated "${target.name}")` : '';
    return {
      success: true,
      data: result.rows[0],
      message: `Updated contact ${target.name}: ${fieldList}${more}`
    };
  }
});

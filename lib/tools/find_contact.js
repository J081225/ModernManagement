// lib/tools/find_contact.js — AP3 read tool.
// Thin SELECT over contacts with the Contacts screen filters
// (type, free-text over name/email/phone/unit).

const registry = require('../tool-registry');

registry.register({
  name: 'find_contact',
  description: 'Search contacts by free-text query (name, email, phone, unit), optionally filtered by type (resident / vendor / important). Returns up to 20 compact rows and notes how many more matched.',
  vertical: 'core',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      contact_type: { type: 'string', enum: ['resident', 'vendor', 'important'] },
    },
    required: ['query'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const q = String(input.query || '').trim().toLowerCase();
    if (!q) return { success: false, message: 'query is required.' };
    const where = ['user_id = $1'];
    const params = [ctx.user.id];
    let i = 2;
    if (input.contact_type) {
      where.push(`type = $${i++}`);
      params.push(input.contact_type);
    }
    where.push(`(LOWER(name) LIKE $${i} OR LOWER(COALESCE(email,'')) LIKE $${i} OR LOWER(COALESCE(phone,'')) LIKE $${i} OR LOWER(COALESCE(unit,'')) LIKE $${i})`);
    params.push('%' + q + '%');
    const r = await ctx.db.query(
      `SELECT id, name, type, phone, email, unit
         FROM contacts WHERE ${where.join(' AND ')}
        ORDER BY name ASC LIMIT 21`,
      params
    );
    const capped = r.rows.length > 20;
    const rows = capped ? r.rows.slice(0, 20) : r.rows;
    if (!rows.length) return { success: true, data: { contacts: [] }, message: `No contacts matching "${input.query}".` };
    const lines = rows.slice(0, 8).map(c => `#${c.id} ${c.name} (${c.type}${c.phone ? ', ' + c.phone : ''})`);
    return {
      success: true,
      data: { contacts: rows },
      message: `Found ${rows.length}${capped ? '+' : ''} contact(s): ${lines.join('; ')}${capped ? ' — more matching not shown' : ''}`,
    };
  },
});

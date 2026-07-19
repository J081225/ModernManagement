// lib/tools/delete_contact.js — AP3 destructive tool, precision-only.
// HARD RULE: no fuzzy-match deletion. Id, or exact full-name match;
// multiple candidates → list them, delete nothing.

const registry = require('../tool-registry');

registry.register({
  name: 'delete_contact',
  description: 'Delete a contact. Prefer contact_id (from a find_contact result or the open contact on screen). A name is accepted only as an EXACT full-name match — if several contacts share the name, nothing is deleted and the candidates are returned.',
  vertical: 'core',
  category: 'delete',
  schema: {
    type: 'object',
    properties: {
      contact_id: { type: 'integer', description: 'Preferred. Exact contact id.' },
      name: { type: 'string', description: 'Exact full name (case-insensitive). Never a partial match.' },
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      return { success: false, message: 'Only the business owner can delete contacts.' };
    }
    if (input.contact_id) {
      const r = await ctx.db.query(
        `DELETE FROM contacts WHERE id = $1 AND user_id = $2 RETURNING id, name`,
        [input.contact_id, ctx.user.id]
      );
      if (!r.rows.length) return { success: false, message: `No contact with id ${input.contact_id}.` };
      return { success: true, data: { deleted_id: r.rows[0].id }, message: `Deleted contact #${r.rows[0].id} "${r.rows[0].name}".` };
    }
    const name = String(input.name || '').trim();
    if (!name) return { success: false, message: 'Provide contact_id or an exact full name.' };
    const found = await ctx.db.query(
      `SELECT id, name, type, phone FROM contacts
        WHERE user_id = $1 AND LOWER(name) = LOWER($2)
        ORDER BY id LIMIT 6`,
      [ctx.user.id, name]
    );
    if (!found.rows.length) return { success: false, message: `No contact named exactly "${name}".` };
    if (found.rows.length > 1) {
      const list = found.rows.map(c => `#${c.id} ${c.name} (${c.type}${c.phone ? ', ' + c.phone : ''})`).join('; ');
      return { success: false, data: { candidates: found.rows }, message: `Multiple contacts match "${name}" — nothing deleted. Which one? ${list}` };
    }
    await ctx.db.query(`DELETE FROM contacts WHERE id = $1 AND user_id = $2`, [found.rows[0].id, ctx.user.id]);
    return { success: true, data: { deleted_id: found.rows[0].id }, message: `Deleted contact #${found.rows[0].id} "${found.rows[0].name}".` };
  },
});

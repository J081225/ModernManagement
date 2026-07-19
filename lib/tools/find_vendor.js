// lib/tools/find_vendor.js — AP3 read tool.
// Thin SELECT over vendors (active by default; include_archived opt-in).

const registry = require('../tool-registry');

registry.register({
  name: 'find_vendor',
  description: 'Search vendors by free-text query (name, notes, phone, email). Active vendors only unless include_archived=true. Returns up to 20 compact rows and notes how many more matched.',
  vertical: 'professional-services',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      include_archived: { type: 'boolean' },
    },
    required: ['query'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const q = String(input.query || '').trim().toLowerCase();
    if (!q) return { success: false, message: 'query is required.' };
    const where = ['workspace_id = $1'];
    const params = [ctx.workspace.id];
    if (!input.include_archived) where.push('archived_at IS NULL');
    where.push(`(LOWER(name) LIKE $2 OR LOWER(COALESCE(notes,'')) LIKE $2 OR LOWER(COALESCE(contact_phone,'')) LIKE $2 OR LOWER(COALESCE(contact_email,'')) LIKE $2)`);
    params.push('%' + q + '%');
    const r = await ctx.db.query(
      `SELECT id, name, contact_phone, contact_email, contact_url, notes, archived_at
         FROM vendors WHERE ${where.join(' AND ')}
        ORDER BY name ASC LIMIT 21`,
      params
    );
    const capped = r.rows.length > 20;
    const rows = capped ? r.rows.slice(0, 20) : r.rows;
    if (!rows.length) return { success: true, data: { vendors: [] }, message: `No vendors matching "${input.query}".` };
    const lines = rows.slice(0, 8).map(v => `#${v.id} ${v.name}${v.contact_phone ? ' (' + v.contact_phone + ')' : ''}${v.archived_at ? ' [archived]' : ''}`);
    return {
      success: true,
      data: { vendors: rows },
      message: `Found ${rows.length}${capped ? '+' : ''} vendor(s): ${lines.join('; ')}${capped ? ' — more matching not shown' : ''}`,
    };
  },
});

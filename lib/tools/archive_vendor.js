// lib/tools/archive_vendor.js — AP3, precision-only archive.
// Mirrors POST /api/vendors/:id/archive (sets archived_at).

const registry = require('../tool-registry');

registry.register({
  name: 'archive_vendor',
  description: 'Archive a vendor (hides it from the active list; reversible from the UI). Prefer vendor_id. A name is accepted only as an EXACT match; multiple candidates are listed and nothing is archived.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      vendor_id: { type: 'integer', description: 'Preferred. Exact vendor id.' },
      name: { type: 'string', description: 'Exact vendor name (case-insensitive).' },
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      return { success: false, message: 'Only the business owner can archive vendors.' };
    }
    let target = null;
    if (input.vendor_id) {
      const r = await ctx.db.query(
        `SELECT id, name FROM vendors WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [input.vendor_id, ctx.workspace.id]
      );
      if (!r.rows.length) return { success: false, message: `No active vendor with id ${input.vendor_id}.` };
      target = r.rows[0];
    } else {
      const name = String(input.name || '').trim();
      if (!name) return { success: false, message: 'Provide vendor_id or an exact name.' };
      const found = await ctx.db.query(
        `SELECT id, name FROM vendors
          WHERE workspace_id = $1 AND archived_at IS NULL AND LOWER(name) = LOWER($2)
          ORDER BY id LIMIT 6`,
        [ctx.workspace.id, name]
      );
      if (!found.rows.length) return { success: false, message: `No active vendor named exactly "${name}".` };
      if (found.rows.length > 1) {
        const list = found.rows.map(v => `#${v.id} ${v.name}`).join('; ');
        return { success: false, data: { candidates: found.rows }, message: `Multiple vendors match "${name}" — nothing archived. Which one? ${list}` };
      }
      target = found.rows[0];
    }
    await ctx.db.query(
      `UPDATE vendors SET archived_at = NOW(), updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
      [target.id, ctx.workspace.id]
    );
    return { success: true, data: { archived_id: target.id }, message: `Archived vendor #${target.id} "${target.name}".` };
  },
});

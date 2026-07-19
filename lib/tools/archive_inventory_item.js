// lib/tools/archive_inventory_item.js — AP3, precision-only archive.
// Mirrors POST /api/inventory-items/:id/archive (sets archived_at).

const registry = require('../tool-registry');

registry.register({
  name: 'archive_inventory_item',
  description: 'Archive an inventory item (hides it from the active list; reversible from the UI). Prefer item_id. A name is accepted only as an EXACT match; multiple candidates are listed and nothing is archived.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      item_id: { type: 'integer', description: 'Preferred. Exact inventory item id.' },
      name: { type: 'string', description: 'Exact item name (case-insensitive).' },
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      return { success: false, message: 'Only the business owner can archive inventory.' };
    }
    let target = null;
    if (input.item_id) {
      const r = await ctx.db.query(
        `SELECT id, name FROM inventory_items WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [input.item_id, ctx.workspace.id]
      );
      if (!r.rows.length) return { success: false, message: `No active inventory item with id ${input.item_id}.` };
      target = r.rows[0];
    } else {
      const name = String(input.name || '').trim();
      if (!name) return { success: false, message: 'Provide item_id or an exact name.' };
      const found = await ctx.db.query(
        `SELECT id, name, status FROM inventory_items
          WHERE workspace_id = $1 AND archived_at IS NULL AND LOWER(name) = LOWER($2)
          ORDER BY id LIMIT 6`,
        [ctx.workspace.id, name]
      );
      if (!found.rows.length) return { success: false, message: `No active inventory item named exactly "${name}".` };
      if (found.rows.length > 1) {
        const list = found.rows.map(x => `#${x.id} ${x.name} [${x.status}]`).join('; ');
        return { success: false, data: { candidates: found.rows }, message: `Multiple items match "${name}" — nothing archived. Which one? ${list}` };
      }
      target = found.rows[0];
    }
    await ctx.db.query(
      `UPDATE inventory_items SET archived_at = NOW(), updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
      [target.id, ctx.workspace.id]
    );
    return { success: true, data: { archived_id: target.id }, message: `Archived inventory item #${target.id} "${target.name}".` };
  },
});

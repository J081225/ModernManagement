// lib/tools/update_inventory_status.js
//
// Conversational inventory updater. Sarah says "we're out of acetone" or
// "just got 24 polishes in" — AI calls this with the natural-language
// intent. Fuzzy-matches by name (case-insensitive substring) within the
// workspace; on multiple matches returns ambiguity rather than picking.
//
// Schema reality: inventory_items is workspace-scoped (E4). Status enum
// (in_stock | low | out) is enforced by CHECK constraint.

const registry = require('../tool-registry');

registry.register({
  name: 'update_inventory_status',
  description: 'Update an inventory item\'s status (in_stock / low / out) and optionally quantity. Identify the item by name (fuzzy match) or by exact id. Use when the owner says things like "we just got 24 polishes" or "we\'re out of acetone".',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      name_or_id: { type: 'string', description: 'Item name (fuzzy match) or numeric id.' },
      status: { type: 'string', enum: ['in_stock', 'low', 'out'] },
      quantity: { type: 'number', description: 'Optional new quantity.' },
      notes: { type: 'string' },
    },
    required: ['name_or_id', 'status'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const ref = String(input.name_or_id || '').trim();
    if (!ref) return { success: false, message: 'name_or_id is required.' };
    const status = String(input.status || '').trim();
    if (!['in_stock', 'low', 'out'].includes(status)) {
      return { success: false, message: 'status must be in_stock, low, or out.' };
    }

    // Resolve the item — exact id if numeric, fuzzy name otherwise
    let item = null;
    const asInt = parseInt(ref, 10);
    if (Number.isInteger(asInt) && String(asInt) === ref) {
      const r = await ctx.db.query(
        `SELECT * FROM inventory_items WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [asInt, ctx.workspace.id]
      );
      item = r.rows[0] || null;
      if (!item) return { success: false, message: `No inventory item #${asInt} in this workspace.` };
    } else {
      const matches = await ctx.db.query(
        `SELECT * FROM inventory_items
          WHERE workspace_id = $1 AND archived_at IS NULL
            AND LOWER(name) LIKE $2
          ORDER BY name LIMIT 5`,
        [ctx.workspace.id, '%' + ref.toLowerCase() + '%']
      );
      if (matches.rows.length === 0) {
        return { success: false, message: `No inventory item matching "${ref}". Add the item first if it should be tracked.` };
      }
      if (matches.rows.length > 1) {
        const list = matches.rows.map(m => `#${m.id} ${m.name}`).join(', ');
        return { success: false, message: `Multiple matches for "${ref}": ${list}. Please specify which (use the id).` };
      }
      item = matches.rows[0];
    }

    const newQuantity = input.quantity != null ? input.quantity : item.quantity;
    const stampRestock = status === 'in_stock';

    try {
      const r = await ctx.db.query(
        `UPDATE inventory_items SET
           status = $1,
           quantity = $2,
           notes = COALESCE($3, notes),
           last_restocked_at = CASE WHEN $4 THEN NOW() ELSE last_restocked_at END,
           updated_at = NOW()
         WHERE id = $5 AND workspace_id = $6
         RETURNING id, name, status, quantity, unit`,
        [status, newQuantity, input.notes || null, stampRestock, item.id, ctx.workspace.id]
      );
      const out = r.rows[0];
      const qtyStr = out.quantity != null ? ` (${out.quantity}${out.unit ? ' ' + out.unit : ''})` : '';
      return {
        success: true,
        data: { inventory_item_id: out.id, name: out.name, status: out.status, quantity: out.quantity },
        message: `${out.name} marked ${out.status}${qtyStr}.`,
      };
    } catch (err) {
      ctx.logger.error('[update_inventory_status] failed:', err.message);
      return { success: false, message: `Could not update inventory: ${err.message}` };
    }
  },
});

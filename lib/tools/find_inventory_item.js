// lib/tools/find_inventory_item.js — AP3 read tool.
// Thin SELECT over inventory_items with the Inventory screen filters
// (status, low-stock shortcut, free text). PS-only, like the screen.

const registry = require('../tool-registry');

registry.register({
  name: 'find_inventory_item',
  description: 'Search inventory items by free-text query and/or status (in_stock / low / out). Set low_stock=true as a shortcut for "low or out". Returns up to 20 compact rows and notes how many more matched.',
  vertical: 'professional-services',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      status: { type: 'string', enum: ['in_stock', 'low', 'out'] },
      low_stock: { type: 'boolean', description: 'Shortcut: only items that are low or out.' },
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const where = ['workspace_id = $1', 'archived_at IS NULL'];
    const params = [ctx.workspace.id];
    let i = 2;
    if (input.status) {
      where.push(`status = $${i++}`);
      params.push(input.status);
    } else if (input.low_stock) {
      where.push(`status IN ('low', 'out')`);
    }
    if (input.query) {
      where.push(`(LOWER(name) LIKE $${i} OR LOWER(COALESCE(category,'')) LIKE $${i} OR LOWER(COALESCE(notes,'')) LIKE $${i})`);
      params.push('%' + String(input.query).toLowerCase() + '%');
      i++;
    }
    const r = await ctx.db.query(
      `SELECT id, name, category, status, quantity, unit
         FROM inventory_items WHERE ${where.join(' AND ')}
        ORDER BY status DESC, name ASC LIMIT 21`,
      params
    );
    const capped = r.rows.length > 20;
    const rows = capped ? r.rows.slice(0, 20) : r.rows;
    if (!rows.length) return { success: true, data: { inventory_items: [] }, message: 'No matching inventory items.' };
    const lines = rows.slice(0, 8).map(x => `#${x.id} ${x.name} [${x.status}${x.quantity != null ? ', ' + x.quantity + (x.unit ? ' ' + x.unit : '') : ''}]`);
    return {
      success: true,
      data: { inventory_items: rows },
      message: `Found ${rows.length}${capped ? '+' : ''} item(s): ${lines.join('; ')}${capped ? ' — more matching not shown' : ''}`,
    };
  },
});

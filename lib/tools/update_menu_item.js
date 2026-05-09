// lib/tools/update_menu_item.js
//
// Update an existing menu item. type and parent_menu_item_id are immutable
// (changing them would invalidate the addon/parent integrity check; use
// archive + recreate for that). All other fields optional.

const registry = require('../tool-registry');

registry.register({
  name: 'update_menu_item',
  description: 'Update an existing menu item (service, product, or add-on). Cannot change type or parent_menu_item_id (archive and recreate for those changes). Workspace-scoped.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      menu_item_id: { type: 'integer' },
      name: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
      base_price_cents: { type: 'integer' },
      duration_minutes: { type: 'integer' },
      tax_behavior: { type: 'string', enum: ['none', 'included', 'added'] },
      inventory_item_id: { type: 'integer', description: 'For products only.' },
      active: { type: 'boolean' },
    },
    required: ['menu_item_id'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const id = parseInt(input.menu_item_id, 10);
    if (!id) return { success: false, message: 'menu_item_id is required.' };

    const found = await ctx.db.query(
      `SELECT * FROM menu_items WHERE id = $1 AND workspace_id = $2`,
      [id, ctx.workspace.id]
    );
    if (found.rows.length === 0) {
      return { success: false, message: `No menu item with id ${id} in this workspace.` };
    }

    // Validate inventory_item_id if provided
    if (input.inventory_item_id != null) {
      const invId = parseInt(input.inventory_item_id, 10);
      if (invId) {
        const inv = await ctx.db.query(
          `SELECT id FROM inventory_items WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
          [invId, ctx.workspace.id]
        );
        if (inv.rows.length === 0) {
          return { success: false, message: `Inventory item #${invId} not found in this workspace.` };
        }
      }
    }

    const updates = [];
    const params = [];
    let i = 1;
    const fieldMap = [
      ['name', 'name'],
      ['description', 'description'],
      ['category', 'category'],
      ['base_price_cents', 'base_price_cents'],
      ['duration_minutes', 'duration_minutes'],
      ['tax_behavior', 'tax_behavior'],
      ['inventory_item_id', 'inventory_item_id'],
      ['active', 'active'],
    ];
    for (const [inputKey, col] of fieldMap) {
      if (input[inputKey] !== undefined) {
        updates.push(`${col} = $${i++}`);
        params.push(input[inputKey]);
      }
    }
    if (updates.length === 0) {
      return { success: false, message: 'No fields to update were provided.' };
    }
    updates.push(`updated_at = NOW()`);
    params.push(id, ctx.workspace.id);

    try {
      const r = await ctx.db.query(
        `UPDATE menu_items SET ${updates.join(', ')}
          WHERE id = $${i++} AND workspace_id = $${i++}
          RETURNING id, name, type`,
        params
      );
      const out = r.rows[0];
      return {
        success: true,
        data: { menu_item_id: out.id, name: out.name, type: out.type },
        message: `Updated ${out.type}: ${out.name}.`,
      };
    } catch (err) {
      ctx.logger.error('[update_menu_item] failed:', err.message);
      return { success: false, message: `Could not update menu item: ${err.message}` };
    }
  },
});

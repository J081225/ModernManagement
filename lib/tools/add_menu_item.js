// lib/tools/add_menu_item.js
//
// Create a new menu item: service, product, or addon.
// Schema reality: menu_items is workspace-scoped (E4, migration 037).
// CHECK constraints enforce type, tax_behavior, and addon/parent integrity.
// Validations here mirror the constraints so the AI gets a useful error
// message rather than a SQL violation.

const registry = require('../tool-registry');

registry.register({
  name: 'add_menu_item',
  description: 'Add a new menu item (service, product, or add-on) to the workspace menu. Services need duration_minutes. Add-ons need parent_menu_item_id pointing at a service in the same workspace. Products may optionally link to an inventory item.',
  vertical: 'professional-services',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['service', 'product', 'addon'] },
      description: { type: 'string' },
      category: { type: 'string', description: 'e.g., "Nails", "Hair", "Add-ons"' },
      base_price_cents: { type: 'integer', description: 'Starting-from price in cents.' },
      duration_minutes: { type: 'integer', description: 'Required for services.' },
      tax_behavior: { type: 'string', enum: ['none', 'included', 'added'], description: 'Default none.' },
      parent_menu_item_id: { type: 'integer', description: 'Required for add-ons; the parent service id.' },
      inventory_item_id: { type: 'integer', description: 'Optional, products only; link to a tracked inventory item.' },
    },
    required: ['name', 'type'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const name = String(input.name || '').trim();
    const type = String(input.type || '').trim();
    if (!name) return { success: false, message: 'name is required.' };
    if (!['service', 'product', 'addon'].includes(type)) {
      return { success: false, message: 'type must be service, product, or addon.' };
    }

    const base_price_cents = parseInt(input.base_price_cents, 10) || 0;
    const duration_minutes = input.duration_minutes != null ? parseInt(input.duration_minutes, 10) : null;
    const tax_behavior = ['none', 'included', 'added'].includes(input.tax_behavior) ? input.tax_behavior : 'none';

    if (type === 'service' && (!duration_minutes || duration_minutes <= 0)) {
      return { success: false, message: 'Services require duration_minutes (a positive integer).' };
    }

    let parent_menu_item_id = null;
    if (type === 'addon') {
      parent_menu_item_id = parseInt(input.parent_menu_item_id, 10);
      if (!parent_menu_item_id) {
        return { success: false, message: 'Add-ons require parent_menu_item_id (the parent service id).' };
      }
      // Validate the parent exists in this workspace AND is a service
      const p = await ctx.db.query(
        `SELECT id, type FROM menu_items WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [parent_menu_item_id, ctx.workspace.id]
      );
      if (p.rows.length === 0) {
        return { success: false, message: `Parent menu item #${parent_menu_item_id} not found in this workspace.` };
      }
      if (p.rows[0].type !== 'service') {
        return { success: false, message: 'parent_menu_item_id must point to a service.' };
      }
    }

    let inventory_item_id = null;
    if (type === 'product' && input.inventory_item_id != null) {
      inventory_item_id = parseInt(input.inventory_item_id, 10);
      if (inventory_item_id) {
        const inv = await ctx.db.query(
          `SELECT id FROM inventory_items WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
          [inventory_item_id, ctx.workspace.id]
        );
        if (inv.rows.length === 0) {
          return { success: false, message: `Inventory item #${inventory_item_id} not found in this workspace.` };
        }
      }
    }

    try {
      const r = await ctx.db.query(
        `INSERT INTO menu_items
           (workspace_id, type, name, description, category, base_price_cents,
            duration_minutes, tax_behavior, parent_menu_item_id, inventory_item_id, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
         RETURNING id, type, name`,
        [
          ctx.workspace.id, type, name,
          input.description || null,
          input.category || null,
          base_price_cents,
          type === 'service' ? duration_minutes : null,
          tax_behavior,
          parent_menu_item_id,
          inventory_item_id,
        ]
      );
      const out = r.rows[0];
      const priceStr = base_price_cents > 0 ? ` ($${(base_price_cents / 100).toFixed(2)})` : '';
      return {
        success: true,
        data: { menu_item_id: out.id, type: out.type, name: out.name },
        message: `Added ${type}: ${out.name}${priceStr}.`,
      };
    } catch (err) {
      ctx.logger.error('[add_menu_item] insert failed:', err.message);
      return { success: false, message: `Could not add menu item: ${err.message}` };
    }
  },
});

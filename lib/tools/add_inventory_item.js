// lib/tools/add_inventory_item.js
//
// Adds a new inventory item to a Professional Services workspace.
// PS-only. Workspace-scoped. Snake_case columns.
//
// Inventory tracking is opt-in per workspace via the
// inventory_tracking_enabled flag. This tool does NOT enforce that flag —
// if Sarah uses the AI to add an item while tracking is off, the item is
// created but the page is hidden until she turns tracking on. That's the
// correct behavior: the data is real either way.
//
// Schema reality (E4):
//   inventory_items columns: id, workspace_id, name, category, status,
//     quantity, unit, preferred_vendor_id, notes, last_restocked_at,
//     last_used_at, archived_at, created_at, updated_at
//   status CHECK constraint: in_stock | low | out
//   preferred_vendor_id: optional FK to vendors(id)

const registry = require('../tool-registry');

registry.register({
  name: 'add_inventory_item',
  description: 'Add a new inventory item to track stock for. Use when the user wants to start tracking a new supply or product (e.g., "add gel polish to inventory" or "track cuticle oil bottles, we have 12 in stock"). The item is workspace-scoped and starts in the status the user provides (default in_stock). Optionally links to a preferred vendor by name (fuzzy match).',
  vertical: 'professional-services',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the inventory item (e.g., "OPI Bubble Bath polish", "Acetone bottles").' },
      category: { type: 'string', description: 'Optional category, e.g., "polish", "tools", "consumables".' },
      status: { type: 'string', enum: ['in_stock', 'low', 'out'], description: 'Initial status. Defaults to in_stock if not specified.' },
      quantity: { type: 'number', description: 'Optional starting quantity. Numeric.' },
      unit: { type: 'string', description: 'Unit of measure for the quantity, e.g., "bottle", "box", "each". Optional.' },
      preferred_vendor_name: { type: 'string', description: 'Optional vendor name to link as preferred supplier. Fuzzy-matched against existing vendors.' },
      notes: { type: 'string', description: 'Free-form notes about this item.' },
    },
    required: ['name'],
  },
  navigationPolicy: 'auto',
  navigateTo: '/inventory',
  requiresApproval: false,
  async execute(input, ctx) {
    const { name, category, status, quantity, unit, preferred_vendor_name, notes } = input;
    if (!name || !String(name).trim()) {
      return { success: false, message: 'Inventory item name is required.' };
    }
    const initialStatus = status || 'in_stock';
    if (!['in_stock', 'low', 'out'].includes(initialStatus)) {
      return { success: false, message: `Invalid status "${initialStatus}". Must be in_stock, low, or out.` };
    }

    let preferred_vendor_id = null;
    if (preferred_vendor_name && String(preferred_vendor_name).trim()) {
      try {
        const vlookup = await ctx.db.query(
          `SELECT id, name FROM vendors
            WHERE workspace_id = $1
              AND archived_at IS NULL
              AND LOWER(name) LIKE $2
            ORDER BY name LIMIT 1`,
          [ctx.workspace.id, `%${preferred_vendor_name.toLowerCase()}%`]
        );
        if (vlookup.rows.length > 0) {
          preferred_vendor_id = vlookup.rows[0].id;
        }
        // No-match is silent — we don't fail the tool; we just don't link.
        // Sarah can link the vendor later from the UI.
      } catch (err) {
        ctx.logger.error('[add_inventory_item] vendor lookup failed (non-fatal):', err.message);
      }
    }

    let inserted;
    try {
      const r = await ctx.db.query(
        `INSERT INTO inventory_items
           (workspace_id, name, category, status, quantity, unit,
            preferred_vendor_id, notes, last_restocked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 CASE WHEN $4 = 'in_stock' THEN NOW() ELSE NULL END)
         RETURNING id, name, status, quantity, unit`,
        [ctx.workspace.id, name.trim(), category || null, initialStatus,
          (quantity != null ? quantity : null), unit || null,
          preferred_vendor_id, notes || null]
      );
      inserted = r.rows[0];
    } catch (err) {
      ctx.logger.error('[add_inventory_item] INSERT failed:', err.message);
      return { success: false, message: `Could not add inventory item: ${err.message}` };
    }

    const qtyPart = inserted.quantity != null
      ? ` (${inserted.quantity}${inserted.unit ? ' ' + inserted.unit : ''})`
      : '';
    const statusLabel = inserted.status === 'in_stock' ? 'In Stock'
      : inserted.status === 'low' ? 'Low'
        : 'Out';
    const vendorPart = preferred_vendor_id
      ? ' Linked to preferred vendor.'
      : (preferred_vendor_name && !preferred_vendor_id
        ? ` Note: vendor "${preferred_vendor_name}" not found, item created without vendor link.`
        : '');

    return {
      success: true,
      data: { inventory_item_id: inserted.id, name: inserted.name, status: inserted.status, preferred_vendor_id },
      message: `Added "${inserted.name}" to inventory${qtyPart}. Status: ${statusLabel}.${vendorPart}`,
    };
  },
});

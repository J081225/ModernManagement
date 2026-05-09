// lib/tools/update_vendor.js
//
// Update a vendor. All fields optional except vendor_id. Workspace ownership
// is enforced by the WHERE clause.

const registry = require('../tool-registry');

registry.register({
  name: 'update_vendor',
  description: 'Update a vendor: name, phone, email, URL, or notes. Workspace-scoped.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      vendor_id: { type: 'integer' },
      name: { type: 'string' },
      contact_phone: { type: 'string' },
      contact_email: { type: 'string' },
      contact_url: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['vendor_id'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const id = parseInt(input.vendor_id, 10);
    if (!id) return { success: false, message: 'vendor_id is required.' };

    const found = await ctx.db.query(
      `SELECT id, name FROM vendors WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
      [id, ctx.workspace.id]
    );
    if (found.rows.length === 0) {
      return { success: false, message: `No active vendor with id ${id} in this workspace.` };
    }

    const updates = [];
    const params = [];
    let i = 1;
    const fieldMap = [
      ['name', 'name'],
      ['contact_phone', 'contact_phone'],
      ['contact_email', 'contact_email'],
      ['contact_url', 'contact_url'],
      ['notes', 'notes'],
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
        `UPDATE vendors SET ${updates.join(', ')}
          WHERE id = $${i++} AND workspace_id = $${i++}
          RETURNING id, name`,
        params
      );
      return {
        success: true,
        data: { vendor_id: r.rows[0].id, name: r.rows[0].name },
        message: `Updated vendor: ${r.rows[0].name}.`,
      };
    } catch (err) {
      ctx.logger.error('[update_vendor] failed:', err.message);
      return { success: false, message: `Could not update vendor: ${err.message}` };
    }
  },
});

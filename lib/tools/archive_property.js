// lib/tools/archive_property.js
//
// Mirrors DELETE /api/entities/:id. Soft-delete: sets archived_at = NOW().
// Idempotent — preserves the original archive timestamp on re-archive
// (matching the COALESCE pattern in the endpoint).
const registry = require('../tool-registry');

registry.register({
  name: 'archive_property',
  description: 'Soft-delete (archive) a property. The property is hidden from default lists but its data is preserved. Identify by property name.',
  vertical: 'property-management',
  category: 'delete',
  schema: {
    type: 'object',
    properties: {
      property: { type: 'string', description: 'Property name.' }
    },
    required: ['property']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { property } = input;
    if (!property) {
      return { success: false, message: 'No property identifier provided.' };
    }
    const matches = await ctx.db.query(
      `SELECT * FROM entities
       WHERE workspace_id = $1 AND archived_at IS NULL AND LOWER(name) LIKE $2
       ORDER BY name LIMIT 5`,
      [ctx.workspace.id, `%${property.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No active property found matching "${property}".` };
    }
    const target = matches.rows[0];
    await ctx.db.query(
      `UPDATE entities
         SET archived_at = COALESCE(archived_at, NOW())
       WHERE id = $1 AND workspace_id = $2`,
      [target.id, ctx.workspace.id]
    );
    return {
      success: true,
      data: { id: target.id, name: target.name },
      message: `Archived property: ${target.name}`
    };
  }
});

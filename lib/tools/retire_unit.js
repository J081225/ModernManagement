// lib/tools/retire_unit.js
//
// Mirrors DELETE /api/offerings/:id (soft-delete: status='retired').
// Idempotent: re-retiring a retired unit preserves the original
// updated_at via the CASE expression.
const registry = require('../tool-registry');

registry.register({
  name: 'retire_unit',
  description: 'Soft-delete (retire) a unit. The unit is hidden from default lists but its history is preserved. Use when a unit is decommissioned permanently.',
  vertical: 'property-management',
  category: 'delete',
  schema: {
    type: 'object',
    properties: {
      unit: { type: 'string' },
      property: { type: 'string', description: 'Required when unit name alone is ambiguous.' }
    },
    required: ['unit']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { unit, property } = input;
    if (!unit) {
      return { success: false, message: 'No unit identifier provided.' };
    }
    let query = `
      SELECT o.*, e.name AS entity_name FROM offerings o
      JOIN entities e ON e.id = o.entity_id
      WHERE o.workspace_id = $1 AND o.status != 'retired' AND LOWER(o.name) LIKE $2
    `;
    const params = [ctx.workspace.id, `%${unit.toLowerCase()}%`];
    if (property) {
      query += ` AND LOWER(e.name) LIKE $3`;
      params.push(`%${property.toLowerCase()}%`);
    }
    query += ` ORDER BY o.name LIMIT 5`;
    const matches = await ctx.db.query(query, params);
    if (matches.rows.length === 0) {
      return { success: false, message: `No active unit found matching "${unit}".` };
    }
    const target = matches.rows[0];
    await ctx.db.query(
      `UPDATE offerings
         SET status = 'retired',
             updated_at = CASE WHEN status = 'retired' THEN updated_at ELSE NOW() END
       WHERE id = $1 AND workspace_id = $2`,
      [target.id, ctx.workspace.id]
    );
    return {
      success: true,
      data: { id: target.id, name: target.name },
      message: `Retired unit: ${target.name} (${target.entity_name})`
    };
  }
});

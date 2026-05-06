// lib/tools/set_unit_off_market.js
//
// Toggle the offerings.status enum between 'available' and 'unavailable'.
// (Note: 'unavailable' is the actual enum value for off-market — the
// schema uses status='unavailable' rather than a separate boolean.)
// Retired units cannot be brought back via this tool — that would
// require a restore flow.
const registry = require('../tool-registry');

registry.register({
  name: 'set_unit_off_market',
  description: "Toggle a unit on or off the market. Off-market = under repair, in renovation, or otherwise not currently rentable. Does NOT terminate any active tenancy.",
  vertical: 'property-management',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      unit: { type: 'string' },
      property: { type: 'string', description: 'Required when unit name alone is ambiguous.' },
      off_market: { type: 'boolean', description: 'true to mark off-market; false to bring back to vacant.' }
    },
    required: ['unit', 'off_market']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { unit, off_market, property } = input;
    if (!unit || off_market === undefined) {
      return { success: false, message: 'Missing required fields: unit and off_market.' };
    }
    let query = `
      SELECT o.*, e.name AS entity_name FROM offerings o
      JOIN entities e ON e.id = o.entity_id
      WHERE o.workspace_id = $1 AND LOWER(o.name) LIKE $2
    `;
    const params = [ctx.workspace.id, `%${unit.toLowerCase()}%`];
    if (property) {
      query += ` AND LOWER(e.name) LIKE $3`;
      params.push(`%${property.toLowerCase()}%`);
    }
    query += ` ORDER BY o.name LIMIT 5`;
    const matches = await ctx.db.query(query, params);
    if (matches.rows.length === 0) {
      return { success: false, message: `No unit found matching "${unit}".` };
    }
    const target = matches.rows[0];
    if (target.status === 'retired') {
      return { success: false, message: `${target.name} is retired; restore it before changing off-market status.` };
    }
    const newStatus = off_market ? 'unavailable' : 'available';
    await ctx.db.query(
      `UPDATE offerings SET status = $1, updated_at = NOW()
       WHERE id = $2 AND workspace_id = $3`,
      [newStatus, target.id, ctx.workspace.id]
    );
    return {
      success: true,
      data: { id: target.id, name: target.name, status: newStatus },
      message: `${target.name} (${target.entity_name}) is now ${off_market ? 'Off-market' : 'Vacant'}.`
    };
  }
});

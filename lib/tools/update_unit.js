// lib/tools/update_unit.js
//
// Mirrors PATCH /api/offerings/:id. Tool inputs `rent` / `frequency` map
// to columns price_amount / price_frequency. Metadata fields
// (bedrooms/bathrooms/sqft/amenities/notes) are merged onto the existing
// metadata JSONB so PATCH-style partial updates don't drop other keys.
const registry = require('../tool-registry');

const ALLOWED_FREQUENCIES = ['one-time', 'monthly', 'quarterly', 'annual', 'hourly'];

registry.register({
  name: 'update_unit',
  description: 'Update fields on an existing unit. Identify by unit name; include the property name when the unit name alone is ambiguous.',
  vertical: 'property-management',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      unit: { type: 'string', description: 'Unit name (must match a unit in the snapshot).' },
      property: { type: 'string', description: 'Parent property name (required when unit name alone is ambiguous).' },
      name: { type: 'string', description: 'New name (only when renaming).' },
      description: { type: 'string' },
      floor: { type: 'string' },
      rent: { type: 'number' },
      frequency: { type: 'string', enum: ALLOWED_FREQUENCIES },
      bedrooms: { type: 'number' },
      bathrooms: { type: 'number' },
      sqft: { type: 'number' },
      amenities: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' }
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
    if (input.frequency !== undefined && !ALLOWED_FREQUENCIES.includes(input.frequency)) {
      return { success: false, message: `frequency must be one of: ${ALLOWED_FREQUENCIES.join(', ')}.` };
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
      return { success: false, message: `No active unit found matching "${unit}"${property ? ` in property "${property}"` : ''}.` };
    }
    const target = matches.rows[0];

    // Build dynamic SET clause
    const updates = [];
    const updateParams = [];
    let i = 1;
    if (input.name !== undefined && input.name !== '') {
      updates.push(`name = $${i++}`);
      updateParams.push(String(input.name).trim());
    }
    if (input.description !== undefined) {
      updates.push(`description = $${i++}`);
      updateParams.push(input.description);
    }
    if (input.floor !== undefined) {
      updates.push(`floor = $${i++}`);
      updateParams.push(input.floor);
    }
    if (input.rent != null) {
      updates.push(`price_amount = $${i++}`);
      updateParams.push(input.rent);
    }
    if (input.frequency) {
      updates.push(`price_frequency = $${i++}`);
      updateParams.push(input.frequency);
    }

    // Metadata merge — preserve any keys not touched by this update.
    const originalMd = (target.metadata && typeof target.metadata === 'object') ? target.metadata : {};
    const newMd = { ...originalMd };
    let touchedMd = false;
    if (input.bedrooms != null) { newMd.bedrooms = input.bedrooms; touchedMd = true; }
    if (input.bathrooms != null) { newMd.bathrooms = input.bathrooms; touchedMd = true; }
    if (input.sqft != null) { newMd.sqft = input.sqft; touchedMd = true; }
    if (Array.isArray(input.amenities)) { newMd.amenities = input.amenities; touchedMd = true; }
    if (input.notes !== undefined) { newMd.notes = input.notes; touchedMd = true; }
    if (touchedMd) {
      updates.push(`metadata = $${i++}::jsonb`);
      updateParams.push(JSON.stringify(newMd));
    }

    if (updates.length === 0) {
      return { success: false, message: `Found "${target.name}" in ${target.entity_name} but no fields to update were specified.` };
    }
    updates.push('updated_at = NOW()');
    updateParams.push(target.id, ctx.workspace.id);
    const result = await ctx.db.query(
      `UPDATE offerings SET ${updates.join(', ')} WHERE id = $${i++} AND workspace_id = $${i++} RETURNING *`,
      updateParams
    );
    const fieldList = updates
      .filter(u => !u.startsWith('updated_at'))
      .map(u => u.split(' = ')[0])
      .join(', ');
    return {
      success: true,
      data: result.rows[0],
      message: `Updated unit ${target.name} in ${target.entity_name}: ${fieldList}`
    };
  }
});

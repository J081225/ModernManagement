// lib/tools/update_property.js
//
// Mirrors PATCH /api/entities/:id. Fuzzy-match property by name first,
// then UPDATE only the fields the AI provided. workspace_id-scoped;
// archived properties (archived_at IS NOT NULL) are excluded from match.
const registry = require('../tool-registry');

registry.register({
  name: 'update_property',
  description: 'Update fields on an existing property. Identify the property by its name from the snapshot. If multiple properties match the name, ask the user to clarify rather than guessing.',
  vertical: 'property-management',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      property: { type: 'string', description: 'Property name (must match a property in the snapshot).' },
      name: { type: 'string', description: 'New name (only when renaming).' },
      address: { type: 'string' },
      description: { type: 'string' },
      building_type: { type: 'string' },
      year_built: { type: 'number' },
      number_of_floors: { type: 'number' },
      total_unit_count: { type: 'number' },
      heating_system: { type: 'string' },
      water_source: { type: 'string' },
      parking_setup: { type: 'string' },
      pet_policy: { type: 'string' },
      smoking_policy: { type: 'string' }
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
    const updatable = ['name', 'address', 'description', 'building_type', 'year_built',
      'number_of_floors', 'total_unit_count', 'heating_system', 'water_source',
      'parking_setup', 'pet_policy', 'smoking_policy'];
    const updates = [];
    const params = [];
    let i = 1;
    for (const field of updatable) {
      if (input[field] !== undefined && input[field] !== null && input[field] !== '') {
        updates.push(`${field} = $${i++}`);
        params.push(input[field]);
      }
    }
    if (updates.length === 0) {
      return { success: false, message: `Found "${target.name}" but no fields to update were specified.` };
    }
    params.push(target.id, ctx.workspace.id);
    const result = await ctx.db.query(
      `UPDATE entities SET ${updates.join(', ')}
       WHERE id = $${i++} AND workspace_id = $${i++} AND archived_at IS NULL
       RETURNING *`,
      params
    );
    if (!result.rows.length) {
      return { success: false, message: `Property "${target.name}" could not be updated (it may have been archived).` };
    }
    const fieldList = updatable.filter(f => input[f] !== undefined && input[f] !== null && input[f] !== '').join(', ');
    const more = matches.rows.length > 1 ? ` (matched ${matches.rows.length}; updated "${target.name}")` : '';
    return {
      success: true,
      data: result.rows[0],
      message: `Updated property ${target.name}: ${fieldList}${more}`
    };
  }
});

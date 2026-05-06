// lib/tools/create_property.js
//
// Mirrors POST /api/entities. workspace_id-scoped. The address column
// is optional per Session A's partial-input fix; only `name` is required.
const registry = require('../tool-registry');

registry.register({
  name: 'create_property',
  description: 'Create a new property (building or location). Use when the user asks to add or create a property.',
  vertical: 'property-management',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Property name.' },
      address: { type: 'string', description: 'Full address.' },
      building_type: { type: 'string', description: 'e.g. apartment, condo, single-family, townhouse, mixed-use.' },
      year_built: { type: 'number' },
      number_of_floors: { type: 'number' },
      total_unit_count: { type: 'number' },
      description: { type: 'string' }
    },
    required: ['name']
  },
  navigationPolicy: 'home_only',
  navigateTo: { page: 'inventory', focus: { type: 'newest_property' } },
  async execute(input, ctx) {
    const name = (input.name || '').trim();
    if (!name) {
      return { success: false, message: 'Missing required field: name.' };
    }
    const address = (input.address || '').trim();
    const result = await ctx.db.query(
      `INSERT INTO entities (
         workspace_id, name, entity_type, address, description,
         number_of_floors, total_unit_count, building_type, year_built,
         heating_system, water_source, parking_setup, pet_policy, smoking_policy,
         shared_amenities, emergency_contacts, service_vendors
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13, $14,
         $15::jsonb, $16::jsonb, $17::jsonb
       ) RETURNING *`,
      [
        ctx.workspace.id,
        name,
        'property',
        address,
        input.description || '',
        input.number_of_floors ?? null,
        input.total_unit_count ?? null,
        input.building_type ?? null,
        input.year_built ?? null,
        null, null, null, null, null,
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
      ]
    );
    return {
      success: true,
      data: result.rows[0],
      message: `Created property: ${name}`
    };
  }
});

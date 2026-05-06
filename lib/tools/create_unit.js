// lib/tools/create_unit.js
//
// Mirrors POST /api/offerings.
//
// offerings schema: (workspace_id, entity_id, name, description, floor,
//   price_amount, price_frequency, status, metadata JSONB).
//   The AI tool's `rent` maps to price_amount, `frequency` to
//   price_frequency. Bedrooms/bathrooms/sqft/amenities/notes are packed
//   into metadata JSONB (matching the legacy applyActions dispatcher).
//
// status values allowed: draft, available, unavailable, retired.
// price_frequency values: one-time, monthly, quarterly, annual, hourly.
const registry = require('../tool-registry');

const ALLOWED_FREQUENCIES = ['one-time', 'monthly', 'quarterly', 'annual', 'hourly'];

registry.register({
  name: 'create_unit',
  description: 'Create a new unit (rental space) within a property. Use when the user asks to add a unit, apartment, suite, or room.',
  vertical: 'property-management',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      property: { type: 'string', description: 'Parent property name (must match a property in the snapshot).' },
      name: { type: 'string', description: 'Unit identifier, e.g. "Unit 301", "Apartment 2B", "Studio A".' },
      description: { type: 'string' },
      floor: { type: 'string', description: 'Floor designation, e.g. "2", "Ground", "Penthouse".' },
      rent: { type: 'number', description: 'Rent or price amount in dollars.' },
      frequency: { type: 'string', enum: ALLOWED_FREQUENCIES, description: 'Rent frequency (default monthly).' },
      bedrooms: { type: 'number' },
      bathrooms: { type: 'number' },
      sqft: { type: 'number' },
      amenities: { type: 'array', items: { type: 'string' }, description: 'Amenities like balcony, dishwasher, in-unit laundry.' },
      notes: { type: 'string' }
    },
    required: ['property', 'name']
  },
  navigationPolicy: 'home_only',
  navigateTo: { page: 'inventory', focus: { type: 'newest_unit' } },
  async execute(input, ctx) {
    const { property, name } = input;
    if (!property || !name) {
      return { success: false, message: 'Missing required fields: property and name.' };
    }
    if (input.frequency !== undefined && !ALLOWED_FREQUENCIES.includes(input.frequency)) {
      return { success: false, message: `frequency must be one of: ${ALLOWED_FREQUENCIES.join(', ')}.` };
    }
    const propMatches = await ctx.db.query(
      `SELECT * FROM entities
       WHERE workspace_id = $1 AND archived_at IS NULL AND LOWER(name) LIKE $2
       ORDER BY name LIMIT 5`,
      [ctx.workspace.id, `%${property.toLowerCase()}%`]
    );
    if (propMatches.rows.length === 0) {
      return { success: false, message: `No property found matching "${property}".` };
    }
    const parent = propMatches.rows[0];

    // Pack non-column fields into metadata
    const md = {};
    if (input.bedrooms != null) md.bedrooms = input.bedrooms;
    if (input.bathrooms != null) md.bathrooms = input.bathrooms;
    if (input.sqft != null) md.sqft = input.sqft;
    if (Array.isArray(input.amenities) && input.amenities.length) md.amenities = input.amenities;
    if (input.notes) md.notes = input.notes;

    const result = await ctx.db.query(
      `INSERT INTO offerings (
         workspace_id, entity_id, name, description, floor,
         price_amount, price_frequency, status, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING *`,
      [
        ctx.workspace.id,
        parent.id,
        String(name).trim(),
        input.description || '',
        input.floor || '',
        input.rent != null ? input.rent : 0,
        input.frequency || 'monthly',
        'available',
        JSON.stringify(md),
      ]
    );
    return {
      success: true,
      data: result.rows[0],
      message: `Created unit: ${result.rows[0].name} in ${parent.name}`
    };
  }
});

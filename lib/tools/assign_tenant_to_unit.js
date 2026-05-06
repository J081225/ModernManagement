// lib/tools/assign_tenant_to_unit.js
//
// Mirrors POST /api/engagements with the legacy applyActions defaults:
//   - start_date defaults to contact.lease_start, then today
//   - end_date defaults to contact.lease_end, else null
//   - current_price = explicit input.rent || contact.monthly_rent || offering.price_amount
// engagements is workspace_id-scoped. The DB has a partial unique index
// on (contact_id, offering_id) WHERE status='active' that returns SQL
// state 23505 if violated — we surface that as a 409-equivalent message.
const registry = require('../tool-registry');

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

registry.register({
  name: 'assign_tenant_to_unit',
  description: 'Assign a tenant (existing contact) to a unit by creating an active engagement. The contact must already exist (use add_contact first if not). If multiple contacts or units match the names, ASK FOR CLARIFICATION rather than guessing.',
  vertical: 'property-management',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      tenant: { type: 'string', description: 'Tenant contact name.' },
      unit: { type: 'string', description: 'Unit name.' },
      property: { type: 'string', description: 'Parent property (required when unit name is ambiguous).' },
      start_date: { type: 'string', description: 'Tenancy start date YYYY-MM-DD (default: contact lease_start or today).' },
      end_date: { type: 'string', description: 'Tenancy end date YYYY-MM-DD (default: contact lease_end or none).' },
      rent: { type: 'number', description: 'Override current price (default: contact monthly_rent if set, else unit rent).' }
    },
    required: ['tenant', 'unit']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { tenant, unit, property } = input;
    if (!tenant || !unit) {
      return { success: false, message: 'Missing required fields: tenant and unit.' };
    }
    // Resolve tenant — contacts are user_id-scoped (legacy table)
    const tenantMatches = await ctx.db.query(
      `SELECT * FROM contacts
       WHERE user_id = $1 AND LOWER(name) LIKE $2
       ORDER BY name LIMIT 5`,
      [ctx.user.id, `%${tenant.toLowerCase()}%`]
    );
    if (tenantMatches.rows.length === 0) {
      return { success: false, message: `No contact found matching "${tenant}".` };
    }
    const tenantRow = tenantMatches.rows[0];

    // Resolve unit
    let unitQuery = `
      SELECT o.*, e.name AS entity_name FROM offerings o
      JOIN entities e ON e.id = o.entity_id
      WHERE o.workspace_id = $1 AND o.status != 'retired' AND LOWER(o.name) LIKE $2
    `;
    const unitParams = [ctx.workspace.id, `%${unit.toLowerCase()}%`];
    if (property) {
      unitQuery += ` AND LOWER(e.name) LIKE $3`;
      unitParams.push(`%${property.toLowerCase()}%`);
    }
    unitQuery += ` ORDER BY o.name LIMIT 5`;
    const unitMatches = await ctx.db.query(unitQuery, unitParams);
    if (unitMatches.rows.length === 0) {
      return { success: false, message: `No active unit found matching "${unit}"${property ? ` in "${property}"` : ''}.` };
    }
    const unitRow = unitMatches.rows[0];

    // Compute defaults: dates from contact lease, price from explicit/contact/offering
    const startDate = input.start_date || tenantRow.lease_start || todayISO();
    const endDate = input.end_date || tenantRow.lease_end || null;
    const monthlyRent = Number(tenantRow.monthly_rent || 0);
    const offeringPrice = unitRow.price_amount != null ? Number(unitRow.price_amount) : 0;
    const currentPrice = input.rent != null
      ? Number(input.rent)
      : (Number.isFinite(monthlyRent) && monthlyRent > 0 ? monthlyRent : offeringPrice);

    try {
      const result = await ctx.db.query(
        `INSERT INTO engagements (
           workspace_id, contact_id, offering_id,
           start_date, end_date, current_price, status, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', '{}'::jsonb)
         RETURNING *`,
        [ctx.workspace.id, tenantRow.id, unitRow.id, startDate, endDate || null, currentPrice]
      );
      return {
        success: true,
        data: result.rows[0],
        message: `Assigned ${tenantRow.name} to ${unitRow.name} (${unitRow.entity_name}).`
      };
    } catch (err) {
      if (err.code === '23505') {
        return { success: false, message: `${tenantRow.name} already has an active engagement on ${unitRow.name}.` };
      }
      if (err.code === '22007' || err.code === '22008') {
        return { success: false, message: 'Invalid date format for start_date or end_date.' };
      }
      throw err;
    }
  }
});

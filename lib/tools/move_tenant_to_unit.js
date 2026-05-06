// lib/tools/move_tenant_to_unit.js
//
// Atomic move within a transaction:
//   1. Find the tenant's current active engagement (any unit)
//   2. If destination unit is the same → no-op
//   3. If destination unit already occupied → fail
//   4. Begin transaction:
//        - Terminate old engagement (status='terminated', end_date=today)
//        - Create new engagement (status='active', start_date=today)
//      Both succeed or both rollback.
//
// engagements is workspace_id-scoped; contacts is user_id-scoped (legacy).
const registry = require('../tool-registry');

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

registry.register({
  name: 'move_tenant_to_unit',
  description: 'Move an existing tenant from their current unit to a new unit. Atomically terminates the old engagement and creates a new active one. If the tenant has no current unit, behaves like assign_tenant_to_unit.',
  vertical: 'property-management',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      tenant: { type: 'string' },
      unit: { type: 'string', description: 'New unit name.' },
      property: { type: 'string', description: 'Parent property (required when unit name is ambiguous).' }
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
    // Resolve tenant
    const tenantMatches = await ctx.db.query(
      `SELECT * FROM contacts
       WHERE user_id = $1 AND LOWER(name) LIKE $2 ORDER BY name LIMIT 5`,
      [ctx.user.id, `%${tenant.toLowerCase()}%`]
    );
    if (tenantMatches.rows.length === 0) {
      return { success: false, message: `No contact found matching "${tenant}".` };
    }
    const tenantRow = tenantMatches.rows[0];

    // Resolve destination unit
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
      return { success: false, message: `No active unit found matching "${unit}".` };
    }
    const destUnit = unitMatches.rows[0];

    // Find current active engagement (if any)
    const activeEngRes = await ctx.db.query(
      `SELECT * FROM engagements
       WHERE workspace_id = $1 AND contact_id = $2 AND status = 'active'
       ORDER BY start_date DESC LIMIT 1`,
      [ctx.workspace.id, tenantRow.id]
    );
    const oldEng = activeEngRes.rows[0] || null;

    // Same-unit guard
    if (oldEng && oldEng.offering_id === destUnit.id) {
      return { success: false, message: `${tenantRow.name} is already assigned to ${destUnit.name}.` };
    }

    // Destination occupancy check
    const destOccRes = await ctx.db.query(
      `SELECT 1 FROM engagements
       WHERE workspace_id = $1 AND offering_id = $2 AND status = 'active' LIMIT 1`,
      [ctx.workspace.id, destUnit.id]
    );
    if (destOccRes.rows.length > 0) {
      return { success: false, message: `Destination unit ${destUnit.name} is already occupied.` };
    }

    const monthlyRent = Number(tenantRow.monthly_rent || 0);
    const offeringPrice = destUnit.price_amount != null ? Number(destUnit.price_amount) : 0;
    const currentPrice = (Number.isFinite(monthlyRent) && monthlyRent > 0) ? monthlyRent : offeringPrice;
    const today = todayISO();

    // Transaction: terminate old (if any), insert new active engagement
    const client = await ctx.db.connect();
    try {
      await client.query('BEGIN');
      if (oldEng) {
        await client.query(
          `UPDATE engagements
             SET status = 'terminated', end_date = COALESCE(end_date, $1::date)
           WHERE id = $2 AND workspace_id = $3`,
          [today, oldEng.id, ctx.workspace.id]
        );
      }
      const newEngRes = await client.query(
        `INSERT INTO engagements (
           workspace_id, contact_id, offering_id,
           start_date, end_date, current_price, status, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', '{}'::jsonb)
         RETURNING *`,
        [ctx.workspace.id, tenantRow.id, destUnit.id, today, tenantRow.lease_end || null, currentPrice]
      );
      await client.query('COMMIT');
      return {
        success: true,
        data: newEngRes.rows[0],
        message: `Moved ${tenantRow.name} ${oldEng ? 'to' : 'into'} ${destUnit.name} (${destUnit.entity_name}).`
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (err.code === '23505') {
        return { success: false, message: `${tenantRow.name} already has an active engagement that conflicts with this move.` };
      }
      throw err;
    } finally {
      client.release();
    }
  }
});

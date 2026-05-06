// lib/tools/end_tenant_assignment.js
//
// Terminate a tenant's currently-active engagement. No new engagement
// is created. Per the engagements state machine, active → terminated
// is allowed.
const registry = require('../tool-registry');

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

registry.register({
  name: 'end_tenant_assignment',
  description: "End a tenant's current unit assignment (terminate the active engagement). Use for move-outs, evictions, or lease terminations.",
  vertical: 'property-management',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      tenant: { type: 'string' }
    },
    required: ['tenant']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { tenant } = input;
    if (!tenant) {
      return { success: false, message: 'No tenant identifier provided.' };
    }
    const tenantMatches = await ctx.db.query(
      `SELECT * FROM contacts
       WHERE user_id = $1 AND LOWER(name) LIKE $2 ORDER BY name LIMIT 5`,
      [ctx.user.id, `%${tenant.toLowerCase()}%`]
    );
    if (tenantMatches.rows.length === 0) {
      return { success: false, message: `No contact found matching "${tenant}".` };
    }
    const tenantRow = tenantMatches.rows[0];
    const activeRes = await ctx.db.query(
      `SELECT e.*, o.name AS offering_name
       FROM engagements e
       LEFT JOIN offerings o ON o.id = e.offering_id
       WHERE e.workspace_id = $1 AND e.contact_id = $2 AND e.status = 'active'
       ORDER BY e.start_date DESC LIMIT 1`,
      [ctx.workspace.id, tenantRow.id]
    );
    if (activeRes.rows.length === 0) {
      return { success: false, message: `${tenantRow.name} has no active unit assignment.` };
    }
    const eng = activeRes.rows[0];
    const today = todayISO();
    await ctx.db.query(
      `UPDATE engagements
         SET status = 'terminated', end_date = COALESCE(end_date, $1::date)
       WHERE id = $2 AND workspace_id = $3`,
      [today, eng.id, ctx.workspace.id]
    );
    return {
      success: true,
      data: { id: eng.id, contact: tenantRow.name, offering: eng.offering_name || null },
      message: `Ended ${tenantRow.name}'s assignment to ${eng.offering_name || 'their unit'}.`
    };
  }
});

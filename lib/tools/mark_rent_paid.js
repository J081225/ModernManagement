// lib/tools/mark_rent_paid.js
//
// rent_payments schema: (user_id, resident, unit, amount, due_date,
//   status, paid_date, notes). user_id-scoped. Status values: 'pending',
//   'paid', 'late'.
//
// Behavior mirrors the legacy applyActions dispatcher: fuzzy-match by
// resident name, narrow by unit if provided, mark the most recent
// non-paid record as paid with paid_date=today.
const registry = require('../tool-registry');

registry.register({
  name: 'mark_rent_paid',
  description: "Mark a resident's rent as paid. Use the resident name and/or unit from the rent records.",
  vertical: 'property-management',
  category: 'financial',
  schema: {
    type: 'object',
    properties: {
      resident: { type: 'string', description: 'Resident name (partial match ok).' },
      unit: { type: 'string', description: 'Unit number (optional, helps narrow down).' }
    },
    required: ['resident']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { resident, unit } = input;
    if (!resident) {
      return { success: false, message: 'No resident name provided.' };
    }
    let query = `
      SELECT * FROM rent_payments
      WHERE user_id = $1
        AND status != 'paid'
        AND LOWER(resident) LIKE $2
    `;
    const params = [ctx.user.id, `%${resident.toLowerCase()}%`];
    if (unit) {
      query += ` AND LOWER(unit) = $3`;
      params.push(unit.toLowerCase());
    }
    query += ` ORDER BY due_date DESC LIMIT 5`;

    const matches = await ctx.db.query(query, params);
    if (matches.rows.length === 0) {
      return {
        success: false,
        message: `No unpaid rent record found for "${resident}"${unit ? ` in unit ${unit}` : ''}.`
      };
    }
    const target = matches.rows[0];
    const paidDate = new Date().toISOString().split('T')[0];
    await ctx.db.query(
      `UPDATE rent_payments
         SET status = 'paid', paid_date = $1
       WHERE id = $2 AND user_id = $3`,
      [paidDate, target.id, ctx.user.id]
    );
    const more = matches.rows.length > 1
      ? ` (matched ${matches.rows.length} unpaid records; marked the most recent: due ${target.due_date})`
      : '';
    return {
      success: true,
      data: { id: target.id, resident: target.resident, unit: target.unit, amount: target.amount },
      message: `Marked rent paid: ${target.resident}${target.unit ? ` (Unit ${target.unit})` : ''} — $${Number(target.amount).toLocaleString()}${more}`
    };
  }
});

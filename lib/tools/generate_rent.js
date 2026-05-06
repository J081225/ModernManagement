// lib/tools/generate_rent.js
//
// Bulk rent generation. Mirrors POST /api/rent/generate-month exactly:
//   - Pulls all resident contacts with monthly_rent > 0
//   - For each, skips if a rent_payments row already exists for that
//     resident + month, otherwise INSERTs a 'pending' record.
//   - Both contacts and rent_payments are user_id-scoped.
const registry = require('../tool-registry');

registry.register({
  name: 'generate_rent',
  description: 'Generate monthly rent records for all residents who have a monthly rent amount set on their contact. Creates one pending record per resident.',
  vertical: 'property-management',
  category: 'financial',
  schema: {
    type: 'object',
    properties: {
      month: { type: 'number', description: 'Month number 1-12.' },
      year: { type: 'number', description: 'Four-digit year.' },
      due_day: { type: 'number', description: 'Day of month rent is due (1-28, default 1).' }
    },
    required: ['month', 'year']
  },
  navigationPolicy: 'home_only',
  navigateTo: { page: 'admin', focus: { type: 'tab', tab: 'rent' } },
  async execute(input, ctx) {
    const { month, year } = input;
    if (!month || !year) {
      return { success: false, message: 'Missing required fields: month and year.' };
    }
    const dueDay = String(input.due_day || 1).padStart(2, '0');
    const dueDate = `${year}-${String(month).padStart(2, '0')}-${dueDay}`;
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

    const residentsRes = await ctx.db.query(
      `SELECT * FROM contacts
       WHERE user_id = $1 AND type = 'resident' AND monthly_rent > 0`,
      [ctx.user.id]
    );

    let created = 0;
    let skipped = 0;
    for (const r of residentsRes.rows) {
      const existing = await ctx.db.query(
        `SELECT id FROM rent_payments
         WHERE user_id = $1 AND resident = $2 AND due_date LIKE $3`,
        [ctx.user.id, r.name, `${monthPrefix}%`]
      );
      if (existing.rows.length) { skipped++; continue; }
      await ctx.db.query(
        `INSERT INTO rent_payments (user_id, resident, unit, amount, due_date, status, notes)
         VALUES ($1, $2, $3, $4, $5, 'pending', '')`,
        [ctx.user.id, r.name, r.unit || '', r.monthly_rent, dueDate]
      );
      created++;
    }
    return {
      success: true,
      data: { created, skipped, total: residentsRes.rows.length, month, year },
      message: `Generated rent for ${month}/${year}: ${created} new record${created !== 1 ? 's' : ''}${skipped > 0 ? `, ${skipped} skipped (already existed)` : ''}.`
    };
  }
});

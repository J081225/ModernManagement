// lib/tools/add_invoice.js
//
// invoices schema: (user_id, vendor, description, amount, date, notes,
//   status). user_id-scoped (legacy table). The existing POST /api/invoices
//   endpoint omits status and lets the column default kick in; this tool
//   sets status explicitly so the AI can supply 'paid', 'overdue', etc.
//   at creation time when relevant.
const registry = require('../tool-registry');

registry.register({
  name: 'add_invoice',
  description: "Create a new invoice record. Invoices represent bills you owe to a vendor (e.g., a plumber, an electric company, a landscaper). Use this when the user wants to record a vendor invoice or a bill to track. Provide at minimum the vendor and amount; description, date, and status are optional. Default status is 'pending'.",
  vertical: 'property-management',
  category: 'financial',
  schema: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: 'Name of the vendor / payee (e.g. "ABC Plumbing", "ConEdison").' },
      amount: { type: 'number', description: 'Invoice amount in dollars (e.g. 450.00).' },
      description: { type: 'string', description: 'Optional. What the invoice is for (e.g. "kitchen sink repair, unit 304").' },
      date: { type: 'string', description: 'Optional. Invoice date in YYYY-MM-DD format. Defaults to today if not provided.' },
      status: { type: 'string', enum: ['pending', 'paid', 'overdue', 'cancelled'], description: "Optional. Invoice status. Defaults to 'pending'." },
      notes: { type: 'string', description: 'Optional. Additional notes.' }
    },
    required: ['vendor', 'amount']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { vendor, amount, description, notes } = input;
    if (!vendor || amount === undefined || amount === null) {
      return { success: false, message: 'Missing required fields: vendor and amount.' };
    }
    const date = input.date || new Date().toISOString().slice(0, 10);
    const status = input.status || 'pending';

    const result = await ctx.db.query(
      `INSERT INTO invoices (user_id, vendor, description, amount, date, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [ctx.user.id, vendor, description || null, Number(amount), date, notes || null, status]
    );
    return {
      success: true,
      data: result.rows[0],
      message: `Added invoice from ${vendor}: $${Number(amount).toLocaleString()}${description ? ` — ${description}` : ''} (${date}, ${status})`
    };
  }
});

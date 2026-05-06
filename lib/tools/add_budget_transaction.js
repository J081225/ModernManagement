// lib/tools/add_budget_transaction.js
//
// budget_transactions schema: (user_id, type, category, description,
//   amount, date, notes, "createdAt"). user_id-scoped. Note that the
//   tool's input field "transaction_type" maps to the DB column "type".
//   Session A behavior preserved: category defaults to 'Other', date
//   defaults to today.
const registry = require('../tool-registry');

registry.register({
  name: 'add_budget_transaction',
  description: 'Log an income or expense transaction in the budget tracker.',
  vertical: 'property-management',
  category: 'financial',
  schema: {
    type: 'object',
    properties: {
      transaction_type: { type: 'string', enum: ['income', 'expense'], description: 'Income or expense.' },
      category: { type: 'string', description: "Optional. Category, e.g. Rent, Repairs, Utilities, Insurance, Landscaping. Defaults to 'Other' if not provided." },
      description: { type: 'string', description: 'What the transaction is for.' },
      amount: { type: 'number', description: 'Dollar amount (positive number).' },
      date: { type: 'string', description: 'Optional. Date in YYYY-MM-DD format. Defaults to today if not provided.' },
      notes: { type: 'string', description: 'Optional notes.' }
    },
    required: ['transaction_type', 'description', 'amount']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { transaction_type, description, amount, notes } = input;
    if (!transaction_type || !description || amount === undefined || amount === null) {
      return { success: false, message: 'Missing required fields: transaction_type, description, and amount.' };
    }
    const category = (input.category && String(input.category).trim()) || 'Other';
    const date = (input.date && String(input.date).trim()) || new Date().toISOString().slice(0, 10);
    const result = await ctx.db.query(
      `INSERT INTO budget_transactions (user_id, type, category, description, amount, date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [ctx.user.id, transaction_type, category, description, Number(amount), date, notes || '']
    );
    const sign = transaction_type === 'income' ? '+' : '-';
    return {
      success: true,
      data: result.rows[0],
      message: `Logged ${transaction_type}: ${description} (${sign}$${Number(amount).toLocaleString()}, ${category}, ${date})`
    };
  }
});

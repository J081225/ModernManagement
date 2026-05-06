// lib/tools/update_invoice_status.js
//
// Fuzzy-match an invoice by vendor or description and flip its status.
// invoices is user_id-scoped (legacy table). Most-recent-match wins;
// the message notes when multiple matched.
const registry = require('../tool-registry');

registry.register({
  name: 'update_invoice_status',
  description: 'Update the status of an existing invoice — typically used to mark an invoice as paid, overdue, or cancelled. Identify the invoice by vendor name or by its description (e.g., "ABC Plumbing", "kitchen repair"). The most recent matching invoice is updated; if multiple invoices match the identifier, the response notes that.',
  vertical: 'property-management',
  category: 'financial',
  schema: {
    type: 'object',
    properties: {
      invoice: { type: 'string', description: 'String identifying the invoice. Can be a vendor name, a partial description, or an invoice ID. Fuzzy-matched against existing invoices.' },
      status: { type: 'string', enum: ['pending', 'paid', 'overdue', 'cancelled'], description: 'New status for the invoice.' }
    },
    required: ['invoice', 'status']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { invoice, status } = input;
    if (!invoice || !status) {
      return { success: false, message: 'Missing required fields: invoice and status.' };
    }

    const matches = await ctx.db.query(
      `SELECT * FROM invoices
       WHERE user_id = $1
         AND (LOWER(vendor) LIKE $2 OR LOWER(COALESCE(description, '')) LIKE $2)
       ORDER BY date DESC LIMIT 5`,
      [ctx.user.id, `%${invoice.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No invoice found matching "${invoice}".` };
    }
    const target = matches.rows[0];

    const result = await ctx.db.query(
      `UPDATE invoices SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
      [status, target.id, ctx.user.id]
    );

    const more = matches.rows.length > 1
      ? ` (matched ${matches.rows.length} invoices; updated the most recent: ${target.vendor} $${Number(target.amount).toLocaleString()})`
      : '';
    return {
      success: true,
      data: result.rows[0],
      message: `Set invoice from ${target.vendor} ($${Number(target.amount).toLocaleString()}) to ${status}${more}`
    };
  }
});

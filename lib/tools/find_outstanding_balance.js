// lib/tools/find_outstanding_balance.js
//
// Natural-language lookup for "who owes money" / "what does X owe". Returns
// transactions where the customer still owes a balance — restricted to
// status='partially_paid' or status='unpaid' AND total_cents >
// amount_paid_cents. Pure 'draft' transactions are intentionally excluded:
// a draft transaction with no payment activity is the auto-created shell
// from complete_appointment, and surfacing it as "owed" would be noise.
//
// amount_paid_cents is the ledger-backed rollup post-E14 (sole writer:
// lib/payment-ledger.recomputeTransactionPaidStatus), so total - paid is
// the live owed amount for both pre- and post-E14 transactions.
//
// All queries are workspace-scoped. READ-ONLY — no INSERT/UPDATE/DELETE.

const registry = require('../tool-registry');

registry.register({
  name: 'find_outstanding_balance',
  description: "Find what a customer still owes, or list customers with outstanding balances. Use for questions like \"what does Maria owe?\" or \"who has an outstanding balance over $50?\". Returns up to 20 transactions where money is still owed (partially paid or unpaid), with the owed amount, total, and status.",
  vertical: 'professional-services',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      customer_name: { type: 'string', description: 'Substring match against the transaction customer name (case-insensitive).' },
      min_owed_cents: { type: 'integer', description: 'Only return transactions where the still-owed amount is at least this many cents.' },
      max_owed_cents: { type: 'integer', description: 'Only return transactions where the still-owed amount is at most this many cents.' },
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const where = [
      't.workspace_id = $1',
      "t.status IN ('partially_paid', 'unpaid')",
      't.total_cents > t.amount_paid_cents',
    ];
    const params = [ctx.workspace.id];
    let idx = 2;

    if (input.customer_name && String(input.customer_name).trim()) {
      where.push(`LOWER(t.customer_display_name) LIKE $${idx++}`);
      params.push('%' + String(input.customer_name).toLowerCase().trim() + '%');
    }
    if (input.min_owed_cents != null) {
      where.push(`(t.total_cents - t.amount_paid_cents) >= $${idx++}`);
      params.push(parseInt(input.min_owed_cents, 10) || 0);
    }
    if (input.max_owed_cents != null) {
      where.push(`(t.total_cents - t.amount_paid_cents) <= $${idx++}`);
      params.push(parseInt(input.max_owed_cents, 10) || 0);
    }

    const sql = `
      SELECT t.id, t.customer_display_name, t.contact_id,
             t.total_cents, t.amount_paid_cents,
             (t.total_cents - t.amount_paid_cents) AS owed_cents,
             t.status, t.created_at, t.payment_received_at, t.appointment_id
        FROM transactions t
       WHERE ${where.join(' AND ')}
       ORDER BY (t.total_cents - t.amount_paid_cents) DESC, t.id DESC
       LIMIT 20
    `;

    let rows;
    try {
      const r = await ctx.db.query(sql, params);
      rows = r.rows;
    } catch (err) {
      ctx.logger.error('[find_outstanding_balance] query failed:', err.message);
      return { success: false, message: `Could not search outstanding balances: ${err.message}` };
    }

    if (rows.length === 0) {
      return {
        success: true,
        data: { transactions: [], total_owed_cents: 0 },
        message: 'No outstanding balances match those filters.',
      };
    }

    const summaries = rows.map(r => ({
      id: r.id,
      customer: r.customer_display_name,
      contact_id: r.contact_id,
      total_cents: r.total_cents,
      amount_paid_cents: r.amount_paid_cents,
      owed_cents: r.owed_cents,
      owed: '$' + (r.owed_cents / 100).toFixed(2),
      total: '$' + (r.total_cents / 100).toFixed(2),
      status: r.status,
      appointment_id: r.appointment_id,
    }));

    const totalOwedCents = summaries.reduce((s, t) => s + (t.owed_cents || 0), 0);
    const totalOwed = '$' + (totalOwedCents / 100).toFixed(2);

    const lines = summaries.slice(0, 5).map(s =>
      `#${s.id} ${s.customer} — owes ${s.owed} of ${s.total} (${s.status})`
    );
    const more = summaries.length > 5 ? ` (+${summaries.length - 5} more)` : '';

    return {
      success: true,
      data: { transactions: summaries, total_owed_cents: totalOwedCents },
      message: `Found ${summaries.length} outstanding ${summaries.length === 1 ? 'balance' : 'balances'} totaling ${totalOwed}: ${lines.join('; ')}${more}`,
    };
  },
});

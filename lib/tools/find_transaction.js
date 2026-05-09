// lib/tools/find_transaction.js
//
// Natural-language transaction lookup. Filters progressively on customer name,
// payment method, date range, status, amount range, and a free-text query
// across customer_display_name + notes. Returns up to 10 matches as compact
// summaries so the AI can list them or hand the user one to drill into.
//
// All queries are workspace-scoped. The contact join is intentional but
// optional (LEFT JOIN against the user_id-scoped contacts table) so we
// surface customer name and email/phone when available.

const registry = require('../tool-registry');

registry.register({
  name: 'find_transaction',
  description: 'Find transactions matching a query, customer name, payment method, date range, status, or amount range. Returns up to 10 summaries (id, customer, total, date, status, payment method). Use for natural-language lookups like "find Maria\'s last transaction" or "show me cash payments this week".',
  vertical: 'professional-services',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text query to match against customer name or notes.' },
      customer_name: { type: 'string' },
      payment_method: { type: 'string' },
      status: { type: 'string', description: 'draft, pending, paid, partially_paid, unpaid, refunded, voided' },
      date_range_start: { type: 'string', description: 'ISO date YYYY-MM-DD (inclusive).' },
      date_range_end: { type: 'string', description: 'ISO date YYYY-MM-DD (inclusive).' },
      min_amount_cents: { type: 'integer' },
      max_amount_cents: { type: 'integer' },
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const where = ['t.workspace_id = $1'];
    const params = [ctx.workspace.id];
    let idx = 2;

    if (input.customer_name && String(input.customer_name).trim()) {
      where.push(`LOWER(t.customer_display_name) LIKE $${idx++}`);
      params.push('%' + String(input.customer_name).toLowerCase().trim() + '%');
    }
    if (input.payment_method) {
      where.push(`t.payment_method = $${idx++}`);
      params.push(String(input.payment_method).toLowerCase());
    }
    if (input.status) {
      where.push(`t.status = $${idx++}`);
      params.push(String(input.status).toLowerCase());
    }
    if (input.date_range_start) {
      where.push(`COALESCE(t.payment_received_at, t.created_at) >= $${idx++}::timestamptz`);
      params.push(input.date_range_start);
    }
    if (input.date_range_end) {
      where.push(`COALESCE(t.payment_received_at, t.created_at) <= ($${idx++}::date + INTERVAL '1 day')`);
      params.push(input.date_range_end);
    }
    if (input.min_amount_cents != null) {
      where.push(`t.total_cents >= $${idx++}`);
      params.push(parseInt(input.min_amount_cents, 10) || 0);
    }
    if (input.max_amount_cents != null) {
      where.push(`t.total_cents <= $${idx++}`);
      params.push(parseInt(input.max_amount_cents, 10) || 0);
    }
    if (input.query && String(input.query).trim()) {
      const q = '%' + String(input.query).toLowerCase().trim() + '%';
      where.push(`(LOWER(t.customer_display_name) LIKE $${idx} OR LOWER(COALESCE(t.notes_internal,'')) LIKE $${idx} OR LOWER(COALESCE(t.notes_customer,'')) LIKE $${idx})`);
      params.push(q);
      idx++;
    }

    const sql = `
      SELECT t.id, t.customer_display_name, t.total_cents, t.status,
             t.payment_method, t.created_at, t.payment_received_at, t.source,
             t.appointment_id, t.parent_transaction_id
        FROM transactions t
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(t.payment_received_at, t.created_at) DESC, t.id DESC
       LIMIT 10
    `;

    let rows;
    try {
      const r = await ctx.db.query(sql, params);
      rows = r.rows;
    } catch (err) {
      ctx.logger.error('[find_transaction] query failed:', err.message);
      return { success: false, message: `Could not search transactions: ${err.message}` };
    }

    if (rows.length === 0) {
      return {
        success: true,
        data: { transactions: [] },
        message: 'No transactions matched those filters.',
      };
    }

    const summaries = rows.map(r => ({
      id: r.id,
      customer: r.customer_display_name,
      total_cents: r.total_cents,
      total: '$' + (r.total_cents / 100).toFixed(2),
      status: r.status,
      payment_method: r.payment_method,
      date: (r.payment_received_at || r.created_at).toISOString().slice(0, 10),
      source: r.source,
      appointment_id: r.appointment_id,
      is_refund: r.parent_transaction_id != null,
    }));

    const lines = summaries.slice(0, 5).map(s =>
      `#${s.id} ${s.customer} — ${s.total} ${s.status}${s.payment_method ? ' (' + s.payment_method + ')' : ''} on ${s.date}`
    );
    const more = summaries.length > 5 ? ` (+${summaries.length - 5} more)` : '';

    return {
      success: true,
      data: { transactions: summaries },
      message: `Found ${summaries.length} transaction${summaries.length === 1 ? '' : 's'}: ${lines.join('; ')}${more}`,
    };
  },
});

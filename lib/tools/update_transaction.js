// lib/tools/update_transaction.js
//
// Update a draft or pending transaction. Cannot edit transactions in
// terminal states (paid, refunded, voided) — those need a refund or void
// path, not an edit. parent_transaction_id and source are immutable.
// Recomputes totals on every update from the (potentially new) line_items.

const registry = require('../tool-registry');

function computeLineTotal(item) {
  const qty = Math.max(0, parseInt(item.quantity, 10) || 1);
  const unit = parseInt(item.unit_price_cents, 10) || 0;
  return qty * unit;
}

registry.register({
  name: 'update_transaction',
  description: 'Update a draft or pending transaction. Cannot edit a transaction that is paid, refunded, or voided. Use this to adjust line items, tax, tip, discount, payment method, or notes before completing.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'integer' },
      customer_name: { type: 'string' },
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'integer' },
            unit_price_cents: { type: 'integer' },
            type: { type: 'string' },
          },
        },
      },
      tax_cents: { type: 'integer' },
      tip_cents: { type: 'integer' },
      discount_cents: { type: 'integer' },
      payment_method: { type: 'string' },
      notes_internal: { type: 'string' },
      notes_customer: { type: 'string' },
    },
    required: ['transaction_id'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const { transaction_id } = input;
    if (!transaction_id) return { success: false, message: 'transaction_id is required.' };

    const found = await ctx.db.query(
      `SELECT * FROM transactions WHERE id = $1 AND workspace_id = $2`,
      [transaction_id, ctx.workspace.id]
    );
    if (found.rows.length === 0) {
      return { success: false, message: `No transaction with id ${transaction_id} in this workspace.` };
    }
    const tx = found.rows[0];
    if (!['draft', 'pending'].includes(tx.status)) {
      return { success: false, message: `Cannot edit a ${tx.status} transaction. Only draft and pending transactions are editable.` };
    }

    // Build updated line_items if provided; otherwise reuse existing
    let line_items = tx.line_items;
    if (Array.isArray(input.line_items)) {
      line_items = input.line_items.map(it => {
        const total_cents = computeLineTotal(it);
        return {
          description: String(it.description || 'Item'),
          quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
          unit_price_cents: parseInt(it.unit_price_cents, 10) || 0,
          total_cents,
          type: it.type || 'other',
        };
      });
    }

    const tax_cents = input.tax_cents != null ? parseInt(input.tax_cents, 10) : tx.tax_cents;
    const tip_cents = input.tip_cents != null ? parseInt(input.tip_cents, 10) : tx.tip_cents;
    const discount_cents = input.discount_cents != null ? parseInt(input.discount_cents, 10) : tx.discount_cents;
    const subtotal_cents = (Array.isArray(line_items) ? line_items : []).reduce((s, i) => s + (i.total_cents || 0), 0);
    const total_cents = Math.max(0, subtotal_cents + tax_cents + tip_cents - discount_cents);

    try {
      const r = await ctx.db.query(
        `UPDATE transactions SET
           customer_display_name = COALESCE($1, customer_display_name),
           line_items = $2::jsonb,
           subtotal_cents = $3,
           tax_cents = $4,
           tip_cents = $5,
           discount_cents = $6,
           total_cents = $7,
           payment_method = COALESCE($8, payment_method),
           notes_internal = COALESCE($9, notes_internal),
           notes_customer = COALESCE($10, notes_customer),
           updated_at = NOW()
         WHERE id = $11 AND workspace_id = $12
         RETURNING id, total_cents, status`,
        [
          input.customer_name || null,
          JSON.stringify(line_items),
          subtotal_cents, tax_cents, tip_cents, discount_cents, total_cents,
          input.payment_method || null,
          input.notes_internal || null,
          input.notes_customer || null,
          transaction_id, ctx.workspace.id,
        ]
      );
      const out = r.rows[0];
      return {
        success: true,
        data: { transaction_id: out.id, total_cents: out.total_cents, status: out.status },
        message: `Updated transaction #${out.id}: $${(out.total_cents / 100).toFixed(2)} (${out.status}).`,
      };
    } catch (err) {
      ctx.logger.error('[update_transaction] failed:', err.message);
      return { success: false, message: `Could not update transaction: ${err.message}` };
    }
  },
});

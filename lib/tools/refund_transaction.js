// lib/tools/refund_transaction.js — AP3, approval-gated.
// Mirrors POST /api/transactions/:id/refund exactly: a linked negative
// ledger transaction (source='refund') plus the parent's
// amount_refunded_cents/status update. Money movement always queues
// for owner approval; the FD2 engine gate keeps customers away.

const registry = require('../tool-registry');

registry.register({
  name: 'refund_transaction',
  description: 'Issue a refund against a paid or partially-paid transaction by id. Creates a linked refund record and updates the parent (fully refunded → status "refunded"). Requires owner approval.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'integer' },
      amount_cents: { type: 'integer', description: 'Refund amount in cents, positive.' },
      reason: { type: 'string' },
    },
    required: ['transaction_id', 'amount_cents', 'reason'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  async execute(input, ctx) {
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      return { success: false, message: 'Only the business owner can issue refunds.' };
    }
    const { transaction_id, amount_cents, reason } = input;
    if (!transaction_id) return { success: false, message: 'transaction_id is required.' };
    if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
      return { success: false, message: 'amount_cents must be a positive integer.' };
    }
    if (!reason || !String(reason).trim()) return { success: false, message: 'reason is required.' };

    const parentR = await ctx.db.query(
      `SELECT * FROM transactions WHERE id = $1 AND workspace_id = $2`,
      [transaction_id, ctx.workspace.id]
    );
    if (!parentR.rows.length) return { success: false, message: `No transaction with id ${transaction_id}.` };
    const parent = parentR.rows[0];
    if (!['paid', 'partially_paid'].includes(parent.status)) {
      return { success: false, message: `Cannot refund a ${parent.status} transaction.` };
    }
    const remaining = parent.total_cents - (parent.amount_refunded_cents || 0);
    if (amount_cents > remaining) {
      return { success: false, message: `Refund exceeds the remaining unrefunded amount ($${(remaining / 100).toFixed(2)}).` };
    }

    const refundLineItems = [{
      description: `Refund: ${reason}`,
      quantity: 1,
      unit_price_cents: -amount_cents,
      total_cents: -amount_cents,
      type: 'fee',
    }];
    const ins = await ctx.db.query(
      `INSERT INTO transactions
         (workspace_id, contact_id, appointment_id, parent_transaction_id,
          customer_display_name, line_items, subtotal_cents, total_cents,
          amount_paid_cents, payment_method, status, source, refund_reason,
          created_by_user_id, payment_received_at, notes_internal)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7,$7,$8,'paid','refund',$9,$10,NOW(),$11)
       RETURNING id`,
      [ctx.workspace.id, parent.contact_id, parent.appointment_id, parent.id,
        parent.customer_display_name, JSON.stringify(refundLineItems),
        -amount_cents, parent.payment_method || 'other',
        String(reason), ctx.user.id,
        `Refund of ${(amount_cents / 100).toFixed(2)} from transaction #${parent.id}`]
    );
    const newRefunded = (parent.amount_refunded_cents || 0) + amount_cents;
    const newStatus = newRefunded >= parent.total_cents ? 'refunded' : parent.status;
    await ctx.db.query(
      `UPDATE transactions SET amount_refunded_cents = $1, status = $2, updated_at = NOW()
        WHERE id = $3 AND workspace_id = $4`,
      [newRefunded, newStatus, parent.id, ctx.workspace.id]
    );
    return {
      success: true,
      data: { refund_transaction_id: ins.rows[0].id, parent_status: newStatus },
      // TR2 (G2 honesty): "recorded", never "refunded" alone — this
      // tool writes the books; it does not move money. The owner
      // hears the Stripe-dashboard step for card payments.
      message: `Recorded a $${(amount_cents / 100).toFixed(2)} refund on transaction #${parent.id} (${newStatus === 'refunded' ? 'fully refunded' : 'partial'}). No money moved — if this was a card payment, also process the refund in the Stripe dashboard.`,
      summary: `Record $${(amount_cents / 100).toFixed(2)} refund on transaction #${parent.id}`,
    };
  },
});

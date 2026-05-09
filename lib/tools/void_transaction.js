// lib/tools/void_transaction.js
//
// Void a transaction: sets status='voided', stamps voided_at + voided_by_user_id
// + void_reason. Use only for transactions that were created in error or that
// never represented a real payment. PAID and REFUNDED transactions cannot be
// voided — those need a refund flow. The original is never edited; voided
// transactions stay in the ledger with the void marker for audit trail.

const registry = require('../tool-registry');

registry.register({
  name: 'void_transaction',
  description: 'Void a draft, pending, or unpaid transaction (mark it canceled). Use only for transactions created in error or never paid. Cannot void a paid or refunded transaction — those need a refund instead. The transaction stays in the ledger marked voided for audit trail.',
  vertical: 'professional-services',
  category: 'delete',
  schema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'integer' },
      reason: { type: 'string', description: 'Why this transaction is being voided.' },
    },
    required: ['transaction_id', 'reason'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const { transaction_id, reason } = input;
    if (!transaction_id) return { success: false, message: 'transaction_id is required.' };
    if (!reason || !String(reason).trim()) return { success: false, message: 'reason is required.' };

    const found = await ctx.db.query(
      `SELECT id, status FROM transactions WHERE id = $1 AND workspace_id = $2`,
      [transaction_id, ctx.workspace.id]
    );
    if (found.rows.length === 0) {
      return { success: false, message: `No transaction with id ${transaction_id} in this workspace.` };
    }
    const tx = found.rows[0];
    if (['paid', 'partially_paid', 'refunded'].includes(tx.status)) {
      return { success: false, message: `Cannot void a ${tx.status} transaction. Issue a refund instead.` };
    }
    if (tx.status === 'voided') {
      return { success: false, message: `Transaction #${transaction_id} is already voided.` };
    }

    try {
      await ctx.db.query(
        `UPDATE transactions SET
           status = 'voided',
           voided_at = NOW(),
           voided_by_user_id = $1,
           void_reason = $2,
           updated_at = NOW()
         WHERE id = $3 AND workspace_id = $4`,
        [ctx.user.id, String(reason).trim(), transaction_id, ctx.workspace.id]
      );
    } catch (err) {
      ctx.logger.error('[void_transaction] update failed:', err.message);
      return { success: false, message: `Could not void transaction: ${err.message}` };
    }

    return {
      success: true,
      data: { transaction_id },
      message: `Voided transaction #${transaction_id}. Reason: ${String(reason).trim()}`,
    };
  },
});

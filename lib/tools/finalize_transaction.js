// lib/tools/finalize_transaction.js
//
// Finalize (issue) a DRAFT transaction: draft/pending -> 'unpaid', so a
// payment request can be sent against its full balance. A draft is a
// work-in-progress that owes nothing yet; finalizing "issues" it — the
// customer now owes the balance. This is the missing writer of the
// 'unpaid' status for MANUALLY-created transactions (create_transaction
// only ever writes 'draft'; the readers — find_outstanding_balance,
// request_payments_batch, the reports — already recognize 'unpaid').
//
// NOT money-moving (no charge, no ledger row), so no approval gate. The
// owner's explicit "finalize and send" confirmation in chat is what
// authorizes it — the assistant never finalizes a draft on its own
// (no silent auto-finalize).

const registry = require('../tool-registry');
const { formatCents } = require('../money');

registry.register({
  name: 'finalize_transaction',
  description: 'Finalize (issue) a DRAFT transaction so its balance can be charged or requested — moves it from draft to unpaid. Use this when the owner confirms they want to send a payment request for a transaction that is still a draft ("finalize and send"). Does not move money and does not require approval; it only issues the transaction. Refuses anything that is not a draft/pending (an already-issued, paid, refunded, or voided transaction is not re-finalized).',
  vertical: 'professional-services',
  category: 'update',
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  schema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'integer', description: 'The draft transaction to finalize.' },
    },
    required: ['transaction_id'],
  },
  async execute(input, ctx) {
    const txId = parseInt(input && input.transaction_id, 10);
    if (!txId) return { success: false, message: 'transaction_id is required.' };

    let tx;
    try {
      const r = await ctx.db.query(
        `SELECT id, status, total_cents, amount_paid_cents FROM transactions WHERE id = $1 AND workspace_id = $2`,
        [txId, ctx.workspace.id]
      );
      tx = r.rows[0];
    } catch (err) {
      ctx.logger.error('[finalize_transaction] lookup failed for ' + txId + ':', err.message);
      return { success: false, message: `Could not look up transaction #${txId}: ${err.message}` };
    }
    if (!tx) return { success: false, message: `No transaction #${txId} in this workspace.` };
    if (!['draft', 'pending'].includes(tx.status)) {
      return { success: false, message: `Transaction #${txId} is already ${tx.status}, not a draft — nothing to finalize.` };
    }
    if (tx.total_cents <= 0) {
      return { success: false, message: `Transaction #${txId} has no balance to finalize (add line items first).` };
    }
    if (tx.amount_paid_cents > 0) {
      // A draft with a recorded payment should already have rolled up via
      // the ledger; refuse rather than mislabel it 'unpaid'.
      return { success: false, message: `Transaction #${txId} already has a payment recorded — it isn't an unissued draft.` };
    }

    try {
      const r = await ctx.db.query(
        `UPDATE transactions SET status = 'unpaid', updated_at = NOW()
          WHERE id = $1 AND workspace_id = $2 AND status IN ('draft', 'pending') AND amount_paid_cents = 0
          RETURNING id, status, total_cents`,
        [txId, ctx.workspace.id]
      );
      const out = r.rows[0];
      if (!out) return { success: false, message: `Transaction #${txId} could not be finalized (it may have changed).` };
      return {
        success: true,
        data: { transaction_id: out.id, status: out.status, total_cents: out.total_cents },
        message: `Finalized transaction #${out.id}: ${formatCents(out.total_cents)} is now unpaid and ready for a payment request.`,
      };
    } catch (err) {
      ctx.logger.error('[finalize_transaction] update failed:', err.message);
      return { success: false, message: `Could not finalize transaction #${txId}: ${err.message}` };
    }
  },
});

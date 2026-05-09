// lib/tools/complete_transaction.js
//
// Mark a transaction as paid (or partially_paid based on amount_paid vs total).
// Stamps payment_received_at. Triggers receipt sending via lib/receipts.js.
//
// Critical rule: receipt-send failure must NOT fail the completion. The
// transaction is canonical; the receipt is a side effect. We log failures
// and report them in the message but the transaction is still marked paid.

const registry = require('../tool-registry');
const receipts = require('../receipts');

registry.register({
  name: 'complete_transaction',
  description: 'Finalize a transaction: mark it paid (or partially paid), stamp payment received, and trigger a receipt send to the customer (email if available, SMS otherwise, save if neither). Use this when the user confirms a transaction has been paid in cash, on a card, or any other channel — Modern Management does not process the payment, only records it.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'integer' },
      amount_paid_cents: { type: 'integer', description: 'Amount the customer paid. Defaults to the transaction total.' },
      payment_method: { type: 'string', description: 'cash, card, venmo, zelle, gift_card, other' },
      tip_cents: { type: 'integer', description: 'Tip received at completion (added to existing tip_cents).' },
      send_receipt: { type: 'boolean', description: 'Send receipt to customer? Defaults to true.' },
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
    let tx = found.rows[0];
    if (['paid', 'refunded', 'voided'].includes(tx.status)) {
      return { success: false, message: `Transaction #${transaction_id} is already ${tx.status}.` };
    }

    // Recompute totals if a tip is added at completion
    const additionalTip = parseInt(input.tip_cents, 10) || 0;
    const newTipCents = tx.tip_cents + additionalTip;
    const newTotalCents = tx.subtotal_cents + tx.tax_cents + newTipCents - tx.discount_cents;
    const amountPaid = input.amount_paid_cents != null
      ? parseInt(input.amount_paid_cents, 10)
      : newTotalCents;
    const paymentMethod = input.payment_method || tx.payment_method || 'other';

    const newStatus = amountPaid >= newTotalCents ? 'paid' : (amountPaid > 0 ? 'partially_paid' : 'unpaid');

    try {
      const r = await ctx.db.query(
        `UPDATE transactions SET
           tip_cents = $1,
           total_cents = $2,
           amount_paid_cents = $3,
           payment_method = $4,
           status = $5,
           payment_received_at = COALESCE(payment_received_at, NOW()),
           updated_at = NOW()
         WHERE id = $6 AND workspace_id = $7
         RETURNING *`,
        [newTipCents, newTotalCents, amountPaid, paymentMethod, newStatus,
         transaction_id, ctx.workspace.id]
      );
      tx = r.rows[0];
    } catch (err) {
      ctx.logger.error('[complete_transaction] update failed:', err.message);
      return { success: false, message: `Could not complete transaction: ${err.message}` };
    }

    // Receipt send — best-effort. Failure does NOT fail the completion.
    let receiptResult = { sent_via: 'skipped' };
    const sendReceipt = input.send_receipt !== false; // default true
    if (sendReceipt) {
      try {
        // Look up the contact for email/phone (contacts is user_id-scoped)
        let contact = null;
        if (tx.contact_id) {
          const c = await ctx.db.query(
            `SELECT * FROM contacts WHERE id = $1 AND user_id = $2`,
            [tx.contact_id, ctx.workspace.owner_user_id]
          );
          contact = c.rows[0] || null;
        }
        receiptResult = await receipts.sendReceipt({
          transaction: tx,
          workspace: ctx.workspace,
          contact,
          db: ctx.db,
          sendgrid: ctx.mailer,
          twilio: ctx.sms,
          env: ctx.env,
          logger: ctx.logger,
        });
      } catch (err) {
        ctx.logger.error('[complete_transaction] receipt send threw:', err.message);
        receiptResult = { sent_via: 'error', reason: err.message };
      }
    }

    const totalDollars = (tx.total_cents / 100).toFixed(2);
    let receiptMsg = '';
    if (receiptResult.sent_via === 'email') receiptMsg = ' Receipt emailed.';
    else if (receiptResult.sent_via === 'sms') receiptMsg = ' Receipt sent via SMS.';
    else if (receiptResult.sent_via === 'none') receiptMsg = ' Receipt saved (no email/phone on file).';
    else if (receiptResult.sent_via === 'skipped') receiptMsg = ' Receipt skipped.';

    return {
      success: true,
      data: {
        transaction_id: tx.id,
        status: tx.status,
        total_cents: tx.total_cents,
        receipt: receiptResult,
      },
      message: `Completed transaction #${tx.id}: $${totalDollars} ${tx.status} via ${tx.payment_method}.${receiptMsg}`,
    };
  },
});

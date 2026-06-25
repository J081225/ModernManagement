// lib/tools/request_payments_batch.js
//
// E14 Stage 2: AI-proposed batch of customer payment requests, gated by
// the owner-approval queue (pending_actions). The AI populates a list of
// {transaction_id, customer_name, amount_cents?, payment_type?} entries
// from the outstanding-balance data already in its context. The proposal
// is queued for owner review (requiresApproval: true) — nothing sends at
// proposal time.
//
// AT APPROVAL TIME (when the owner clicks Approve on the queue entry),
// /api/pending-actions/:id/approve runs tool.execute(pending.input, ctx)
// with a fresh ctx. This file's execute() does, per recipient:
//
//   1) LIVE re-check: re-query the transaction to confirm it's still
//      partially_paid/unpaid AND total_cents > amount_paid_cents.
//      If the customer paid (or the tx was voided/refunded) between
//      proposal and approval, SKIP silently with reason='already_settled'.
//   2) DETERMINE AMOUNT: use the explicit amount_cents if provided and
//      positive; otherwise use the CURRENT remaining at approval time.
//      Live remaining is the right default because the AI's proposed
//      amount may be stale (customer might have made a partial payment).
//   3) DELEGATE to lib/payment-requests.createPaymentRequest. The helper
//      enforces every gate (workspace vertical, Connect ready, amount
//      vs remaining) and runs the double-send guard — if a pending row
//      already exists for the transaction, the helper returns
//      reason='already_pending' and the tool records the skip without
//      texting the customer twice.
//   4) COLLECT outcomes. A single recipient's failure is recorded as a
//      skip; the loop CONTINUES so one bad row doesn't abort the batch.
//
// Returns { success: true, data: { sent, skipped }, message } with a
// plain-language summary suitable for the AI to read back to the owner.

const registry = require('../tool-registry');
const paymentRequests = require('../payment-requests');

registry.register({
  name: 'request_payments_batch',
  description: 'Send Stripe Checkout payment-request links to one or more customers who currently owe money. Each link is a secure direct charge on the salon\'s Stripe Connect account; the salon keeps 100%. Defaults to each customer\'s full remaining balance unless amount_cents is given per request. REQUIRES OWNER APPROVAL before anything sends — the proposed batch lands in the approval queue and the owner reviews before any text goes out. On approval, balances are re-checked live: any customer who paid in full between proposal and approval, or who already has a pending payment request open, is skipped silently. Use this for "text everyone who owes" / "send Maria and José their payment links" / "request the outstanding balance from this group".',
  vertical: 'professional-services',
  category: 'external-facing',
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: true,
  schema: {
    type: 'object',
    properties: {
      requests: {
        type: 'array',
        description: 'One entry per customer to text. The AI should populate customer_name from the outstanding-balance data in context so the approval queue chip is readable. Omit amount_cents to charge the full remaining balance (recommended — the live remaining is computed at approval time).',
        items: {
          type: 'object',
          properties: {
            transaction_id: { type: 'integer', description: 'The transaction id carrying the unpaid balance.' },
            customer_name: { type: 'string', description: 'Customer display name. Cosmetic — used for the approval-queue summary; the tool re-resolves the transaction at approval time.' },
            amount_cents: { type: 'integer', description: 'Optional: specific amount to request, in cents. If omitted, the customer\'s full remaining balance at approval time is used.' },
            payment_type: { type: 'string', enum: ['deposit', 'payment'], description: 'Defaults to "payment" if omitted.' },
          },
          required: ['transaction_id', 'customer_name'],
        },
      },
    },
    required: ['requests'],
  },
  async execute(input, ctx) {
    const requests = Array.isArray(input && input.requests) ? input.requests : [];
    if (requests.length === 0) {
      return { success: false, message: 'No payment requests provided.' };
    }

    const sent = [];
    const skipped = [];

    for (const entry of requests) {
      const txId = parseInt(entry && entry.transaction_id, 10);
      const customerName = (entry && entry.customer_name) || (txId ? `transaction #${txId}` : 'transaction');
      const paymentType = (entry && entry.payment_type === 'deposit') ? 'deposit' : 'payment';

      if (!txId) {
        skipped.push({
          customer: customerName,
          transaction_id: entry && entry.transaction_id,
          reason: 'invalid_transaction_id',
        });
        continue;
      }

      // 1) LIVE re-check: still partially_paid/unpaid + total > paid?
      let tx;
      try {
        const r = await ctx.db.query(
          `SELECT id, status, total_cents, amount_paid_cents
             FROM transactions
            WHERE id = $1 AND workspace_id = $2`,
          [txId, ctx.workspace.id]
        );
        tx = r.rows[0];
      } catch (err) {
        ctx.logger.error('[request_payments_batch] tx lookup failed for ' + txId + ':', err.message);
        skipped.push({ customer: customerName, transaction_id: txId, reason: 'lookup_error', detail: err.message });
        continue;
      }

      if (!tx) {
        skipped.push({ customer: customerName, transaction_id: txId, reason: 'not_found' });
        continue;
      }
      if (!['partially_paid', 'unpaid'].includes(tx.status) || tx.total_cents <= tx.amount_paid_cents) {
        skipped.push({
          customer: customerName,
          transaction_id: txId,
          reason: 'already_settled',
          status: tx.status,
        });
        continue;
      }

      // 2) DETERMINE AMOUNT — explicit if provided + positive, else live remaining.
      const liveRemaining = tx.total_cents - tx.amount_paid_cents;
      const explicitAmount = (entry && entry.amount_cents != null)
        ? parseInt(entry.amount_cents, 10)
        : null;
      const amountCents = (explicitAmount != null && explicitAmount > 0)
        ? explicitAmount
        : liveRemaining;

      // 3) DELEGATE — the helper handles gates, Stripe session, ledger row,
      //    SMS, and the double-send guard.
      let result;
      try {
        result = await paymentRequests.createPaymentRequest({
          pool:          ctx.db,
          stripe:        ctx.stripe,
          twilio:        ctx.sms,
          env:           ctx.env,
          workspace:     ctx.workspace,
          transactionId: txId,
          paymentType,
          amountCents,
          actorUserId:   ctx.user && ctx.user.id,
          logger:        ctx.logger,
        });
      } catch (err) {
        // Defensive: createPaymentRequest currently doesn't throw on
        // business errors (it returns success:false with a reason), but
        // a programmer-error throw (e.g., Stripe SDK 5xx surfaced as
        // unhandled) should not abort the rest of the batch.
        ctx.logger.error('[request_payments_batch] helper threw for tx ' + txId + ':', err.message);
        skipped.push({ customer: customerName, transaction_id: txId, reason: 'send_error', detail: err.message });
        continue;
      }

      // 4) COLLECT OUTCOMES — already_pending is a soft skip, not a hard error.
      if (result.success) {
        sent.push({
          customer: customerName,
          transaction_id: txId,
          payment_id: result.payment_id,
          amount_cents: amountCents,
          payment_type: paymentType,
          texted: result.texted,
          url: result.url,
        });
      } else if (result.reason === 'already_pending') {
        skipped.push({ customer: customerName, transaction_id: txId, reason: 'already_pending' });
      } else {
        skipped.push({
          customer: customerName,
          transaction_id: txId,
          reason: result.reason || 'send_failed',
          detail: result.message,
        });
      }
    }

    // Plain-language summary for the AI to read back.
    const sentCount = sent.length;
    const skippedSettled = skipped.filter(s => s.reason === 'already_settled').length;
    const skippedPending = skipped.filter(s => s.reason === 'already_pending').length;
    const skippedOther   = skipped.length - skippedSettled - skippedPending;

    const bits = [`Sent ${sentCount} payment request${sentCount === 1 ? '' : 's'}`];
    const skipBits = [];
    if (skippedSettled) skipBits.push(`${skippedSettled} (already paid)`);
    if (skippedPending) skipBits.push(`${skippedPending} (already pending)`);
    if (skippedOther)   skipBits.push(`${skippedOther} (other)`);
    if (skipBits.length) bits.push(`skipped ${skipBits.join(', ')}`);
    const message = bits.join('; ') + '.';

    return {
      success: true,
      data: { sent, skipped },
      message,
    };
  },
});

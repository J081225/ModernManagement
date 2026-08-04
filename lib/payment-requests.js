// lib/payment-requests.js
//
// E14 Stage 1: pure function that runs a single "ask the customer to pay
// a specific amount" operation. Called by:
//   - POST /api/transactions/:id/request-payment   (today, button-driven)
//   - a future AI tool that proposes payment-request batches  (next stage)
//
// NO Express req/res — caller does the HTTP plumbing. Caller passes the
// resolved workspace row in; this function does the gates, the Stripe
// Checkout Session creation (direct charge on the connected account),
// the ledger pending-row insert, and the best-effort SMS.
//
// Returns `{ success, ... }`. On failure every branch sets a `reason`
// code so callers can map to HTTP status without string-matching `message`:
//   stripe_not_configured, invalid_input, workspace_not_found,
//   not_ps_workspace, connect_not_ready, transaction_not_found,
//   nothing_owed, amount_exceeds_remaining, already_pending,
//   stripe_session_failed, ledger_insert_failed.
//
// Double-send guard (Stage 1's safety requirement): before creating a new
// Stripe session, we check transaction_payments for any existing
// status='pending' row for this transaction. If one exists, we return
// reason='already_pending' WITHOUT creating a second session or sending
// a second text. Protects against double-clicks on the modal button and
// a future AI batch tool re-requesting the same customer. Once the
// customer pays (the row flips to 'completed' via webhook) or the row
// is otherwise resolved, a fresh request is allowed.

const paymentLedger = require('./payment-ledger');
const { persistOutboundMessage } = require('./outbound-persist');
// SP4b: one decision for customer-facing sends — the workspace's own
// number or hold. The platform fallback is retired.
const { customerSmsFrom } = require('./workspace-readiness');

/**
 * @param {Object} args
 * @param {import('pg').Pool} args.pool
 * @param {import('stripe').Stripe} args.stripe   - the stripeSignup (test-mode) client
 * @param {Object} args.twilio                    - the twilioClient (may be null in test envs)
 * @param {NodeJS.ProcessEnv} args.env
 * @param {Object} args.workspace                 - row with id, vertical, business_name,
 *                                                  owner_user_id, twilio_phone_number,
 *                                                  stripe_connect_account_id, connect_status
 * @param {number} args.transactionId
 * @param {string} args.paymentType               - 'deposit' | 'payment'
 * @param {number} args.amountCents               - positive integer
 * @param {number=} args.actorUserId
 * @param {Console=} args.logger
 * @returns {Promise<{success:boolean, url?:string, payment_id?:number, texted?:boolean, reason?:string, message?:string}>}
 */
async function createPaymentRequest({
  pool, stripe, twilio, env,
  workspace,
  transactionId,
  paymentType,
  amountCents,
  actorUserId = null,
  logger = console,
}) {
  // --- Input shape (defensive; the HTTP endpoint validates first too) ---
  if (!stripe) {
    return { success: false, reason: 'stripe_not_configured', message: 'Stripe not configured' };
  }
  if (!workspace || !workspace.id) {
    return { success: false, reason: 'workspace_not_found', message: 'workspace_not_found' };
  }
  if (!transactionId) {
    return { success: false, reason: 'invalid_input', message: 'Invalid transaction id' };
  }
  if (!['deposit', 'payment'].includes(paymentType)) {
    return { success: false, reason: 'invalid_input', message: "payment_type must be 'deposit' or 'payment'" };
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { success: false, reason: 'invalid_input', message: 'amount_cents must be a positive integer' };
  }

  // --- Workspace gates ---
  if (workspace.vertical !== 'professional-services') {
    return { success: false, reason: 'not_ps_workspace', message: 'PS workspaces only' };
  }
  if (workspace.connect_status !== 'ready' || !workspace.stripe_connect_account_id) {
    return { success: false, reason: 'connect_not_ready', message: "Card payments aren't set up yet." };
  }

  // --- Transaction lookup + remaining-owed (against completed ledger sum,
  //     not the rollup column, so a stale-rollup transaction can't over-charge) ---
  const txR = await pool.query(
    `SELECT id, contact_id, total_cents
       FROM transactions WHERE id = $1 AND workspace_id = $2`,
    [transactionId, workspace.id]
  );
  if (txR.rows.length === 0) {
    return { success: false, reason: 'transaction_not_found', message: 'Transaction not found' };
  }
  const tx = txR.rows[0];

  const sumR = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS s
       FROM transaction_payments
      WHERE transaction_id = $1 AND status = 'completed'`,
    [transactionId]
  );
  const completed = sumR.rows[0] ? sumR.rows[0].s : 0;
  const remaining = tx.total_cents - completed;
  if (remaining <= 0) {
    return {
      success: false,
      reason: 'nothing_owed',
      message: 'Nothing left to charge on this transaction',
    };
  }
  if (amountCents > remaining) {
    return {
      success: false,
      reason: 'amount_exceeds_remaining',
      message: `Amount exceeds remaining owed ($${(remaining / 100).toFixed(2)})`,
    };
  }

  // --- Double-send guard ---
  // Any existing pending row blocks a new request. Once the row flips to
  // 'completed' (webhook) or is otherwise resolved, a fresh request is
  // allowed. We block before creating the Stripe Session so we never
  // leave an orphaned session on the connected account.
  const pendR = await pool.query(
    `SELECT id FROM transaction_payments
      WHERE transaction_id = $1 AND status = 'pending'
      LIMIT 1`,
    [transactionId]
  );
  if (pendR.rows.length > 0) {
    return {
      success: false,
      reason: 'already_pending',
      message: 'A payment request is already pending for this transaction.',
    };
  }

  // --- Customer phone (best-effort; contacts is user_id-scoped, legacy) ---
  let customerPhone = null;
  if (tx.contact_id) {
    try {
      const c = await pool.query(
        `SELECT phone FROM contacts WHERE id = $1 AND user_id = $2`,
        [tx.contact_id, workspace.owner_user_id]
      );
      customerPhone = (c.rows[0] && c.rows[0].phone) || null;
    } catch (_) { /* non-fatal */ }
  }

  // --- Direct charge on the connected account.
  //     No application_fee_amount, no transfer_data — the salon receives 100%.
  //     metadata.transaction_id is the disambiguator the webhook reads to
  //     route this completion to the customer-payment handler.
  const base = (env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
  const productName = paymentType === 'deposit'
    ? `Deposit — ${workspace.business_name || 'service'}`
    : `Payment — ${workspace.business_name || 'service'}`;
  let session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: { name: productName },
          },
        }],
        success_url: `${base}/payments/customer/success`,
        cancel_url:  `${base}/payments/customer/cancel`,
        metadata: {
          transaction_id: String(transactionId),
          workspace_id:   String(workspace.id),
          payment_type:   paymentType,
        },
      },
      { stripeAccount: workspace.stripe_connect_account_id }
    );
  } catch (err) {
    logger.error('[payment-requests] checkout.sessions.create failed:', err.message);
    return {
      success: false,
      reason: 'stripe_session_failed',
      message: 'Could not create payment link',
      detail: err.message,
    };
  }

  // --- Pending ledger row keyed by the session id.
  //     The unique partial index on stripe_checkout_session_id is the
  //     webhook's idempotency anchor (migration 042) — a duplicate webhook
  //     delivery can't double-insert. ---
  let paymentId;
  try {
    const ins = await paymentLedger.recordPayment(pool, {
      workspace_id:               workspace.id,
      transaction_id:             transactionId,
      amount_cents:               amountCents,
      payment_type:               paymentType,
      payment_method:             'stripe',
      stripe_checkout_session_id: session.id,
      status:                     'pending',
      created_by_user_id:         actorUserId,
    });
    paymentId = ins.id;
  } catch (err) {
    logger.error('[payment-requests] ledger insert failed:', err.message);
    return {
      success: false,
      reason: 'ledger_insert_failed',
      message: 'Failed to record pending payment',
    };
  }

  // --- Best-effort SMS from the salon's Twilio number ---
  // SP4b: HOLD during the pending window. No platform-number fallback:
  // the link would arrive from an unfamiliar sender and any reply
  // would be an unroutable drop. The link is still returned to the
  // caller (the owner sees and can share it), so nothing is lost —
  // only the misleading text is withheld.
  let texted = false;
  const fromNum = customerSmsFrom(workspace);
  if (customerPhone && twilio && !fromNum) {
    logger.error('[payment-requests] HOLDING the link SMS — workspace ' + workspace.id +
      ' has no number yet (provisioning); the link is returned for the owner to share.');
  }
  if (customerPhone && twilio && fromNum) {
    try {
      const label = paymentType === 'deposit' ? 'deposit' : 'payment';
      const body = `${workspace.business_name || 'Your appointment'}: secure ${label} link for $${(amountCents / 100).toFixed(2)} — ${session.url}`;
      await twilio.messages.create({ from: fromNum, to: customerPhone, body });
      texted = true;
      // IB1: the link SMS is conversation the customer can see —
      // recorded as system-authored, linked to an open thread if one
      // exists (never minting one).
      await persistOutboundMessage({
        db: pool, workspace, channel: 'sms', to: customerPhone, body,
        sentBy: 'system', logger,
      });
    } catch (err) {
      logger.error('[payment-requests] SMS send failed (non-fatal):', err.message);
    }
  }

  return {
    success: true,
    url: session.url,
    payment_id: paymentId,
    texted,
    // SP4b: tell the caller WHY no text went out, so the UI can say
    // "share this link" instead of implying the customer was texted.
    sms_held: !!(customerPhone && twilio && !fromNum),
  };
}

module.exports = { createPaymentRequest };

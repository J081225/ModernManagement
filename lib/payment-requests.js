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
const { customerSmsFrom, cardsReady, activeProcessor } = require('./workspace-readiness');

// SEC item 7: expiry honesty. Return a usable Square access token,
// refreshing it if it is within a day of (or past) its 30-day expiry.
// If refresh FAILS, flip square_status='expired' and throw a tagged
// error so the payment path fails LOUDLY — never a silent send against
// a dead token. The thrown error carries { squareExpired: true } so the
// caller can notify the owner and surface the re-connect path.
async function ensureFreshSquareToken(pool, workspace, logger = console) {
  const { decryptToken, encryptToken } = require('./token-crypto');
  const { refreshAccessToken } = require('./square-connect');
  let accessToken = decryptToken(workspace.square_access_token_enc);
  const expMs = workspace.square_token_expires_at ? new Date(workspace.square_token_expires_at).getTime() : 0;
  const nearExpiry = !expMs || (expMs - Date.now()) < 24 * 60 * 60 * 1000;
  if (!nearExpiry) return accessToken;

  try {
    const refreshToken = decryptToken(workspace.square_refresh_token_enc);
    const tok = await refreshAccessToken({ refreshToken });
    await pool.query(
      `UPDATE workspaces
          SET square_access_token_enc = $2, square_refresh_token_enc = $3,
              square_token_expires_at = $4, square_status = 'connected'
        WHERE id = $1`,
      [workspace.id, encryptToken(tok.access_token), encryptToken(tok.refresh_token), tok.expires_at]
    );
    return tok.access_token;
  } catch (err) {
    logger.error('[square] token refresh FAILED for ws=' + workspace.id + '; flipping to expired:', err.message);
    try {
      await pool.query("UPDATE workspaces SET square_status = 'expired' WHERE id = $1", [workspace.id]);
    } catch (e) { logger.error('[square] could not flip square_status=expired:', e.message); }
    const e = new Error('Square connection expired — reconnect required.');
    e.squareExpired = true;
    throw e;
  }
}
// ST5a: canned customer strings declare their language variants; the
// SMS amount formats through the one money boundary.
const { customerString } = require('./customer-strings');
const { formatCents } = require('./money');

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
  // SQ4: Stripe is only required when Stripe is the active processor —
  // a Square workspace doesn't need it. The per-processor gate below
  // (cardsReady) is the real readiness check.
  if (workspace && activeProcessor(workspace) === 'stripe' && !stripe) {
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
  // SQ3/SQ4: gate on the derived helper — it answers "can the ACTIVE
  // processor accept a card right now?" for whichever processor is
  // active (Stripe ready OR Square connected). No raw-column check.
  if (!cardsReady(workspace)) {
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

  // --- Create the hosted link on the ACTIVE processor, then record the
  //     pending ledger row through the generic (processor, processor_ref)
  //     seam. SQ4: Stripe and Square differ only here; everything
  //     downstream (the pending row, the webhook completion, the
  //     rollup, receipts, the TR ledger) is shared. ---
  const base = (env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
  const proc = activeProcessor(workspace);
  let paymentLink;   // { url, processor, processor_ref, payment_method }
  try {
    if (proc === 'square') {
      const { createSquarePaymentLink } = require('./square-payments');
      // SEC item 7: ensure a fresh token before charging. If the access
      // token is past/near expiry, refresh it; if refresh FAILS, flip
      // square_status='expired' and fail loudly with a reason the
      // caller turns into an owner notice + re-connect path — never a
      // silent send.
      const accessToken = await ensureFreshSquareToken(pool, workspace, logger);
      const link = await createSquarePaymentLink({
        accessToken,
        amountCents,
        businessName: workspace.business_name,
        paymentType,
        // idempotency: one link per (transaction, type, amount) — a
        // retried request reuses it rather than minting a second.
        idempotencyKey: `sq-${workspace.id}-${transactionId}-${paymentType}-${amountCents}`,
        redirectUrl: `${base}/payments/customer/success`,
        referenceId: transactionId,
      });
      paymentLink = { url: link.url, processor: 'square', processor_ref: link.order_id, payment_method: 'square' };
    } else {
      const productName = paymentType === 'deposit'
        ? `Deposit — ${workspace.business_name || 'service'}`
        : `Payment — ${workspace.business_name || 'service'}`;
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [{
            quantity: 1,
            price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name: productName } },
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
      paymentLink = { url: session.url, processor: 'stripe', processor_ref: session.id, payment_method: 'stripe' };
    }
  } catch (err) {
    // Log the processor's error VERBATIM (status + body). err.message
    // already carries Square's `errors` array as JSON; squareStatus is
    // the HTTP status — a self-echoing generic log cost a diagnosis round.
    logger.error(`[payment-requests] ${proc} link creation FAILED (status ${err.squareStatus || '?'}):`, err.message);
    // SEC item 7: an expired Square token is a distinct, loud reason —
    // the caller notifies the owner and points at re-connect.
    if (err.squareExpired) {
      return { success: false, reason: 'square_token_expired', message: 'Square connection expired — please reconnect in Settings.' };
    }
    return {
      success: false,
      reason: proc === 'square' ? 'square_link_failed' : 'stripe_session_failed',
      message: 'Could not create payment link',
      detail: err.message,
    };
  }

  // --- Pending ledger row via the generic anchor. The unique
  //     (processor, processor_ref) index (migration 066) is the
  //     webhook's idempotency anchor for EITHER processor. ---
  let paymentId;
  try {
    const ins = await paymentLedger.recordPayment(pool, {
      workspace_id:       workspace.id,
      transaction_id:     transactionId,
      amount_cents:       amountCents,
      payment_type:       paymentType,
      payment_method:     paymentLink.payment_method,
      processor:          paymentLink.processor,
      processor_ref:      paymentLink.processor_ref,
      status:             'pending',
      created_by_user_id: actorUserId,
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

  // The rest of the function references `session.url` historically; the
  // generic link url is `paymentLink.url`.
  const session = { url: paymentLink.url };

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
  // A2P/TCPA: never text an opted-out number — the link still returns to
  // the owner (nothing lost), only the text is withheld. Structural
  // send-layer gate (see lib/sms-consent). Strict liability.
  const _custOptedOut = (customerPhone && twilio && fromNum)
    ? await require('./sms-consent').isOptedOut(pool, workspace.id, customerPhone)
    : false;
  if (_custOptedOut) {
    logger.error('[payment-requests] SUPPRESSED link SMS to opted-out ' + customerPhone +
      ' (ws ' + workspace.id + ') — link returned to owner only.');
  }
  // LP2a: demo workspaces never text (A2P pending) — link returns to owner.
  if (workspace.is_demo && customerPhone && twilio && fromNum) {
    logger.error('[payment-requests] SUPPRESSED link SMS from DEMO workspace ' +
      workspace.id + ' — demo lines never text.');
  }
  if (customerPhone && twilio && fromNum && !_custOptedOut && !workspace.is_demo) {
    try {
      // ST5a: the link SMS comes from the declared-variants module —
      // LANG unit 3: in the CONVERSATION's language (thread stamp from
      // the voice-menu pin), falling back to the workspace primary.
      const _linkLang = await require('./conversation-language')
        .conversationLanguage(pool, workspace, customerPhone, null);
      const body = customerString(_linkLang || 'en', 'payment_link_sms', {
        businessName: workspace.business_name || 'Your appointment',
        paymentType,
        amount: formatCents(amountCents),
        url: session.url,
      });
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

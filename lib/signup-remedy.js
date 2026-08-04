// lib/signup-remedy.js — SP4c.
//
// When signup orchestration fails, the customer's card has ALREADY
// been charged by Stripe Checkout (the charge happens before our
// webhook runs). SP4a removed the Twilio cause of that failure; what
// remains — a username race, a DB error — must never silently keep
// the money. This is the automated remedy: cancel the subscription,
// refund the charge, and escalate LOUDLY if the refund itself fails.
//
// Design notes:
// - IDEMPOTENT BY CONSTRUCTION. Stripe may redeliver a webhook, and a
//   failed orchestration leaves processed_at NULL, so the whole path
//   can run twice. Every mutating call carries an idempotency key
//   derived from the Stripe EVENT id, so a redelivery reuses the same
//   refund rather than issuing a second one. Stripe's
//   "already refunded / already canceled" errors are treated as
//   SUCCESS for the same reason.
// - Subscription-mode sessions usually have NO payment_intent on the
//   session; the money is on the first invoice. So the charge is
//   resolved: session.payment_intent -> else the subscription's
//   latest_invoice -> its payment_intent/charge.
// - NEVER THROWS. It returns a structured result the caller records;
//   a remedy that crashed the failure handler would be worse than the
//   failure.
// - Nothing was committed when this runs (the orchestrator rolled
//   back), so there is no owner account to notify — escalation is
//   operator-only. That is a deliberate, documented consequence.

function isAlreadyDone(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  const code = String((err && err.code) || '').toLowerCase();
  return code === 'charge_already_refunded'
    || msg.includes('already been refunded')
    || msg.includes('already refunded')
    || msg.includes('no such subscription')            // canceled + purged
    || msg.includes('subscription is already canceled')
    || msg.includes('canceled subscription');
}

// Find the charge/payment_intent behind a subscription-mode Checkout
// Session. Returns { paymentIntentId, chargeId } (either may be null).
async function resolveCharge(stripe, session, log) {
  const out = { paymentIntentId: null, chargeId: null };
  if (!stripe || !session) return out;
  if (session.payment_intent) {
    out.paymentIntentId = typeof session.payment_intent === 'string'
      ? session.payment_intent : session.payment_intent.id;
    return out;
  }
  // Subscription mode: the charge lives on the first invoice.
  try {
    let invoiceId = session.invoice
      ? (typeof session.invoice === 'string' ? session.invoice : session.invoice.id)
      : null;
    if (!invoiceId && session.subscription) {
      const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
      const sub = await stripe.subscriptions.retrieve(subId);
      invoiceId = sub && sub.latest_invoice
        ? (typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice.id)
        : null;
    }
    if (!invoiceId) return out;
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice) {
      if (invoice.payment_intent) {
        out.paymentIntentId = typeof invoice.payment_intent === 'string'
          ? invoice.payment_intent : invoice.payment_intent.id;
      }
      if (invoice.charge) {
        out.chargeId = typeof invoice.charge === 'string' ? invoice.charge : invoice.charge.id;
      }
    }
  } catch (err) {
    log.error('[signup-remedy] could not resolve the charge:', err.message);
  }
  return out;
}

// The remedy. Returns:
//   { subscription: 'canceled'|'already'|'none'|'failed',
//     refund: 'refunded'|'already'|'nothing_to_refund'|'failed',
//     refund_id, escalate: bool, errors: [...] }
async function remedyFailedSignup({ stripe, session, eventId, logger }) {
  const log = logger || console;
  const result = {
    subscription: 'none', refund: 'nothing_to_refund',
    refund_id: null, escalate: false, errors: [],
  };
  if (!stripe) {
    result.subscription = 'failed';
    result.refund = 'failed';
    result.escalate = true;
    result.errors.push('no stripe client configured');
    log.error('[signup-remedy] NO STRIPE CLIENT — cannot cancel or refund; manual remedy required');
    return result;
  }
  const key = String(eventId || 'unknown');

  // 1) Cancel the subscription so no further invoices are issued.
  const subId = session && session.subscription
    ? (typeof session.subscription === 'string' ? session.subscription : session.subscription.id)
    : null;
  if (subId) {
    try {
      await stripe.subscriptions.cancel(subId, { idempotencyKey: 'sp4c-cancel-' + key });
      result.subscription = 'canceled';
      log.error('[signup-remedy] canceled subscription ' + subId + ' after failed signup');
    } catch (err) {
      if (isAlreadyDone(err)) {
        result.subscription = 'already';
      } else {
        result.subscription = 'failed';
        result.escalate = true;
        result.errors.push('cancel: ' + err.message);
        log.error('[signup-remedy] FAILED to cancel subscription ' + subId + ':', err.message);
      }
    }
  }

  // 2) Refund the charge. A refund failure is the loud one — the
  //    customer is out real money until a human acts.
  const { paymentIntentId, chargeId } = await resolveCharge(stripe, session, log);
  if (!paymentIntentId && !chargeId) {
    // Nothing was actually captured (e.g. payment_status 'unpaid' —
    // an async/ACH payment that never settled). Honest, not a failure.
    result.refund = 'nothing_to_refund';
    log.error('[signup-remedy] no captured charge found for the failed signup — nothing to refund');
    return result;
  }
  try {
    const payload = paymentIntentId ? { payment_intent: paymentIntentId } : { charge: chargeId };
    const refund = await stripe.refunds.create(payload, { idempotencyKey: 'sp4c-refund-' + key });
    result.refund = 'refunded';
    result.refund_id = refund && refund.id ? refund.id : null;
    log.error('[signup-remedy] refunded ' + (paymentIntentId || chargeId) + ' after failed signup (refund ' + result.refund_id + ')');
  } catch (err) {
    if (isAlreadyDone(err)) {
      result.refund = 'already';
    } else {
      result.refund = 'failed';
      result.escalate = true;
      result.errors.push('refund: ' + err.message);
      // The one that must never be quiet.
      log.error('[signup-remedy] REFUND FAILED for ' + (paymentIntentId || chargeId) +
        ' — THE CUSTOMER HAS BEEN CHARGED WITH NO ACCOUNT. Manual refund required:', err.message);
    }
  }
  return result;
}

// A one-line, customer-safe summary for the status screen / logs.
function remedySummary(result) {
  if (!result) return 'no remedy attempted';
  if (result.refund === 'refunded' || result.refund === 'already') {
    return 'Your payment has been refunded and the subscription canceled.';
  }
  if (result.refund === 'nothing_to_refund') {
    return 'No payment was captured, and the subscription has been canceled.';
  }
  return 'We could not complete the automatic refund — our team has been alerted and will resolve it.';
}

module.exports = { remedyFailedSignup, remedySummary, resolveCharge, isAlreadyDone };

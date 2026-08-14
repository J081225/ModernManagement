// lib/square-payments.js — SQ4.
//
// Square-hosted payment links (create_payment_link), the Square
// analog of Stripe Checkout sessions. Uses the MERCHANT's decrypted
// access token (never ours). Sandbox base for this arc.
//
// The processor_ref anchor is the ORDER ID: create_payment_link
// returns it, and the payment.updated webhook carries payment.order_id
// — so the pending ledger row and the completion webhook match on the
// same value, exactly as Stripe uses the checkout session id.

// Same Connect API base as the OAuth lib — one source (lib/square-env),
// sandbox by default, flipped for production by SQUARE_ENV at SQ6.
const { squareBase } = require('./square-env');
const SQUARE_BASE = squareBase();
const SQUARE_VERSION = '2025-01-23';

function authHeaders(accessToken) {
  return {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Square-Version': SQUARE_VERSION,
  };
}

// The merchant's main location — quick_pay requires a location_id.
// Fetched on demand (no schema column); the first ACTIVE location, or
// the first location if none is flagged active.
async function getMainLocationId(accessToken) {
  const res = await fetch(`${SQUARE_BASE}/v2/locations`, { headers: authHeaders(accessToken) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data.locations) || data.locations.length === 0) {
    throw new Error('square locations lookup failed: ' + (data.errors ? JSON.stringify(data.errors) : res.status));
  }
  const active = data.locations.find((l) => l.status === 'ACTIVE');
  return (active || data.locations[0]).id;
}

// Create a hosted payment link. Returns { url, order_id }.
//   idempotencyKey — caller supplies a stable key (transaction+type) so
//     a retried request can't mint two links.
async function createSquarePaymentLink({
  accessToken, amountCents, businessName, paymentType, idempotencyKey, redirectUrl, referenceId,
}) {
  if (!accessToken) throw new Error('createSquarePaymentLink: missing merchant access token');
  const locationId = await getMainLocationId(accessToken);
  const label = paymentType === 'deposit' ? 'Deposit' : 'Payment';
  const body = {
    idempotency_key: idempotencyKey,
    quick_pay: {
      name: `${label} — ${businessName || 'service'}`,
      price_money: { amount: amountCents, currency: 'USD' },
      location_id: locationId,
    },
    checkout_options: redirectUrl ? { redirect_url: redirectUrl } : undefined,
    // reference_id ties the order back to our transaction for auditing;
    // the webhook match still uses order_id (returned below).
    order: referenceId ? { order: { location_id: locationId, reference_id: String(referenceId) } } : undefined,
  };
  const res = await fetch(`${SQUARE_BASE}/v2/online-checkout/payment-links`, {
    method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payment_link) {
    const err = new Error('square payment link failed: ' + (data.errors ? JSON.stringify(data.errors) : res.status));
    err.squareStatus = res.status;
    throw err;
  }
  return {
    url: data.payment_link.url,
    order_id: data.payment_link.order_id,
    payment_link_id: data.payment_link.id,
  };
}

module.exports = { createSquarePaymentLink, getMainLocationId, SQUARE_BASE };

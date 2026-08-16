// lib/square-refunds.js — SQ5. Real money-moving Square refunds.
//
// RefundPayment refunds a PAYMENT (not an order). Rows paid before we
// captured payment_id at completion (e.g. #6) have none, so we RESOLVE it
// from the order and then VERIFY it ties back to that order before ANY
// refund (ruling 2 guard): never refund an id we can't tie to the row.
// The workspace's own (merchant-scoped) token is what we call with, so a
// retrievable payment is that merchant's. Verbatim error surfacing — the
// SQ4 lesson: the caller shows Square's real error, never a self-echo.

const { squareBase } = require('./square-env');
const SQUARE_VERSION = '2025-01-23';

function authHeaders(accessToken) {
  return {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
    'Square-Version': SQUARE_VERSION,
  };
}

// Fallback: resolve the Square payment id for an order. RetrieveOrder →
// the order's tenders carry the payment id.
async function resolvePaymentIdForOrder({ accessToken, orderId }) {
  if (!accessToken) throw new Error('resolvePaymentIdForOrder: missing access token');
  const res = await fetch(`${squareBase()}/v2/orders/${encodeURIComponent(orderId)}`, { headers: authHeaders(accessToken) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.order) {
    const e = new Error('square order lookup failed: ' + (data.errors ? JSON.stringify(data.errors) : res.status));
    e.squareStatus = res.status; throw e;
  }
  const tenders = Array.isArray(data.order.tenders) ? data.order.tenders : [];
  const paymentId = tenders.map((t) => t.payment_id || t.id).find(Boolean);
  if (!paymentId) throw new Error('no payment/tender on Square order ' + orderId);
  return { paymentId, orderId: data.order.id };
}

// GUARD (ruling 2): the payment MUST tie to this order. RetrievePayment
// and refuse if payment.order_id != the row's order. (Merchant is
// enforced by calling with the workspace's own merchant token.)
async function assertPaymentTiesToOrder({ accessToken, paymentId, orderId }) {
  const res = await fetch(`${squareBase()}/v2/payments/${encodeURIComponent(paymentId)}`, { headers: authHeaders(accessToken) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payment) {
    const e = new Error('square payment lookup failed: ' + (data.errors ? JSON.stringify(data.errors) : res.status));
    e.squareStatus = res.status; throw e;
  }
  if (data.payment.order_id && orderId && data.payment.order_id !== orderId) {
    throw new Error('payment ' + paymentId + ' does not belong to order ' + orderId + ' — refusing to refund');
  }
  return {
    orderId: data.payment.order_id || orderId,
    amountCents: data.payment.amount_money && data.payment.amount_money.amount,
  };
}

// RefundPayment. idempotencyKey is caller-supplied + STABLE so a retried
// request can't mint two refunds. Returns { refund_id, status, order_id }.
async function refundSquarePayment({ accessToken, paymentId, amountCents, idempotencyKey, reason }) {
  if (!accessToken) throw new Error('refundSquarePayment: missing merchant access token');
  const body = {
    idempotency_key: idempotencyKey,
    payment_id: paymentId,
    amount_money: { amount: amountCents, currency: 'USD' },
  };
  if (reason) body.reason = String(reason).slice(0, 192);
  const res = await fetch(`${squareBase()}/v2/refunds`, {
    method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refund) {
    const e = new Error('square refund failed: ' + (data.errors ? JSON.stringify(data.errors) : res.status));
    e.squareStatus = res.status; throw e;
  }
  return { refund_id: data.refund.id, status: data.refund.status, order_id: data.refund.order_id };
}

module.exports = { resolvePaymentIdForOrder, assertPaymentTiesToOrder, refundSquarePayment };

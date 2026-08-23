// lib/square-walkins.js — SQW2: lane 2 of the Square webhook.
//
// Lane 1 (payment-ledger.processSquarePaymentCompleted) completes OUR
// pending rows under the three-way check and is untouched. Lane 2 runs
// only when lane 1 REFUSED for no_order_id / no_ledger_row — a payment
// on the connected merchant that isn't one of our orders: a counter tap,
// a Virtual Terminal sale, a POS cash ring-up. It records the payment
// into the isolated square_unmatched_payments tray (migration 078) —
// NEVER into transactions/transaction_payments, never into revenue —
// so the owner can record it with one tap (SQW3) or auto-record can
// (SQW5). Evidence-first: the full Square payment object is kept in
// raw_payload.
//
// Guards (all structural):
//   - attribution by the SIGNED event's merchant_id → exactly ONE
//     workspace with that square_merchant_id and square_status
//     'connected'; 0 or >1 → refuse + log (as today, but logged).
//   - status COMPLETED, amount > 0, currency USD.
//   - a payment carrying OUR application_id but an unknown order is a
//     forged/malformed event, not a walk-in → loud refusal, never a row.
//   - idempotent: ON CONFLICT (square_payment_id) DO NOTHING — Square
//     redelivers; one payment, one row.

function _fieldsFromPayment(payment) {
  const cd = payment.card_details || {};
  const card = cd.card || {};
  const app = payment.application_details || {};
  const dev = payment.device_details || {};
  const amt = (m) => (m && typeof m.amount === 'number') ? m.amount : null;
  const amount = amt(payment.amount_money);
  const tip = amt(payment.tip_money) || 0;
  const total = amt(payment.total_money);
  return {
    square_payment_id: payment.id,
    square_order_id: payment.order_id || null,
    location_id: payment.location_id || null,
    amount_cents: amount,
    tip_cents: tip,
    total_cents: (total != null) ? total : ((amount || 0) + tip),
    currency: (payment.amount_money && payment.amount_money.currency) || null,
    source_type: payment.source_type || null,
    entry_method: cd.entry_method || null,
    card_brand: card.card_brand || null,
    last_4: card.last_4 || null,
    square_product: app.square_product || null,
    application_id: app.application_id || null,
    device_name: dev.device_name || null,
    receipt_number: payment.receipt_number || null,
    receipt_url: payment.receipt_url || null,
    note: payment.note || null,
    paid_at: payment.created_at || null,
  };
}

async function recordUnmatchedSquarePayment(pool, { payment, merchantId, reason, ourAppId, logger = console }) {
  if (!payment || !payment.id) return { ok: false, reason: 'no_payment' };
  if (reason !== 'no_order_id' && reason !== 'no_ledger_row') return { ok: false, reason: 'not_lane2' };
  if (payment.status !== 'COMPLETED') return { ok: false, reason: 'not_completed' };
  const f = _fieldsFromPayment(payment);
  if (!(f.amount_cents > 0)) return { ok: false, reason: 'amount_invalid' };
  if (f.currency && f.currency !== 'USD') return { ok: false, reason: 'currency_mismatch' };
  if (!merchantId) return { ok: false, reason: 'no_merchant' };

  // Forgery guard (refined on the real payload, 2026-08-23): our own app
  // id on an unknown order is a forgery ONLY for our Checkout product
  // (ECOMMERCE_API). A sandbox test account is owned by our app, so its
  // Virtual Terminal / POS sales carry our app id too — and those are
  // exactly the walk-ins this lane exists for.
  if (ourAppId && f.application_id && f.application_id === ourAppId && f.square_product === 'ECOMMERCE_API') {
    logger.error('[square-walkins] REFUSED — our application_id on an unknown order (payment ' + payment.id + ', order ' + f.square_order_id + ')');
    return { ok: false, reason: 'ours_but_unmatched' };
  }

  // Attribution: the signed event's merchant must resolve to exactly ONE
  // connected workspace.
  const ws = await pool.query(
    `SELECT id FROM workspaces WHERE square_merchant_id = $1 AND square_status = 'connected'`,
    [merchantId]
  );
  if (ws.rows.length !== 1) {
    logger.error('[square-walkins] REFUSED — merchant ' + merchantId + ' resolves to ' + ws.rows.length + ' connected workspaces (payment ' + payment.id + ')');
    return { ok: false, reason: ws.rows.length === 0 ? 'merchant_unknown' : 'merchant_ambiguous' };
  }
  const workspaceId = ws.rows[0].id;

  const ins = await pool.query(
    `INSERT INTO square_unmatched_payments
       (workspace_id, square_payment_id, square_order_id, merchant_id, location_id, refusal_reason,
        amount_cents, tip_cents, total_cents, currency, source_type, entry_method, card_brand, last_4,
        square_product, application_id, device_name, receipt_number, receipt_url, note, paid_at, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (square_payment_id) DO NOTHING
     RETURNING id`,
    [workspaceId, f.square_payment_id, f.square_order_id, merchantId, f.location_id, reason,
      f.amount_cents, f.tip_cents, f.total_cents, f.currency || 'USD', f.source_type, f.entry_method, f.card_brand, f.last_4,
      f.square_product, f.application_id, f.device_name, f.receipt_number, f.receipt_url, f.note, f.paid_at, JSON.stringify(payment)]
  );
  if (ins.rows.length === 0) return { ok: true, duplicate: true, workspace_id: workspaceId };
  logger.log('[square-walkins] RECORDED unmatched payment ' + payment.id + ' → tray row ' + ins.rows[0].id
    + ' (ws ' + workspaceId + ', ' + f.total_cents + 'c, ' + (f.square_product || '?') + '/' + (f.entry_method || '?') + ')');
  return { ok: true, id: ins.rows[0].id, workspace_id: workspaceId };
}

// SQW4: a COMPLETED refund Square reports that WE didn't originate
// (the completion core returned no_refund_row). Correlate by payment_id:
//   (a) a RECORDED walk-in (completed square payment row with that
//       square_payment_id) → create the square_refunds row
//       (initiated_by='square', amount = Square's, capped at what's left
//       of the payment) so the EXISTING completion core can settle it —
//       three-way verify, child transaction, parent ratchet, G2 intact.
//   (b) an UNRECORDED tray row with that payment id → mark it refunded;
//       money that never entered the books never leaves them.
//   (c) neither → not ours to touch (logged by the caller).
// Never creates a transaction itself; never writes transaction_payments.
async function correlateMerchantSideRefund(pool, { refund, merchantId, logger = console }) {
  if (!refund || !refund.id || !refund.payment_id) return { ok: false, path: 'none', reason: 'no_payment_id' };
  if (refund.status !== 'COMPLETED') return { ok: false, path: 'none', reason: 'not_completed' };
  const amount = refund.amount_money && refund.amount_money.amount;
  const currency = refund.amount_money && refund.amount_money.currency;
  if (!(amount > 0)) return { ok: false, path: 'none', reason: 'amount_invalid' };
  if (currency && currency !== 'USD') return { ok: false, path: 'none', reason: 'currency_mismatch' };

  // (a) a recorded walk-in — the payment row carries the Square payment id.
  const pr = await pool.query(
    `SELECT tp.id, tp.workspace_id, tp.transaction_id, tp.amount_cents, w.square_merchant_id,
            t.amount_refunded_cents
       FROM transaction_payments tp
       JOIN workspaces w ON w.id = tp.workspace_id
       JOIN transactions t ON t.id = tp.transaction_id
      WHERE tp.processor = 'square' AND tp.status = 'completed' AND tp.square_payment_id = $1`,
    [refund.payment_id]
  );
  if (pr.rows.length === 1) {
    const p = pr.rows[0];
    if (merchantId && p.square_merchant_id && merchantId !== p.square_merchant_id) {
      logger.error('[square-walkins] refund MERCHANT MISMATCH for payment ' + refund.payment_id);
      return { ok: false, path: 'walkin', reason: 'merchant_mismatch' };
    }
    const remaining = p.amount_cents - (p.amount_refunded_cents || 0);
    if (amount > remaining) {
      logger.error('[square-walkins] refund OVER-REFUND refused: ' + amount + ' > remaining ' + remaining + ' (payment ' + refund.payment_id + ')');
      return { ok: false, path: 'walkin', reason: 'over_refund' };
    }
    await pool.query(
      `INSERT INTO square_refunds
         (workspace_id, transaction_id, square_refund_id, square_payment_id, amount_cents, currency, status, reason, created_by_user_id, initiated_by)
       VALUES ($1, $2, $3, $4, $5, 'USD', 'pending', $6, NULL, 'square')
       ON CONFLICT (square_refund_id) DO NOTHING`,
      [p.workspace_id, p.transaction_id, refund.id, refund.payment_id, amount,
        'Refunded on Square' + (refund.reason ? ': ' + String(refund.reason).slice(0, 200) : '')]
    );
    logger.log('[square-walkins] merchant-side refund ' + refund.id + ' correlated to transaction #' + p.transaction_id + ' (' + amount + 'c) — handing to the completion core');
    return { ok: true, path: 'walkin', transaction_id: p.transaction_id, workspace_id: p.workspace_id };
  }
  if (pr.rows.length > 1) return { ok: false, path: 'walkin', reason: 'payment_ambiguous' };

  // (b) an unrecorded tray row — it can never become income now.
  const tr = await pool.query(
    `UPDATE square_unmatched_payments
        SET status = 'refunded', dismiss_reason = $2, updated_at = NOW()
      WHERE square_payment_id = $1 AND status = 'unrecorded'
      RETURNING id, workspace_id`,
    [refund.payment_id, 'Refunded on Square before it was recorded (refund ' + refund.id + ')']
  );
  if (tr.rows.length === 1) {
    logger.log('[square-walkins] merchant-side refund ' + refund.id + ' marked tray row ' + tr.rows[0].id + ' refunded');
    return { ok: true, path: 'tray', tray_id: tr.rows[0].id, workspace_id: tr.rows[0].workspace_id };
  }
  return { ok: false, path: 'none', reason: 'payment_unknown' };
}

module.exports = { recordUnmatchedSquarePayment, correlateMerchantSideRefund, _fieldsFromPayment };

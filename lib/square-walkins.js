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

  // Forgery guard: our own app id with an order we don't know is never a
  // walk-in — it's an event we must not trust.
  if (ourAppId && f.application_id && f.application_id === ourAppId) {
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

module.exports = { recordUnmatchedSquarePayment, _fieldsFromPayment };

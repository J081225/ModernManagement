// lib/payment-ledger.js
//
// E14 — Customer-payment ledger. The SINGLE place in the codebase where
// transactions.amount_paid_cents and transactions.status are written
// based on payments received. Every payment (cash, card, Stripe Checkout,
// anything) lands as a row in transaction_payments; the rollup function
// here sums the completed rows and writes the result back to the parent
// transaction.
//
// Architecture (E14 ADR, paraphrased):
//   - transactions.amount_paid_cents is now a ROLLUP. Direct UPDATEs of
//     that column outside this module are forbidden.
//   - transactions.status is derived from the rollup vs total_cents in
//     ONE place — recomputeTransactionPaidStatus below. The three pre-E14
//     payment flows (complete_appointment, create_transaction,
//     complete_transaction) are rewired to feed the ledger and call this
//     recompute instead of computing status inline.
//   - Online card payments (Stripe Checkout via Connect) insert a
//     ledger row in status='pending' at session creation; the
//     checkout.session.completed webhook flips it to 'completed' and
//     triggers a recompute.
//   - Refunds are NOT ledger rows. They remain child transactions with
//     parent_transaction_id and negative totals — a separate concern,
//     out of scope for this module.
//
// Both functions accept a passed-in `client` so callers can run them
// inside their own BEGIN/COMMIT when they care about atomicity. They
// also work fine against the raw pool (which auto-commits each query).

/**
 * Insert one row into the transaction_payments ledger.
 *
 * @param {pg.PoolClient|pg.Pool} client - the connection / pool to query through
 * @param {Object}  payload
 * @param {number}  payload.workspace_id
 * @param {number}  payload.transaction_id
 * @param {number}  payload.amount_cents               — positive integer
 * @param {string}  payload.payment_type               — 'deposit' | 'payment'
 * @param {string}  payload.payment_method             — 'cash' | 'card' | 'venmo' | 'zelle' | 'gift_card' | 'stripe' | 'square' | 'other'
 * @param {string=} payload.processor                  — SQ2: 'stripe' | 'square'. Defaults to 'stripe'.
 * @param {string=} payload.processor_ref              — SQ2: the processor's idempotency reference (Stripe session id / Square payment id). The generic successor to stripe_checkout_session_id.
 * @param {string=} payload.stripe_checkout_session_id — DEPRECATED (SQ2 back-compat): a Stripe caller may still pass this; it maps to processor='stripe', processor_ref=<it>.
 * @param {string=} payload.status                     — 'pending' | 'completed' | 'failed'; defaults to 'completed' (manual path). Online payments pass 'pending'.
 * @param {string=} payload.notes
 * @param {number=} payload.created_by_user_id
 * @returns {Promise<{ id, status }>}
 */
async function recordPayment(client, payload) {
  const {
    workspace_id, transaction_id, amount_cents, payment_type, payment_method,
    stripe_checkout_session_id = null,
    processor: processorIn = null,
    processor_ref: processorRefIn = null,
    status = 'completed',
    notes = null,
    created_by_user_id = null,
  } = payload || {};

  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    throw new Error('recordPayment: amount_cents must be a positive integer');
  }
  if (!workspace_id || !transaction_id) {
    throw new Error('recordPayment: workspace_id and transaction_id are required');
  }

  // SQ2 back-compat shim: a legacy Stripe caller passes
  // stripe_checkout_session_id; the generic path passes
  // processor/processor_ref. Reconcile to one shape. During the
  // transition BOTH the generic columns AND the legacy column are
  // written for Stripe, so the old webhook lookup and the new one
  // both resolve the row.
  const processor = processorIn || 'stripe';
  const processor_ref = processorRefIn || stripe_checkout_session_id || null;
  const legacyStripeRef = processor === 'stripe' ? processor_ref : null;

  const r = await client.query(
    `INSERT INTO transaction_payments
       (workspace_id, transaction_id, amount_cents, payment_type, payment_method,
        processor, processor_ref, stripe_checkout_session_id, status, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, status`,
    [workspace_id, transaction_id, amount_cents, payment_type, payment_method,
      processor, processor_ref, legacyStripeRef, status, notes, created_by_user_id]
  );
  return r.rows[0];
}

/**
 * Sum completed ledger rows for a transaction and mirror the result onto
 * transactions.amount_paid_cents. Then derive transactions.status:
 *
 *   - voided / refunded  → preserved (terminal states; a ledger entry
 *                          must not un-void or un-refund a transaction)
 *   - sum >= total_cents AND total_cents > 0  → 'paid'
 *   - sum > 0 AND sum < total_cents           → 'partially_paid'
 *   - sum == 0                                → preserved
 *                                               (draft / pending / unpaid
 *                                                stay as-is)
 *
 * Also stamps payment_received_at = NOW() the first time a transaction
 * transitions into paid/partially_paid (i.e., when sum > 0 and
 * payment_received_at IS NULL, and we're not in voided/refunded).
 *
 * Returns the new rolled-up state so callers can render messages /
 * trigger downstream effects without a second SELECT.
 *
 * @param {pg.PoolClient|pg.Pool} client
 * @param {number} transaction_id
 * @returns {Promise<{ id, total_cents, amount_paid_cents, status, payment_received_at }|null>}
 */
async function recomputeTransactionPaidStatus(client, transaction_id) {
  if (!transaction_id) {
    throw new Error('recomputeTransactionPaidStatus: transaction_id is required');
  }

  // 1) Sum completed ledger rows AND count total rows for this transaction.
  //    The row_count is the zero-ledger-row guard: a transaction without
  //    any ledger entries is NOT governed by the rollup — it may be legacy
  //    (pre-E14) data, or the refund route, which writes amount_paid_cents
  //    directly. Touching its rollup columns from here would silently zero
  //    out a real paid amount. The ledger governs a transaction only after
  //    it has at least one ledger row.
  const sumRes = await client.query(
    `SELECT
        COUNT(*)::int AS row_count,
        COALESCE(SUM(amount_cents) FILTER (WHERE status = 'completed'), 0)::int AS sum
       FROM transaction_payments
      WHERE transaction_id = $1`,
    [transaction_id]
  );
  const row_count = sumRes.rows[0] ? sumRes.rows[0].row_count : 0;
  const sum = sumRes.rows[0] ? sumRes.rows[0].sum : 0;

  // Zero-ledger-row guard: no entries means the ledger does not govern this
  // transaction yet. Return without touching amount_paid_cents/status.
  if (row_count === 0) {
    return null;
  }

  // 2) Atomically mirror sum onto transactions; derive status / set
  //    payment_received_at via CASE expressions so the rules sit in one
  //    SQL statement (no read-modify-write race). Voided and refunded
  //    are explicitly preserved on both columns.
  const upd = await client.query(
    `UPDATE transactions
        SET amount_paid_cents = $1,
            status = CASE
              WHEN status IN ('voided', 'refunded')                THEN status
              WHEN $1 >= total_cents AND total_cents > 0           THEN 'paid'
              WHEN $1 > 0                                          THEN 'partially_paid'
              ELSE status
            END,
            payment_received_at = CASE
              WHEN status IN ('voided', 'refunded')                THEN payment_received_at
              WHEN payment_received_at IS NOT NULL                 THEN payment_received_at
              WHEN $1 > 0                                          THEN NOW()
              ELSE payment_received_at
            END,
            updated_at = NOW()
      WHERE id = $2
      RETURNING id, total_cents, amount_paid_cents, status, payment_received_at`,
    [sum, transaction_id]
  );
  return upd.rows[0] || null;
}

/**
 * E14 Step 5 — webhook handler for customer-payment Checkout completions.
 * Stripe fires checkout.session.completed on the connected account when a
 * direct charge succeeds. We disambiguate from salon-signup completions
 * via metadata.transaction_id (signups don't carry that key), so by the
 * time this runs the event is known to be a customer payment.
 *
 * What it does:
 *   1) Look up the pending ledger row by stripe_checkout_session_id.
 *      FOR UPDATE locks it so concurrent retries can't both flip it.
 *   2) Idempotency: if the row is already 'completed', no-op and return.
 *   3) Otherwise flip 'pending' → 'completed' and recompute the parent
 *      transaction's rollup (which is now governed by the ledger).
 *   4) If the transaction lands at 'paid' and is linked to an appointment
 *      still in 'requested' state, promote the appointment to 'confirmed'.
 *      Terminal/in-flight statuses (confirmed, in_progress, completed,
 *      canceled, no_show) are NOT touched — a deposit clearing after
 *      service-completion must not regress the appointment.
 *
 * Whole sequence runs on ONE dedicated client inside ONE BEGIN/COMMIT,
 * matching the atomicity guarantee of the Step 3 flows.
 *
 * Returns a small { ok, ... } envelope so the webhook can log a one-liner.
 *
 * @param {Object} event - the Stripe event (already signature-verified)
 * @param {pg.Pool} pool - the connection pool
 */
// SQ4: the shared completion core. Given a (processor, processor_ref),
// flip the pending ledger row to completed and run the rollup +
// appointment promotion. Both the Stripe wrapper and the Square wrapper
// call this — the only per-processor thing is how the ref is extracted
// from the event; everything here is identical. Ruling 2: the lookup
// is by (processor, processor_ref) alone, never the workspace's active
// flag, so a payment pending on a since-deactivated processor still
// completes.
async function completePendingPayment(pool, processor, processorRef, squarePaymentId = null) {
  if (!processorRef) return { ok: false, reason: 'no_processor_ref' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT id, transaction_id, status, payment_type
         FROM transaction_payments
        WHERE processor = $1 AND processor_ref = $2
        FOR UPDATE`,
      [processor, processorRef]
    );
    if (r.rows.length === 0) {
      await client.query('COMMIT');
      return { ok: false, reason: 'no_ledger_row', processor, processor_ref: processorRef };
    }
    const row = r.rows[0];

    // Idempotency anchor: a retried webhook delivery hits this branch and
    // exits without changing anything.
    if (row.status === 'completed') {
      await client.query('COMMIT');
      return {
        ok: true,
        idempotent: true,
        payment_id: row.id,
        transaction_id: row.transaction_id,
      };
    }

    await client.query(
      // SQ5: capture the Square payment_id at completion (COALESCE so a
      // Stripe/redelivered completion never clears an existing value) —
      // a refund later targets this payment.
      `UPDATE transaction_payments
          SET status = 'completed',
              square_payment_id = COALESCE($2, square_payment_id)
        WHERE id = $1`,
      [row.id, squarePaymentId]
    );
    const rolled = await recomputeTransactionPaidStatus(client, row.transaction_id);

    // FD3-CP6: a paid deposit confirms THE DEPOSIT. The original
    // condition here (rolled.status === 'paid') assumed payment-in-full
    // — a deposit smaller than the total left the transaction
    // partially_paid (correct!) but the appointment stuck 'requested'
    // and nothing recorded that the deposit cleared. Now: a completed
    // deposit-typed ledger row stamps appointments.deposit_paid_at and
    // promotes 'requested' → 'confirmed', while the TRANSACTION status
    // stays whatever the rollup honestly computed — partial payment
    // never falsely settles the full balance. Full payment keeps the
    // original promotion branch unchanged.
    let appointment_confirmed = false;
    let deposit_marked = false;
    const txR = await client.query(
      `SELECT appointment_id FROM transactions WHERE id = $1`,
      [row.transaction_id]
    );
    const apptId = txR.rows[0] && txR.rows[0].appointment_id;
    if (apptId && row.payment_type === 'deposit') {
      const u = await client.query(
        `UPDATE appointments
            SET deposit_paid_at = COALESCE(deposit_paid_at, NOW()),
                status = CASE WHEN status = 'requested' THEN 'confirmed' ELSE status END,
                updated_at = NOW()
          WHERE id = $1
          RETURNING status, deposit_paid_at`,
        [apptId]
      );
      deposit_marked = u.rowCount > 0;
      appointment_confirmed = !!(u.rows[0] && u.rows[0].status === 'confirmed');
    } else if (apptId && rolled && rolled.status === 'paid') {
      const u = await client.query(
        `UPDATE appointments
            SET status = 'confirmed', updated_at = NOW()
          WHERE id = $1 AND status = 'requested'`,
        [apptId]
      );
      appointment_confirmed = u.rowCount > 0;
    }

    await client.query('COMMIT');
    return {
      ok: true,
      payment_id: row.id,
      transaction_id: row.transaction_id,
      new_status: rolled ? rolled.status : null,
      appointment_confirmed,
      deposit_marked,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* best-effort */ }
    throw err;
  } finally {
    client.release();
  }
}

// Stripe wrapper: the event's session id IS the processor_ref.
async function processCustomerPaymentCompletedEvent(event, pool) {
  const sessionObj = event && event.data && event.data.object;
  const sessionId = sessionObj && sessionObj.id;
  if (!sessionId) return { ok: false, reason: 'no_session_id' };
  return completePendingPayment(pool, 'stripe', sessionId);
}

// SQ4 Square wrapper + the THREE-WAY money-safety verification (security
// addendum item 3): a completion proceeds only when the signed event's
// merchant matches the workspace's Square merchant AND the paid amount
// + currency match the pending row exactly. Any mismatch FLAGS LOUDLY
// and never completes — a forged or wrong-amount webhook can't settle a
// transaction. (Signature verification happens at the HTTP edge before
// this runs.) The state ratchet (item 6) is inherited from the core:
// a 'completed' row is an idempotent no-op; the row can only move
// pending -> completed here.
async function processSquarePaymentCompleted(pool, { orderId, merchantId, amountCents, currency, paymentId }) {
  if (!orderId) return { ok: false, reason: 'no_order_id' };

  // Look up the pending row + its workspace's expected merchant/amount.
  const pre = await pool.query(
    `SELECT tp.id, tp.workspace_id, tp.amount_cents, tp.status, w.square_merchant_id
       FROM transaction_payments tp
       JOIN workspaces w ON w.id = tp.workspace_id
      WHERE tp.processor = 'square' AND tp.processor_ref = $1`,
    [orderId]
  );
  if (pre.rows.length === 0) return { ok: false, reason: 'no_ledger_row', processor: 'square', processor_ref: orderId };
  const pend = pre.rows[0];

  // Merchant must match the workspace's connected Square merchant.
  if (merchantId && pend.square_merchant_id && merchantId !== pend.square_merchant_id) {
    console.error('[square-webhook] MERCHANT MISMATCH — event merchant ' + merchantId
      + ' != workspace ' + pend.square_merchant_id + ' for order ' + orderId + '. Refusing to complete.');
    return { ok: false, reason: 'merchant_mismatch' };
  }
  // Amount + currency must match the pending row exactly.
  if (typeof amountCents === 'number' && amountCents !== pend.amount_cents) {
    console.error('[square-webhook] AMOUNT MISMATCH — event ' + amountCents
      + ' != pending ' + pend.amount_cents + ' for order ' + orderId + '. Refusing to complete.');
    return { ok: false, reason: 'amount_mismatch' };
  }
  if (currency && currency !== 'USD') {
    console.error('[square-webhook] CURRENCY MISMATCH — event ' + currency + ' != USD for order ' + orderId + '. Refusing to complete.');
    return { ok: false, reason: 'currency_mismatch' };
  }

  return completePendingPayment(pool, 'square', orderId, paymentId || null);
}

// SQ5: the Square REFUND completion core. Mirrors the payment core —
// three-way verify (merchant + amount + currency), then move the parent
// books ONCE. Refund money-state lives in the isolated `square_refunds`
// table (NEVER a transaction_payments row — that table is revenue-summed;
// a refund row there would corrupt the rollup). The reporting artifact is
// the record-only refund CHILD transaction, created HERE (i.e. only when
// Square confirms), so the books show a refund only after the money
// moved (G2). Idempotent against redelivery: a 'completed' refund row is
// a no-op; the parent ratchet + child creation happen exactly once under
// the FOR UPDATE lock.
async function processSquareRefundCompleted(pool, { refundId, merchantId, amountCents, currency }) {
  if (!refundId) return { ok: false, reason: 'no_refund_id' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT sr.*, w.square_merchant_id
         FROM square_refunds sr
         JOIN workspaces w ON w.id = sr.workspace_id
        WHERE sr.square_refund_id = $1
        FOR UPDATE`,
      [refundId]
    );
    if (r.rows.length === 0) {
      await client.query('COMMIT');
      return { ok: false, reason: 'no_refund_row', refund_id: refundId };
    }
    const sr = r.rows[0];
    // Idempotency anchor: a retried delivery exits without changing anything.
    if (sr.status === 'completed') {
      await client.query('COMMIT');
      return { ok: true, idempotent: true, refund_id: refundId, transaction_id: sr.transaction_id, refund_child_transaction_id: sr.refund_child_transaction_id, parent_status: null };
    }
    // Three-way money-safety verification (same stance as payments).
    if (merchantId && sr.square_merchant_id && merchantId !== sr.square_merchant_id) {
      await client.query('ROLLBACK');
      console.error('[square-refund] MERCHANT MISMATCH — event ' + merchantId + ' != workspace ' + sr.square_merchant_id + ' for refund ' + refundId + '. Refusing.');
      return { ok: false, reason: 'merchant_mismatch' };
    }
    if (typeof amountCents === 'number' && amountCents !== sr.amount_cents) {
      await client.query('ROLLBACK');
      console.error('[square-refund] AMOUNT MISMATCH — event ' + amountCents + ' != row ' + sr.amount_cents + ' for refund ' + refundId + '. Refusing.');
      return { ok: false, reason: 'amount_mismatch' };
    }
    if (currency && currency !== (sr.currency || 'USD')) {
      await client.query('ROLLBACK');
      console.error('[square-refund] CURRENCY MISMATCH — event ' + currency + ' for refund ' + refundId + '. Refusing.');
      return { ok: false, reason: 'currency_mismatch' };
    }

    const pr = await client.query(
      `SELECT * FROM transactions WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [sr.transaction_id, sr.workspace_id]
    );
    const parent = pr.rows[0];
    if (!parent) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_parent' }; }

    // The record-only refund CHILD transaction (the books). Created here,
    // once — the reporting artifact, exactly as the record-only flow.
    let childId = sr.refund_child_transaction_id;
    if (!childId) {
      const refundLineItems = [{
        description: 'Refund: ' + (sr.reason || ''),
        quantity: 1,
        unit_price_cents: -sr.amount_cents,
        total_cents: -sr.amount_cents,
        type: 'fee',
      }];
      const { formatCents } = require('./money'); // the one money formatter
      const ins = await client.query(
        `INSERT INTO transactions
           (workspace_id, contact_id, appointment_id, parent_transaction_id, customer_display_name,
            line_items, subtotal_cents, total_cents, amount_paid_cents, payment_method, status, source,
            refund_reason, created_by_user_id, payment_received_at, notes_internal)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7,$7,$8,'paid','refund',$9,$10,NOW(),$11)
         RETURNING id`,
        [sr.workspace_id, parent.contact_id, parent.appointment_id, parent.id, parent.customer_display_name,
          JSON.stringify(refundLineItems), -sr.amount_cents, parent.payment_method || 'square',
          sr.reason, sr.created_by_user_id,
          'Square refund ' + sr.square_refund_id + ' of ' + formatCents(sr.amount_cents) + ' from transaction #' + parent.id]
      );
      childId = ins.rows[0].id;
    }

    // Ratchet the parent: partial refunds stay paid/partially_paid;
    // fully-refunded flips to 'refunded'.
    const newRefunded = (parent.amount_refunded_cents || 0) + sr.amount_cents;
    const newStatus = newRefunded >= parent.total_cents ? 'refunded' : parent.status;
    await client.query(
      `UPDATE transactions SET amount_refunded_cents = $1, status = $2, updated_at = NOW()
        WHERE id = $3 AND workspace_id = $4`,
      [newRefunded, newStatus, parent.id, sr.workspace_id]
    );
    await client.query(
      `UPDATE square_refunds SET status = 'completed', refund_child_transaction_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [sr.id, childId]
    );
    await client.query('COMMIT');
    return { ok: true, refund_id: refundId, transaction_id: parent.id, refund_child_transaction_id: childId, parent_status: newStatus };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* best-effort */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  recordPayment,
  recomputeTransactionPaidStatus,
  completePendingPayment,
  processCustomerPaymentCompletedEvent,
  processSquarePaymentCompleted,
  processSquareRefundCompleted,
};

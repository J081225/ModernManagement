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
 * @param {string}  payload.payment_method             — 'cash' | 'card' | 'venmo' | 'zelle' | 'gift_card' | 'stripe' | 'other'
 * @param {string=} payload.stripe_checkout_session_id — set for online card payments only
 * @param {string=} payload.status                     — 'pending' | 'completed' | 'failed'; defaults to 'completed' (manual path). Online payments pass 'pending'.
 * @param {string=} payload.notes
 * @param {number=} payload.created_by_user_id
 * @returns {Promise<{ id, status }>}
 */
async function recordPayment(client, payload) {
  const {
    workspace_id, transaction_id, amount_cents, payment_type, payment_method,
    stripe_checkout_session_id = null,
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

  const r = await client.query(
    `INSERT INTO transaction_payments
       (workspace_id, transaction_id, amount_cents, payment_type, payment_method,
        stripe_checkout_session_id, status, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, status`,
    [workspace_id, transaction_id, amount_cents, payment_type, payment_method,
      stripe_checkout_session_id, status, notes, created_by_user_id]
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
async function processCustomerPaymentCompletedEvent(event, pool) {
  const sessionObj = event && event.data && event.data.object;
  const sessionId = sessionObj && sessionObj.id;
  if (!sessionId) return { ok: false, reason: 'no_session_id' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `SELECT id, transaction_id, status
         FROM transaction_payments
        WHERE stripe_checkout_session_id = $1
        FOR UPDATE`,
      [sessionId]
    );
    if (r.rows.length === 0) {
      await client.query('COMMIT');
      return { ok: false, reason: 'no_ledger_row', stripe_checkout_session_id: sessionId };
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
      `UPDATE transaction_payments
          SET status = 'completed'
        WHERE id = $1`,
      [row.id]
    );
    const rolled = await recomputeTransactionPaidStatus(client, row.transaction_id);

    let appointment_confirmed = false;
    if (rolled && rolled.status === 'paid') {
      const txR = await client.query(
        `SELECT appointment_id FROM transactions WHERE id = $1`,
        [row.transaction_id]
      );
      const apptId = txR.rows[0] && txR.rows[0].appointment_id;
      if (apptId) {
        const u = await client.query(
          `UPDATE appointments
              SET status = 'confirmed', updated_at = NOW()
            WHERE id = $1 AND status = 'requested'`,
          [apptId]
        );
        appointment_confirmed = u.rowCount > 0;
      }
    }

    await client.query('COMMIT');
    return {
      ok: true,
      payment_id: row.id,
      transaction_id: row.transaction_id,
      new_status: rolled ? rolled.status : null,
      appointment_confirmed,
    };
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
  processCustomerPaymentCompletedEvent,
};

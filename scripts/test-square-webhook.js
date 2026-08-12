// scripts/test-square-webhook.js — SQ4 webhook gate + security items 3 & 6.
//
// Drives the REAL processSquarePaymentCompleted over a fixture DB and
// pins the three-way money verification (signature is at the HTTP edge;
// merchant + amount + currency here) and the one-way state ratchet.
const path = require('path');
const fs = require('fs');
const ledger = require(path.join(__dirname, '..', 'lib', 'payment-ledger'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Fixture: one pending Square row for order 'ord_1', $50, workspace 7,
// whose workspace square_merchant_id is 'MERCH_7'.
function makeDb(rows) {
  const db = {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
      // the pre-check join (workspace merchant + amount)
      if (s.includes('JOIN workspaces w ON w.id = tp.workspace_id') && s.includes("processor = 'square'")) {
        const r = rows.find((x) => x.processor === 'square' && x.processor_ref === params[0]);
        return { rows: r ? [{ id: r.id, workspace_id: r.workspace_id, amount_cents: r.amount_cents, status: r.status, square_merchant_id: 'MERCH_7' }] : [] };
      }
      // the core lookup (FOR UPDATE)
      if (s.includes('WHERE processor = $1 AND processor_ref = $2')) {
        const r = rows.find((x) => x.processor === params[0] && x.processor_ref === params[1]);
        return { rows: r ? [{ id: r.id, transaction_id: r.transaction_id, status: r.status, payment_type: r.payment_type }] : [] };
      }
      if (s.startsWith("UPDATE transaction_payments SET status = 'completed'")) {
        const r = rows.find((x) => x.id === params[0]); if (r) r.status = 'completed'; return { rows: [] };
      }
      if (s.includes('FROM transaction_payments') && s.includes('SUM')) return { rows: [{ row_count: 1, sum: 5000 }] };
      if (s.startsWith('UPDATE transactions')) return { rows: [{ id: 1, total_cents: 5000, amount_paid_cents: 5000, status: 'paid', payment_received_at: 'NOW' }] };
      if (s.includes('FROM transactions WHERE id')) return { rows: [{ appointment_id: null }] };
      return { rows: [] };
    },
    connect: async () => ({ query: db.query, release() {} }),
  };
  return db;
}
const freshRow = () => [{ id: 1, workspace_id: 7, transaction_id: 1, amount_cents: 5000, processor: 'square', processor_ref: 'ord_1', status: 'pending', payment_type: 'payment' }];

(async () => {
  // ---- SW1: a matching event completes ----
  {
    const rows = freshRow();
    const res = await ledger.processSquarePaymentCompleted(makeDb(rows), { orderId: 'ord_1', merchantId: 'MERCH_7', amountCents: 5000, currency: 'USD' });
    check('SW1: a Square payment whose merchant + amount + currency all match the pending row completes it',
      res.ok === true && rows[0].status === 'completed', JSON.stringify(res));
  }

  // ---- SW2 [item 3]: merchant mismatch is REFUSED ----
  {
    const rows = freshRow();
    const res = await ledger.processSquarePaymentCompleted(makeDb(rows), { orderId: 'ord_1', merchantId: 'MERCH_EVIL', amountCents: 5000, currency: 'USD' });
    check('SW2 [item 3]: a wrong merchant_id is refused (merchant_mismatch) and the row stays pending — a forged event from another merchant cannot settle it',
      res.ok === false && res.reason === 'merchant_mismatch' && rows[0].status === 'pending');
  }

  // ---- SW3 [item 3]: amount mismatch is REFUSED ----
  {
    const rows = freshRow();
    const res = await ledger.processSquarePaymentCompleted(makeDb(rows), { orderId: 'ord_1', merchantId: 'MERCH_7', amountCents: 100, currency: 'USD' });
    check('SW3 [item 3]: a wrong amount is refused (amount_mismatch) and the row stays pending — an underpaid/overpaid event cannot settle the transaction',
      res.ok === false && res.reason === 'amount_mismatch' && rows[0].status === 'pending');
  }

  // ---- SW4 [item 3]: currency mismatch is REFUSED ----
  {
    const rows = freshRow();
    const res = await ledger.processSquarePaymentCompleted(makeDb(rows), { orderId: 'ord_1', merchantId: 'MERCH_7', amountCents: 5000, currency: 'EUR' });
    check('SW4 [item 3]: a non-USD currency is refused and the row stays pending',
      res.ok === false && res.reason === 'currency_mismatch' && rows[0].status === 'pending');
  }

  // ---- SW5 [item 6]: the state ratchet — a redelivery no-ops ----
  {
    const rows = freshRow();
    const db = makeDb(rows);
    await ledger.processSquarePaymentCompleted(db, { orderId: 'ord_1', merchantId: 'MERCH_7', amountCents: 5000, currency: 'USD' });
    const second = await ledger.processSquarePaymentCompleted(db, { orderId: 'ord_1', merchantId: 'MERCH_7', amountCents: 5000, currency: 'USD' });
    check('SW5 [item 6]: a redelivered COMPLETED event is an idempotent no-op (ratchet: completed stays completed)',
      second.ok === true && second.idempotent === true && rows[0].status === 'completed');
  }

  // ---- SW6: an unknown order is a clean miss, not a crash ----
  {
    const res = await ledger.processSquarePaymentCompleted(makeDb(freshRow()), { orderId: 'ord_UNKNOWN', merchantId: 'MERCH_7', amountCents: 5000, currency: 'USD' });
    check('SW6: an event for an unknown order returns no_ledger_row (a Square account paying an unrelated link never touches our ledger)',
      res.ok === false && res.reason === 'no_ledger_row');
  }

  // ---- SW7: the webhook endpoint + signature verification, source-pinned ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const raw = srv.includes("app.use('/api/square/webhook', express.raw");
    const sig = srv.includes('function verifySquareSignature(req)')
      && srv.includes("crypto.createHmac('sha256', key).update(url + body).digest('base64')")
      && srv.includes('crypto.timingSafeEqual');
    const onlyCompleted = srv.includes("payment.status !== 'COMPLETED'");
    const whitelisted = srv.includes("'/square/webhook']");
    const badSig400 = /const v = verifySquareSignature\(req\);\s*\n\s*if \(!v\.ok\)/.test(srv)
      && /if \(!v\.ok\) \{[\s\S]{0,240}res\.status\(400\)/.test(srv);
    check('SW7: the webhook is raw-body mounted + whitelisted, verifies an HMAC-SHA256 signature (timing-safe) before anything, only settles on COMPLETED, and 400s a bad/absent signature',
      raw && sig && onlyCompleted && whitelisted && badSig400,
      JSON.stringify({ raw, sig, onlyCompleted, whitelisted, badSig400 }));
  }

  console.log(`${pass}/${pass + fail} — square-webhook gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

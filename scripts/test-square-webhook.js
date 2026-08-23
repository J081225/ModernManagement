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
      // SQW3 widened the window: the bad-signature branch now also writes
      // the delivery-log row (no event id, fail-open) before the 400.
      && /if \(!v\.ok\) \{[\s\S]{0,480}res\.status\(400\)/.test(srv);
    check('SW7: the webhook is raw-body mounted + whitelisted, verifies an HMAC-SHA256 signature (timing-safe) before anything, only settles on COMPLETED, and 400s a bad/absent signature',
      raw && sig && onlyCompleted && whitelisted && badSig400,
      JSON.stringify({ raw, sig, onlyCompleted, whitelisted, badSig400 }));
  }

  // ---- SW8 (SQW1): every refused COMPLETED payment logs its discriminator
  // fields — not just *_mismatch. A counter tap (no_order_id /
  // no_ledger_row) must leave a trace: the evidence gate for SQ-W. ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const hook = srv.slice(srv.indexOf("app.post('/api/square/webhook'"), srv.indexOf('// SQ3e: the explicit active-processor switch'));
    // The PAYMENT block must log on any !result.ok — the refund block's
    // own rr.reason *_mismatch guard (SQ5) is deliberately out of scope.
    const firesOnAnyRefusal = hook.includes('if (!result.ok) {') && !/result\.reason\.endsWith\('_mismatch'\)/.test(hook);
    const fields = ['payment_id', 'order_id', 'merchant_id', 'source_type', 'entry_method', 'card_brand', 'last_4', 'square_product', 'application_id', 'device_name', 'receipt_number', 'note', 'tip', 'total']
      .every((f) => hook.includes(f + ':'));
    const tagged = hook.includes("'[square-webhook] completion REFUSED (' + result.reason + ') ' + JSON.stringify({");
    check('SW8 [SQW1]: EVERY refused COMPLETED payment (no_order_id / no_ledger_row / mismatches) logs a structured line with the discriminator fields (source_type, entry_method, square_product, application_id, device, brand/last4, note, tip/total)',
      firesOnAnyRefusal && fields && tagged, JSON.stringify({ firesOnAnyRefusal, fields, tagged }));
  }

  // ---- SW9/SW10 (SQW2): lane 2 — the unmatched-payment recorder ----
  {
    const { recordUnmatchedSquarePayment } = require(path.join(__dirname, '..', 'lib', 'square-walkins'));
    const silent = { error: () => {}, log: () => {} };
    const vtPayment = {
      id: 'PAYvt1', order_id: 'ORDvt1', status: 'COMPLETED', location_id: 'LOC1',
      amount_money: { amount: 1234, currency: 'USD' }, total_money: { amount: 1234, currency: 'USD' },
      source_type: 'CARD', created_at: '2026-08-23T16:20:00Z', receipt_number: 'AbCd',
      card_details: { entry_method: 'KEYED', card: { card_brand: 'MASTERCARD', last_4: '5100' } },
      application_details: { square_product: 'VIRTUAL_TERMINAL', application_id: 'sq0idp-square-vt' },
    };
    const mkPool = ({ merchants = 1, conflict = false } = {}) => {
      const calls = [];
      return {
        calls,
        query: async (sql, params) => {
          calls.push({ sql, params });
          if (/FROM workspaces WHERE square_merchant_id/.test(sql)) return { rows: Array.from({ length: merchants }, (_, i) => ({ id: 17 + i })) };
          if (/INSERT INTO square_unmatched_payments/.test(sql)) return { rows: conflict ? [] : [{ id: 1 }] };
          return { rows: [] };
        },
      };
    };
    // records, with the discriminators + raw payload, attributed to the one connected workspace
    const p1 = mkPool();
    const r1 = await recordUnmatchedSquarePayment(p1, { payment: vtPayment, merchantId: 'MERCH1', reason: 'no_ledger_row', ourAppId: 'sq0idp-OURAPP', logger: silent });
    const ins = p1.calls.find((c) => /INSERT INTO square_unmatched_payments/.test(c.sql));
    const attributed = ins && ins.params[0] === 17 && ins.params[1] === 'PAYvt1' && ins.params[5] === 'no_ledger_row';
    const discriminators = ins && ins.params[11] === 'KEYED' && ins.params[12] === 'MASTERCARD' && ins.params[13] === '5100' && ins.params[14] === 'VIRTUAL_TERMINAL';
    const raw = ins && JSON.parse(ins.params[21]).id === 'PAYvt1';
    const onConflict = ins && /ON CONFLICT \(square_payment_id\) DO NOTHING/.test(ins.sql);
    check('SW9 [SQW2]: lane 2 records an unmatched COMPLETED payment into the isolated tray — attributed to the ONE connected workspace by merchant, discriminators + raw payload stored, idempotent ON CONFLICT',
      r1.ok === true && attributed && discriminators && raw && onConflict,
      JSON.stringify({ ok: r1.ok, attributed, discriminators, raw, onConflict }));

    // refusals: our own app id on an unknown order (forgery), unknown merchant, ambiguous merchant, redelivery = duplicate no-op, mismatch reasons never enter lane 2
    const forged = await recordUnmatchedSquarePayment(mkPool(), { payment: { ...vtPayment, application_details: { square_product: 'ECOMMERCE_API', application_id: 'sq0idp-OURAPP' } }, merchantId: 'MERCH1', reason: 'no_ledger_row', ourAppId: 'sq0idp-OURAPP', logger: silent });
    const unknown = await recordUnmatchedSquarePayment(mkPool({ merchants: 0 }), { payment: vtPayment, merchantId: 'MERCHX', reason: 'no_ledger_row', ourAppId: 'sq0idp-OURAPP', logger: silent });
    const ambiguous = await recordUnmatchedSquarePayment(mkPool({ merchants: 2 }), { payment: vtPayment, merchantId: 'MERCH1', reason: 'no_ledger_row', ourAppId: 'sq0idp-OURAPP', logger: silent });
    const dup = await recordUnmatchedSquarePayment(mkPool({ conflict: true }), { payment: vtPayment, merchantId: 'MERCH1', reason: 'no_order_id', ourAppId: 'sq0idp-OURAPP', logger: silent });
    const mismatch = await recordUnmatchedSquarePayment(mkPool(), { payment: vtPayment, merchantId: 'MERCH1', reason: 'amount_mismatch', ourAppId: 'sq0idp-OURAPP', logger: silent });
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const wired = /result\.reason === 'no_order_id' \|\| result\.reason === 'no_ledger_row'[\s\S]{0,300}recordUnmatchedSquarePayment/.test(srv);
    const noRevenueTouch = !/INSERT INTO transactions|INSERT INTO transaction_payments/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'square-walkins.js'), 'utf8'));
    check('SW10 [SQW2]: lane 2 REFUSES a forged ours-but-unmatched event, an unknown or ambiguous merchant, treats redelivery as a duplicate no-op, never accepts *_mismatch reasons, is wired only behind no_order_id/no_ledger_row, and never writes transactions/transaction_payments',
      forged.reason === 'ours_but_unmatched' && unknown.reason === 'merchant_unknown' && ambiguous.reason === 'merchant_ambiguous'
        && dup.ok === true && dup.duplicate === true && mismatch.reason === 'not_lane2' && wired && noRevenueTouch,
      JSON.stringify({ forged: forged.reason, unknown: unknown.reason, ambiguous: ambiguous.reason, dup, mismatch: mismatch.reason, wired, noRevenueTouch }));
  }

  // ---- SW11 (SQW3): the delivery log — every outcome leaves a row ----
  {
    const { logSquareWebhookEvent } = require(path.join(__dirname, '..', 'lib', 'square-webhook-log'));
    const calls = [];
    const fakePool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
    await logSquareWebhookEvent(fakePool, { eventId: 'EVT1', eventType: 'payment.updated', merchantId: 'M', objectId: 'PAY1', outcome: 'tray_recorded', reason: 'no_ledger_row' });
    await logSquareWebhookEvent(fakePool, { outcome: 'bad_signature', reason: 'no_signature', httpStatus: 400 });
    const upsert = calls[0] && /ON CONFLICT \(square_event_id\)[\s\S]{0,80}attempts = square_webhook_events\.attempts \+ 1/.test(calls[0].sql) && calls[0].params[0] === 'EVT1';
    const nullEvent = calls[1] && /VALUES \(NULL,/.test(calls[1].sql) && calls[1].params[3] === 'bad_signature' && calls[1].params[5] === 400;
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const hook = srv.slice(srv.indexOf("app.post('/api/square/webhook'"), srv.indexOf("app.get('/api/finances/counter-payments'"));
    const outcomes = ['bad_signature', 'ignored_status', 'refund_settled', 'refund_refused', 'ignored_type', "'completed'", "'refused'", 'tray_recorded', 'tray_duplicate', 'tray_refused', "'error'"]
      .every((o) => hook.includes(o));
    const failOpen = fs.readFileSync(path.join(__dirname, '..', 'lib', 'square-webhook-log.js'), 'utf8').includes("money path unaffected");
    const migration = fs.existsSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '079_square_webhook_events.sql'));
    check('SW11 [SQW3]: the delivery log upserts by Square event id (redelivery = attempts+1), logs bad signatures with no event id, covers every handler outcome, fails open, migration 079 exists',
      upsert && nullEvent && outcomes && failOpen && migration, JSON.stringify({ upsert, nullEvent, outcomes, failOpen, migration }));
  }

  // ---- SW12 (SQW3): one-tap record goes through the SAME seam; dismiss keeps the row ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const rec = srv.slice(srv.indexOf("app.post('/api/finances/counter-payments/:id/record'"), srv.indexOf("app.post('/api/finances/counter-payments/:id/dismiss'"));
    const locked = /FROM square_unmatched_payments WHERE id = \$1 AND workspace_id = \$2 FOR UPDATE/.test(rec);
    const idempotent = rec.includes("if (tray.status === 'recorded')") && rec.includes('already: true');
    const walkIn = /INSERT INTO transactions[\s\S]{0,600}'card','paid','walk_in'/.test(rec);
    const seam = /INSERT INTO transaction_payments[\s\S]{0,400}'payment', 'square', 'square', \$4, 'completed'/.test(rec)
      && rec.includes('tray.square_order_id || tray.square_payment_id') && rec.includes('tray.square_payment_id]');
    const marks = rec.includes("recorded_via = 'one_tap'");
    const neverPending = !/processor_ref = \$1/.test(rec); // never reads a pending link row
    const dis = srv.slice(srv.indexOf("app.post('/api/finances/counter-payments/:id/dismiss'"), srv.indexOf("app.post('/api/finances/counter-payments/:id/dismiss'") + 1500);
    const dismissKeeps = /SET status = 'dismissed', dismiss_reason = \$1/.test(dis) && /AND status = 'unrecorded'/.test(dis) && !/DELETE FROM square_unmatched_payments/.test(dis);
    const ui = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const tray = ui.includes('id="finCounterCard"') && ui.includes('Record as walk-in sale') && ui.includes('function loadCounterPayments') && ui.includes('if (isPS) loadCounterPayments();');
    check('SW12 [SQW3]: one-tap record is FOR UPDATE-locked + idempotent, writes an ordinary paid walk_in transaction + a completed square payment row through the seam (processor_ref = order id, square_payment_id kept), never reads pending link rows; dismiss keeps the row; the Finances tray exists and loads for PS',
      locked && idempotent && walkIn && seam && marks && neverPending && dismissKeeps && tray,
      JSON.stringify({ locked, idempotent, walkIn, seam, marks, neverPending, dismissKeeps, tray }));
  }

  console.log(`${pass}/${pass + fail} — square-webhook gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

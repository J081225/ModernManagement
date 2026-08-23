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
    // SQW6 appended '/square/pos-return' after it — pin membership, not
    // list position.
    const whitelisted = /const open = \[[^\]]*'\/square\/webhook'/.test(srv);
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
    // SQW5 moved the record core INTO this lib (it legitimately writes
    // the books) — the no-books invariant now scopes to the RECORDER
    // alone: tray inserts only, never transactions/transaction_payments.
    const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'square-walkins.js'), 'utf8');
    const recorderSlice = libSrc.slice(libSrc.indexOf('async function recordUnmatchedSquarePayment'), libSrc.indexOf('async function recordTrayRowAsSale'));
    const noRevenueTouch = recorderSlice.length > 0 && !/INSERT INTO transactions|INSERT INTO transaction_payments|UPDATE transactions\b/.test(recorderSlice);
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

  // ---- SW12 (SQW3→SQW5): ONE record core, shared by one-tap and auto ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'square-walkins.js'), 'utf8');
    // The core lives in the lib — FOR UPDATE, idempotent, walk_in + seam.
    const core = lib.slice(lib.indexOf('async function recordTrayRowAsSale'));
    const locked = /FROM square_unmatched_payments WHERE id = \$1 AND workspace_id = \$2 FOR UPDATE/.test(core);
    const idempotent = core.includes("if (tray.status === 'recorded')") && core.includes('already: true');
    const walkIn = /INSERT INTO transactions[\s\S]{0,700}'card','paid','walk_in'/.test(core);
    const seam = /INSERT INTO transaction_payments[\s\S]{0,400}'payment', 'square', 'square', \$4, 'completed'/.test(core)
      && core.includes('tray.square_order_id || tray.square_payment_id') && core.includes('tray.square_payment_id]');
    const provenance = core.includes("via === 'auto' ? 'auto' : 'one_tap'");
    const neverPending = !/processor_ref = \$1/.test(core);
    // Both call sites use the SAME function with honest via markers.
    const rec = srv.slice(srv.indexOf("app.post('/api/finances/counter-payments/:id/record'"), srv.indexOf("app.patch('/api/workspace/square-auto-record'"));
    const oneTapAdapter = rec.includes('squareWalkins.recordTrayRowAsSale(pool') && rec.includes("via: 'one_tap'")
      && !/INSERT INTO transactions/.test(rec); // the endpoint no longer has its own copy
    const hook = srv.slice(srv.indexOf("app.post('/api/square/webhook'"), srv.indexOf("app.get('/api/finances/counter-payments'"));
    // SQW7 inserted the ref-match ahead of auto-record: the auto path
    // now also requires !refMatched (a ref-matched row is already on
    // its originating sale — auto must never double-record it).
    const autoPath = /lane2\.ok && !lane2\.duplicate && !refMatched && lane2\.auto_record[\s\S]{0,300}recordTrayRowAsSale[\s\S]{0,200}via: 'auto'/.test(hook)
      && hook.includes('auto_failed');
    const dis = srv.slice(srv.indexOf("app.post('/api/finances/counter-payments/:id/dismiss'"), srv.indexOf("app.post('/api/finances/counter-payments/:id/dismiss'") + 1500);
    const dismissKeeps = /SET status = 'dismissed', dismiss_reason = \$1/.test(dis) && /AND status = 'unrecorded'/.test(dis) && !/DELETE FROM square_unmatched_payments/.test(dis);
    const ui = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const tray = ui.includes('id="finCounterCard"') && ui.includes('Record as walk-in sale') && ui.includes('function loadCounterPayments') && ui.includes('if (isPS) loadCounterPayments();');
    check('SW12 [SQW3+SQW5]: ONE record core (lib) — FOR UPDATE, idempotent, walk_in + seam, honest via markers — with the endpoint as a one-tap adapter (no duplicate SQL) and the webhook auto path calling the SAME function; dismiss keeps the row; the tray UI loads for PS',
      locked && idempotent && walkIn && seam && provenance && neverPending && oneTapAdapter && autoPath && dismissKeeps && tray,
      JSON.stringify({ locked, idempotent, walkIn, seam, provenance, neverPending, oneTapAdapter, autoPath, dismissKeeps, tray }));
  }

  // ---- SW13 (SQW5): the auto-record toggle is honest — default OFF everywhere ----
  {
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '081_square_auto_record.sql'), 'utf8');
    const schemaOff = mig.includes('square_auto_record_walkins BOOLEAN NOT NULL DEFAULT FALSE');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const notPrechecked = /id="sqAutoRecordToggle"(?![^>]*checked)/.test(ui) && !/id="sqAutoRecordToggle"[^>]*\schecked/.test(ui);
    const reflectsStored = ui.includes("ar.checked = ps.square_auto_record_walkins === true;");
    const failResync = /box\.checked = !box\.checked;[\s\S]{0,120}Could not save/.test(ui);
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const patchStrict = srv.includes("const enabled = (req.body || {}).enabled === true;");
    const surfaced = srv.includes('square_auto_record_walkins: squareAutoRecord,');
    const autoMarker = ui.includes("x.recorded_via === 'auto' ? ' (auto)' : ''");
    check('SW13 [SQW5]: default OFF at the schema (081), the checkbox is never pre-checked and reflects stored truth only (resyncs on failure), the PATCH treats anything but true as false, the flag is surfaced on the summary, and auto-recorded rows are marked (auto) in the tray',
      schemaOff && notPrechecked && reflectsStored && failResync && patchStrict && surfaced && autoMarker,
      JSON.stringify({ schemaOff, notPrechecked, reflectsStored, failResync, patchStrict, surfaced, autoMarker }));
  }

  // ---- SW14 (SQW6): the deep-link launcher + signed return ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const cip = srv.slice(srv.indexOf("app.get('/api/transactions/:id/charge-in-person'"), srv.indexOf("app.get('/api/square/pos-return'"));
    const iosUrl = cip.includes("'square-commerce-v1://payment/create?data=' + encodeURIComponent(JSON.stringify(iosData))")
      && cip.includes("version: '1.3'") && cip.includes('auto_return: true');
    const androidUrl = cip.includes('intent://#Intent;action=com.squareup.pos.action.CHARGE;package=com.squareup;')
      && cip.includes('S.com.squareup.pos.NOTE=') && cip.includes('S.com.squareup.pos.REQUEST_METADATA=')
      && cip.includes('S.browser_fallback_url=');
    const refGrade = cip.includes("'Ref ' + tx.id + ' · ' + biz"); // R9: receipt-grade, never debug-grade
    const balanceOnly = cip.includes('const balance = tx.total_cents - (tx.amount_paid_cents || 0);')
      && cip.includes("['unpaid', 'partially_paid', 'pending'].includes(tx.status)");
    const honest503 = cip.includes('Charge in person is not configured yet');
    const ret = srv.slice(srv.indexOf("app.get('/api/square/pos-return'"), srv.indexOf('// SQW5 (ruling R3)'));
    const signedState = srv.includes('function _mintPosState') && srv.includes('crypto.timingSafeEqual')
      && ret.includes('_verifyPosState(state)') && ret.includes('Link expired');
    const belt = ret.includes('SET square_pos_transaction_id = COALESCE(square_pos_transaction_id, $1)');
    const openListed = /const open = \[[^\]]*'\/square\/pos-return'/.test(srv);
    const mig = fs.existsSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '082_square_pos_transaction_id.sql'));
    check('SW14 [SQW6]: charge-in-person builds both platform URLs (iOS scheme + Android intent with NOTE/metadata/fallback), Ref is receipt-grade, balance-only on unpaid sales, honest 503 unconfigured; pos-return verifies the signed state (timing-safe, TTL), stores the POS id belt (082), and is session-open',
      iosUrl && androidUrl && refGrade && balanceOnly && honest503 && signedState && belt && openListed && mig,
      JSON.stringify({ iosUrl, androidUrl, refGrade, balanceOnly, honest503, signedState, belt, openListed, mig }));
  }

  // ---- SW15 (SQW7): the ref-match — provenance with guards ----
  {
    const { matchAndRecordRefPayment, _refFromNote } = require(path.join(__dirname, '..', 'lib', 'square-walkins'));
    const silent = { log: () => {}, error: () => {} };
    const noteParse = _refFromNote('Ref 12 · Northside Barbers') === 12 && _refFromNote('MM-TX-7') === 7
      && _refFromNote('thanks for the trim') === null && _refFromNote('Refund for last week') === null;
    const mkPool = ({ tray, tx } = {}) => {
      const calls = [];
      const client = {
        query: async (sql, params) => {
          calls.push({ sql, params });
          if (/FROM square_unmatched_payments/.test(sql)) return { rows: tray ? [tray] : [] };
          if (/FROM transactions WHERE id = \$1/.test(sql)) return { rows: tx ? [tx] : [] };
          if (/FROM transactions WHERE workspace_id = \$1 AND square_pos_transaction_id/.test(sql)) return { rows: tx ? [tx] : [] };
          return { rows: [] };
        },
        release: () => {},
      };
      return { calls, connect: async () => client };
    };
    const tray = { id: 9, amount_cents: 5000, tip_cents: 500, total_cents: 5500, square_order_id: 'ORD9', square_payment_id: 'PAY9', paid_at: '2026-08-23T19:00:00Z' };
    const tx12 = { id: 12, workspace_id: 17, total_cents: 5000, amount_paid_cents: 0, status: 'unpaid' };
    const payment = { id: 'PAY9', order_id: 'ORD9', note: 'Ref 12 · Northside Barbers' };
    // exact-balance match records against tx 12: payment row via the seam + ratchet to paid + tray ref_match
    const a = mkPool({ tray, tx: tx12 });
    const ra = await matchAndRecordRefPayment(a, { trayId: 9, workspaceId: 17, payment, logger: silent });
    const seamIns = a.calls.find((c) => /INSERT INTO transaction_payments/.test(c.sql));
    const seamOk = seamIns && /'payment', 'square', 'square', \$4, 'completed'/.test(seamIns.sql) && seamIns.params[1] === 12 && seamIns.params[5] === 'PAY9';
    const ratchet = a.calls.some((c) => /UPDATE transactions[\s\S]{0,200}amount_paid_cents = amount_paid_cents \+ \$1[\s\S]{0,120}status = 'paid'/.test(c.sql));
    const marked = a.calls.some((c) => /recorded_via = 'ref_match'/.test(c.sql));
    // amount mismatch leaves the tray row alone
    const b = mkPool({ tray: { ...tray, amount_cents: 4000, total_cents: 4000 }, tx: tx12 });
    const rb = await matchAndRecordRefPayment(b, { trayId: 9, workspaceId: 17, payment, logger: silent });
    // no ref and no pos id = no_ref, untouched
    const rc = await matchAndRecordRefPayment(mkPool({ tray, tx: tx12 }), { trayId: 9, workspaceId: 17, payment: { id: null, order_id: null, note: 'nice cut' }, logger: silent });
    // webhook order: ref-match runs BEFORE auto-record
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const hook = srv.slice(srv.indexOf("app.post('/api/square/webhook'"), srv.indexOf("app.get('/api/finances/counter-payments'"));
    const orderOk = hook.indexOf('matchAndRecordRefPayment') < hook.indexOf('lane2.auto_record') && hook.includes('!refMatched && lane2.auto_record')
      && hook.includes("'+ref:sale#'");
    check('SW15 [SQW7]: the ref-match parses receipt-grade + legacy refs (and only refs), records against the ORIGINATING transaction through the seam with a paid ratchet + ref_match provenance ONLY on exact balance, leaves mismatches/no-ref in the tray, and runs BEFORE auto-record in the webhook',
      noteParse && ra.ok && ra.transaction_id === 12 && seamOk && ratchet && marked && rb.ok === false && rb.reason === 'amount_mismatch' && rc.ok === false && rc.reason === 'no_ref' && orderOk,
      JSON.stringify({ noteParse, ra, seamOk, ratchet, marked, rb: rb.reason, rc: rc.reason, orderOk }));
  }

  console.log(`${pass}/${pass + fail} — square-webhook gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

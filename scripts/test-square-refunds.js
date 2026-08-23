// scripts/test-square-refunds.js — SQ5. Real money-moving Square refunds.
//
// Drives the real refunds lib + the ledger refund core, and source-pins
// the re-auth-gated processor-aware endpoint, the refund.* webhook, the
// record-only assistant tool, and — Jay's explicit pin — that a refund
// NEVER enters the revenue-summed transaction_payments table.
const path = require('path');
const fs = require('fs');
const squareRefunds = require(path.join(__dirname, '..', 'lib', 'square-refunds'));
const paymentLedger = require(path.join(__dirname, '..', 'lib', 'payment-ledger'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// --- fetch stub for the lib ---
let captured = null;
function stub(routes) {
  global.fetch = async (url, opts) => {
    captured = opts && opts.body ? JSON.parse(opts.body) : null;
    for (const [re, resp] of routes) { if (re.test(url)) return resp; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// --- in-memory ledger db (BEGIN/COMMIT + the refund core's queries) ---
function makeLedgerDb(refunds, txns) {
  let nextId = 9000;
  const client = {
    query: async (sql, params) => {
      const s = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
      if (/SELECT sr\.\*, w\.square_merchant_id/.test(s)) {
        const sr = refunds.get(params[0]);
        return { rows: sr ? [{ ...sr }] : [] };
      }
      if (/SELECT \* FROM transactions WHERE id = \$1 AND workspace_id = \$2/.test(s)) {
        const t = txns.get(params[0]); return { rows: t ? [{ ...t }] : [] };
      }
      if (/INSERT INTO transactions/.test(s)) {
        const id = nextId++; txns.set(id, { id, source: 'refund' }); return { rows: [{ id }] };
      }
      if (/UPDATE transactions SET amount_refunded_cents/.test(s)) {
        const t = txns.get(params[2]); if (t) { t.amount_refunded_cents = params[0]; t.status = params[1]; } return { rows: [] };
      }
      if (/UPDATE square_refunds SET status = 'completed'/.test(s)) {
        for (const sr of refunds.values()) if (sr.id === params[0]) { sr.status = 'completed'; sr.refund_child_transaction_id = params[1]; }
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client };
}

(async () => {
  // ---- SR1: resolve payment id for an order (fallback) ----
  {
    stub([[/\/v2\/orders\//, { ok: true, status: 200, json: async () => ({ order: { id: 'ORD1', tenders: [{ payment_id: 'PAY1' }] } }) }]]);
    const out = await squareRefunds.resolvePaymentIdForOrder({ accessToken: 't', orderId: 'ORD1' });
    check('SR1: resolvePaymentIdForOrder returns the payment id from the order tenders', out.paymentId === 'PAY1' && out.orderId === 'ORD1', JSON.stringify(out));
  }

  // ---- SR2: the ruling-2 guard — payment must tie to the order ----
  {
    stub([[/\/v2\/payments\//, { ok: true, status: 200, json: async () => ({ payment: { id: 'PAY1', order_id: 'ORD1', amount_money: { amount: 4500 } } }) }]]);
    const ok = await squareRefunds.assertPaymentTiesToOrder({ accessToken: 't', paymentId: 'PAY1', orderId: 'ORD1' });
    stub([[/\/v2\/payments\//, { ok: true, status: 200, json: async () => ({ payment: { id: 'PAY1', order_id: 'OTHER' } }) }]]);
    let threw = false; try { await squareRefunds.assertPaymentTiesToOrder({ accessToken: 't', paymentId: 'PAY1', orderId: 'ORD1' }); } catch (e) { threw = /does not belong to order/.test(e.message); }
    check('SR2: assertPaymentTiesToOrder passes when payment.order_id matches, and THROWS when it does not (never refund an untied id)',
      ok && ok.orderId === 'ORD1' && threw);
  }

  // ---- SR3: RefundPayment payload (idempotent) + verbatim error ----
  {
    stub([[/\/v2\/refunds/, { ok: true, status: 200, json: async () => ({ refund: { id: 'RF1', status: 'PENDING', order_id: 'ORD1' } }) }]]);
    const out = await squareRefunds.refundSquarePayment({ accessToken: 't', paymentId: 'PAY1', amountCents: 4500, idempotencyKey: 'sqrf-17-6-4500', reason: 'test' });
    const bodyOk = captured && captured.idempotency_key === 'sqrf-17-6-4500' && captured.payment_id === 'PAY1' && captured.amount_money.amount === 4500 && captured.amount_money.currency === 'USD';
    stub([[/\/v2\/refunds/, { ok: false, status: 400, json: async () => ({ errors: [{ code: 'BAD_REQUEST', detail: 'nope' }] }) }]]);
    let threw = null; try { await squareRefunds.refundSquarePayment({ accessToken: 't', paymentId: 'PAY1', amountCents: 4500, idempotencyKey: 'k' }); } catch (e) { threw = e; }
    check('SR3: refundSquarePayment sends {idempotency_key, payment_id, amount_money} and, on failure, throws Square\'s verbatim error + status',
      out.refund_id === 'RF1' && out.status === 'PENDING' && bodyOk && !!threw && /BAD_REQUEST/.test(threw.message) && threw.squareStatus === 400,
      JSON.stringify({ out, bodyOk, err: threw && threw.message }));
  }

  // ---- SR4: ledger core — full refund → refunded, + child, idempotent ----
  {
    const refunds = new Map([['RF1', { id: 1, workspace_id: 17, transaction_id: 6, square_refund_id: 'RF1', amount_cents: 4500, currency: 'USD', status: 'pending', reason: 'r', created_by_user_id: 14, square_merchant_id: 'M1', refund_child_transaction_id: null }]]);
    const txns = new Map([[6, { id: 6, workspace_id: 17, total_cents: 4500, amount_refunded_cents: 0, status: 'paid', payment_method: 'square' }]]);
    const db = makeLedgerDb(refunds, txns);
    const r1 = await paymentLedger.processSquareRefundCompleted(db, { refundId: 'RF1', merchantId: 'M1', amountCents: 4500, currency: 'USD' });
    const parent = txns.get(6);
    const r2 = await paymentLedger.processSquareRefundCompleted(db, { refundId: 'RF1', merchantId: 'M1', amountCents: 4500, currency: 'USD' });
    check('SR4: processSquareRefundCompleted verifies + creates the child + ratchets parent to "refunded"; a second delivery is an idempotent no-op',
      r1.ok && r1.parent_status === 'refunded' && parent.status === 'refunded' && parent.amount_refunded_cents === 4500
        && refunds.get('RF1').status === 'completed' && r2.idempotent === true,
      JSON.stringify({ r1: r1.parent_status, parent: parent.status, refunded: parent.amount_refunded_cents, r2: r2.idempotent }));
  }

  // ---- SR5: partial refund is honest (stays paid), + amount mismatch refused ----
  {
    const refunds = new Map([['RF2', { id: 2, workspace_id: 17, transaction_id: 8, square_refund_id: 'RF2', amount_cents: 2000, currency: 'USD', status: 'pending', reason: 'r', created_by_user_id: 14, square_merchant_id: 'M1', refund_child_transaction_id: null }]]);
    const txns = new Map([[8, { id: 8, workspace_id: 17, total_cents: 5000, amount_refunded_cents: 0, status: 'paid', payment_method: 'square' }]]);
    const db = makeLedgerDb(refunds, txns);
    const partial = await paymentLedger.processSquareRefundCompleted(db, { refundId: 'RF2', merchantId: 'M1', amountCents: 2000, currency: 'USD' });
    const staysPaid = txns.get(8).status === 'paid' && txns.get(8).amount_refunded_cents === 2000;
    // amount mismatch → refused (three-way check)
    const refunds2 = new Map([['RF3', { id: 3, workspace_id: 17, transaction_id: 8, square_refund_id: 'RF3', amount_cents: 2000, currency: 'USD', status: 'pending', square_merchant_id: 'M1' }]]);
    const db2 = makeLedgerDb(refunds2, new Map([[8, { id: 8, workspace_id: 17, total_cents: 5000, amount_refunded_cents: 0, status: 'paid' }]]));
    const mismatch = await paymentLedger.processSquareRefundCompleted(db2, { refundId: 'RF3', merchantId: 'M1', amountCents: 9999, currency: 'USD' });
    check('SR5: a partial refund keeps the parent "paid" (amount_refunded ratchets); an amount mismatch is REFUSED (three-way check)',
      partial.ok && partial.parent_status === 'paid' && staysPaid && mismatch.ok === false && mismatch.reason === 'amount_mismatch',
      JSON.stringify({ partial: partial.parent_status, staysPaid, mismatch: mismatch.reason }));
  }

  // ---- SR6: endpoint — re-auth gate, processor-aware, guard-before-refund, G2 ----
  {
    const blk = srv.slice(srv.indexOf("app.post('/api/transactions/:id/refund'"), srv.indexOf("// E14 Step 4 / Stage 1: owner-initiated online card charge"));
    const processorAware = /paidVia && paidVia\.processor === 'square'/.test(blk);
    const reauth = /credentials\._reauth\(pool, req\.session\.userId, \(req\.body \|\| \{\}\)\.current_password/.test(blk);
    // the ruling-2 verify runs BEFORE the refund call
    const guardBeforeRefund = blk.indexOf('assertPaymentTiesToOrder') !== -1
      && blk.indexOf('assertPaymentTiesToOrder') < blk.indexOf('refundSquarePayment(');
    const idempotent = blk.includes('idempotencyKey: `sqrf-${workspaceId}-${id}-${amount_cents}`');
    const isolatedTable = blk.includes('INSERT INTO square_refunds') && !/INSERT INTO transaction_payments/.test(blk);
    const g2 = /money_moved: moved/.test(blk) && /refund\.status === 'COMPLETED'/.test(blk);
    check('SR6: the refund endpoint is processor-aware, re-auths for Square, VERIFIES the payment ties to the order BEFORE refunding, uses a stable idempotency key, records to square_refunds (not transaction_payments), and only claims money_moved on Square\'s COMPLETED',
      processorAware && reauth && guardBeforeRefund && idempotent && isolatedTable && g2,
      JSON.stringify({ processorAware, reauth, guardBeforeRefund, idempotent, isolatedTable, g2 }));
  }

  // ---- SR7: webhook handles refund.* + captures payment_id ----
  {
    // SQW3: the handler grew past a fixed 3200-char window (twice now) —
    // slice to the next route instead, so handler growth can't evict
    // the anchors this row pins.
    const whStart = srv.indexOf("app.post('/api/square/webhook'");
    const whEnd = srv.indexOf("app.get('/api/finances/counter-payments'", whStart);
    const wh = srv.slice(whStart, whEnd > whStart ? whEnd : whStart + 6000);
    const refundEvents = /type === 'refund\.created' \|\| type === 'refund\.updated'/.test(wh) && wh.includes('processSquareRefundCompleted');
    const capturesPaymentId = wh.includes('paymentId: payment.id'); // unique to the webhook's payment path
    check('SR7: the Square webhook settles refund.created/updated via processSquareRefundCompleted (COMPLETED only) and captures payment.id at payment completion',
      refundEvents && capturesPaymentId, JSON.stringify({ refundEvents, capturesPaymentId }));
  }

  // ---- SR8: LAWS — assistant tool record-only; no refund ever in transaction_payments ----
  {
    const tool = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'refund_transaction.js'), 'utf8');
    const recordOnly = tool.includes('No money moved') && !tool.includes('_reauth') && !tool.includes('processSquareRefundCompleted') && !tool.includes('refundSquarePayment');
    // census: refund money-state lives ONLY in square_refunds; no code
    // inserts a transaction_payments row typed 'refund', and the SQ5
    // migration never widened payment_type to include 'refund'.
    const ledger = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payment-ledger.js'), 'utf8');
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '070_square_refunds.sql'), 'utf8');
    const noRefundType = !/payment_type[\s:='"]+['"]?refund/i.test(srv + ledger + tool)
      && !/payment_type[\s\S]{0,60}refund/i.test(mig);
    const stateIsolated = srv.includes('INSERT INTO square_refunds');
    check('SR8 [laws]: the assistant refund tool stays RECORD-ONLY (no re-auth, no money-moving call, says "No money moved"); and NO refund ever enters the revenue-summed transaction_payments table (state lives in square_refunds; payment_type never widened to refund)',
      recordOnly && noRefundType && stateIsolated, JSON.stringify({ recordOnly, noRefundType, stateIsolated }));
  }

  // ---- SR9: exactly ONE refund banner per processor (live-test fix) ----
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const hasRecordBanner = app.includes('id="txRefundRecordBanner"');
    // the record-only banner is HIDDEN for Square; the Square banner is
    // SHOWN only for Square — opposite toggles, so never both at once.
    const recordHiddenForSquare = app.includes("document.getElementById('txRefundRecordBanner').style.display = sq ? 'none' : ''");
    const squareShownForSquare = app.includes("document.getElementById('txRefundSquareBanner').style.display = sq ? '' : 'none'");
    check('SR9: exactly ONE refund banner per processor — the record-only "does not move money" banner hides for a Square-paid txn (money-moving) and shows for Stripe/cash; the Square banner is the mirror (per-processor truth, no double banner)',
      hasRecordBanner && recordHiddenForSquare && squareShownForSquare,
      JSON.stringify({ hasRecordBanner, recordHiddenForSquare, squareShownForSquare }));
  }

  // ---- SR10/SR11 (SQW4): merchant-side refunds of walk-ins ----
  {
    const { correlateMerchantSideRefund } = require(path.join(__dirname, '..', 'lib', 'square-walkins'));
    const silent = { log: () => {}, error: () => {} };
    const mk = ({ payments = [], trayUpdated = 0 } = {}) => {
      const calls = [];
      return { calls, query: async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM transaction_payments tp/.test(sql)) return { rows: payments };
        if (/UPDATE square_unmatched_payments/.test(sql)) return { rows: Array.from({ length: trayUpdated }, () => ({ id: 2, workspace_id: 17 })) };
        return { rows: [] };
      } };
    };
    const refund = { id: 'RF1', payment_id: 'PAY1', status: 'COMPLETED', amount_money: { amount: 1234, currency: 'USD' }, reason: 'Customer request' };
    // (a) recorded walk-in → square_refunds row with initiated_by='square', amount = Square's, hands to the core
    const a = mk({ payments: [{ id: 5, workspace_id: 17, transaction_id: 8, amount_cents: 1234, square_merchant_id: 'M1', amount_refunded_cents: 0 }] });
    const ra = await correlateMerchantSideRefund(a, { refund, merchantId: 'M1', logger: silent });
    const ins = a.calls.find((c) => /INSERT INTO square_refunds/.test(c.sql));
    const rowShape = ins && /'pending', \$6, NULL, 'square'/.test(ins.sql) && ins.params[2] === 'RF1' && ins.params[3] === 'PAY1' && ins.params[4] === 1234 && ins.params[1] === 8;
    check('SR10 [SQW4]: a COMPLETED refund Square issued on a RECORDED walk-in creates the square_refunds row (initiated_by=square, amount=Square\'s, owner NULL) for the existing completion core to settle',
      ra.ok && ra.path === 'walkin' && ra.transaction_id === 8 && rowShape, JSON.stringify({ ra, rowShape }));
    // guards: over-refund, merchant mismatch, unrecorded tray row → refunded, unknown payment → untouched
    const over = await correlateMerchantSideRefund(mk({ payments: [{ id: 5, workspace_id: 17, transaction_id: 8, amount_cents: 1234, square_merchant_id: 'M1', amount_refunded_cents: 1000 }] }), { refund, merchantId: 'M1', logger: silent });
    const wrongM = await correlateMerchantSideRefund(mk({ payments: [{ id: 5, workspace_id: 17, transaction_id: 8, amount_cents: 1234, square_merchant_id: 'M1', amount_refunded_cents: 0 }] }), { refund, merchantId: 'M2', logger: silent });
    const trayP = mk({ trayUpdated: 1 });
    const tray = await correlateMerchantSideRefund(trayP, { refund, merchantId: 'M1', logger: silent });
    const trayMark = trayP.calls.some((c) => /SET status = 'refunded'/.test(c.sql) && /AND status = 'unrecorded'/.test(c.sql));
    const unknown = await correlateMerchantSideRefund(mk(), { refund, merchantId: 'M1', logger: silent });
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'square-walkins.js'), 'utf8');
    // SQW5: the record core (recordTrayRowAsSale) lives in this lib and
    // writes the books by design — the never-touches invariant scopes to
    // the CORRELATOR alone (it hands settlement to the SQ5 core).
    const correlatorSlice = src.slice(src.indexOf('async function correlateMerchantSideRefund'), src.indexOf('module.exports'));
    const neverTouchesBooks = correlatorSlice.length > 0 && !/INSERT INTO transactions|INSERT INTO transaction_payments|UPDATE transactions\b/.test(correlatorSlice);
    const wired = /rr\.reason === 'no_refund_row'[\s\S]{0,400}correlateMerchantSideRefund[\s\S]{0,600}processSquareRefundCompleted/.test(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'));
    const mig = fs.existsSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '080_square_refunds_initiated_by.sql'));
    check('SR11 [SQW4]: over-refund and merchant mismatch are refused; an UNRECORDED tray row is marked refunded (never income); an unknown payment is untouched; the correlator never writes the books itself; the webhook re-runs the core after correlation; migration 080 exists',
      over.reason === 'over_refund' && wrongM.reason === 'merchant_mismatch' && tray.ok && tray.path === 'tray' && trayMark && unknown.reason === 'payment_unknown' && neverTouchesBooks && wired && mig,
      JSON.stringify({ over: over.reason, wrongM: wrongM.reason, tray: tray.path, trayMark, unknown: unknown.reason, neverTouchesBooks, wired, mig }));
  }

  console.log(`${pass}/${pass + fail} — square-refunds gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

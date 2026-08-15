// scripts/test-square-payment-link.js — Square CreatePaymentLink payload
// + verbatim error propagation.
//
// The live test failed with a self-echoing "Could not create payment
// link: Could not create payment link". Two defects: (1) the body sent
// quick_pay AND a malformed double-nested `order` — an invalid payload;
// (2) Square's real error was swallowed by a generic message. This pins
// the fixed body shape and that the real reason reaches the owner.
const path = require('path');
const fs = require('fs');
const { createSquarePaymentLink } = require(path.join(__dirname, '..', 'lib', 'square-payments'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

let capturedBody = null, locationsCalled = false;
function stubFetch(paymentResponse) {
  capturedBody = null; locationsCalled = false;
  global.fetch = async (url, opts) => {
    if (/\/v2\/locations/.test(url)) {
      locationsCalled = true;
      return { ok: true, status: 200, json: async () => ({ locations: [{ id: 'LOC1', status: 'ACTIVE' }] }) };
    }
    if (/\/v2\/online-checkout\/payment-links/.test(url)) {
      capturedBody = JSON.parse(opts.body);
      return paymentResponse;
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

(async () => {
  // ---- SP1/SP2: happy path — quick_pay-only body, location resolved ----
  {
    stubFetch({ ok: true, status: 200, json: async () => ({ payment_link: { url: 'https://squareupsandbox.com/pl/abc', order_id: 'ORD1', id: 'PL1' } }) });
    const out = await createSquarePaymentLink({
      accessToken: 'sbx', amountCents: 4500, businessName: 'R2 Labs',
      paymentType: 'payment', idempotencyKey: 'k1', redirectUrl: 'https://x/y', referenceId: 6,
    });
    const bodyOk = capturedBody && capturedBody.quick_pay
      && capturedBody.quick_pay.location_id === 'LOC1'
      && capturedBody.quick_pay.price_money && capturedBody.quick_pay.price_money.amount === 4500
      && !('order' in capturedBody);                      // the invalid field is GONE
    check('SP1: the payment-links body uses quick_pay (with location_id + price_money) and sends NO conflicting `order` field — the invalid quick_pay+order payload is fixed',
      bodyOk, JSON.stringify(capturedBody));
    check('SP2: the seller location is resolved (GET /v2/locations) before the link is built, and order_id comes back for webhook matching',
      locationsCalled && out.order_id === 'ORD1' && out.url.length > 0, JSON.stringify(out));
  }

  // ---- SP3: a failed call throws Square's VERBATIM error + status ----
  {
    stubFetch({ ok: false, status: 400, json: async () => ({ errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'Only one of quick_pay, order can be set.' }] }) });
    let threw = null;
    try {
      await createSquarePaymentLink({ accessToken: 'sbx', amountCents: 4500, paymentType: 'payment', idempotencyKey: 'k2' });
    } catch (e) { threw = e; }
    check('SP3: a failed payment-link call throws with Square\'s verbatim error body in the message and the HTTP status on err.squareStatus — never swallowed',
      !!threw && /BAD_REQUEST/.test(threw.message) && /Only one of quick_pay/.test(threw.message) && threw.squareStatus === 400,
      threw && threw.message);
  }

  // ---- SP4: the owner surface carries the REAL reason end-to-end ----
  {
    const pr = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payment-requests.js'), 'utf8');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const logsVerbatim = pr.includes('link creation FAILED (status ${err.squareStatus') && pr.includes('detail: err.message');
    const endpointForwardsDetail = srv.includes('if (result.detail) body.detail = result.detail;');
    const clientShowsDetail = app.includes('data.detail || data.error');
    check('SP4: the real reason reaches the owner — lib logs status+body verbatim and returns detail, the endpoint forwards detail, and the modal shows data.detail (not the self-echoing generic)',
      logsVerbatim && endpointForwardsDetail && clientShowsDetail,
      JSON.stringify({ logsVerbatim, endpointForwardsDetail, clientShowsDetail }));
  }

  console.log(`${pass}/${pass + fail} — square-payment-link gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

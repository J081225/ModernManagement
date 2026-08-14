// scripts/test-request-payment-doorknob.js — the owner Request-payment
// doorknob + link readback.
//
// The transaction detail modal's Request payment button was gated on
// Stripe's connect_status='ready', so a Square-active workspace never
// saw it. Gate on the ACTIVE processor (cards_ready) instead, scope to
// unpaid/partially_paid, and DISPLAY the created link with a copy button
// and honest SMS-delivery status.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

(async () => {
  // ---- RD1: the buttons gate on the ACTIVE processor, not Stripe-only ----
  {
    const cardsReadyGate = app.includes('const cardsReady = !!(window._planSummary && window._planSummary.cards_ready)');
    const paymentScoped = app.includes("const canRequestPayment = cardsReady && ['unpaid', 'partially_paid'].includes(tx.status)");
    const oldStripeGateGone = !app.includes("connectReady && ['draft', 'pending', 'unpaid', 'partially_paid']");
    check('RD1: Request payment is gated on cards_ready (active processor: Stripe ready OR Square connected), scoped to unpaid/partially_paid — not the Stripe-only connect_status gate that hid it for Square',
      cardsReadyGate && paymentScoped && oldStripeGateGone,
      JSON.stringify({ cardsReadyGate, paymentScoped, oldStripeGateGone }));
  }

  // ---- RD2: the button is wired to the owner request-payment endpoint ----
  {
    const button = app.includes("requestPaymentLink(${tx.id}, 'payment')");
    const calls = app.includes('/api/transactions/${txId}/request-payment');
    check('RD2: the Request payment button calls requestPaymentLink → POST /api/transactions/:id/request-payment (the owner-triggered createPaymentRequest path)',
      button && calls, JSON.stringify({ button, calls }));
  }

  // ---- RD3: the endpoint hands back the URL (per active processor) + texted ----
  {
    const returnsUrl = srv.includes('res.json({ url: result.url, payment_id: result.payment_id, texted: result.texted })');
    check('RD3: POST /request-payment returns { url, texted } — the processor link (Square/Stripe per active processor) comes back to the owner', returnsUrl);
  }

  // ---- RD4: link readback — copy button + honest SMS status, safe value ----
  {
    const box = app.includes('function renderPaymentLinkBox');
    const alwaysShows = app.includes('renderPaymentLinkBox(data.url || \'\', !!data.texted, label)');
    const copyBtn = app.includes('function copyPaymentLink') && app.includes('onclick="copyPaymentLink()"');
    const honestSms = app.includes('Texted to the customer') && app.includes('Not texted (no phone on file)');
    const safeValue = app.includes('if (input) input.value = url'); // value via property, not innerHTML
    check('RD4: on success the link ALWAYS displays with a Copy button and an honest texted/not-texted line; the URL is set via .value (no HTML injection)',
      box && alwaysShows && copyBtn && honestSms && safeValue,
      JSON.stringify({ box, alwaysShows, copyBtn, honestSms, safeValue }));
  }

  console.log(`${pass}/${pass + fail} — request-payment-doorknob gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

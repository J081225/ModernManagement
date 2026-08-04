// scripts/test-signup-remedy.js — SP4c suite.
//
// Drives the REAL lib/signup-remedy with a fixture Stripe client. The
// orchestrator's failure path is source-pinned (its transaction isn't
// bootable in a test). The rows that matter most: the money is never
// silently kept, a redelivery can never double-refund, and a refund
// failure escalates instead of going quiet.
const path = require('path');
const fs = require('fs');
const { remedyFailedSignup, remedySummary, isAlreadyDone } =
  require(path.join(__dirname, '..', 'lib', 'signup-remedy'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Fixture Stripe: records every call + its idempotency key, and can be
// scripted to throw. Models subscription-mode (charge on the invoice).
function makeStripe(script = {}) {
  const calls = { cancels: [], refunds: [], keys: [] };
  return {
    calls,
    subscriptions: {
      cancel: async (id, opts) => {
        calls.cancels.push(id); calls.keys.push(opts && opts.idempotencyKey);
        if (script.cancelThrows) { const e = new Error(script.cancelThrows); e.code = script.cancelCode; throw e; }
        return { id, status: 'canceled' };
      },
      retrieve: async (id) => {
        if (script.subThrows) throw new Error(script.subThrows);
        return { id, latest_invoice: script.latestInvoice || null };
      },
    },
    invoices: {
      retrieve: async (id) => {
        if (script.invoiceThrows) throw new Error(script.invoiceThrows);
        return { id, payment_intent: script.invoicePI || null, charge: script.invoiceCharge || null };
      },
    },
    refunds: {
      create: async (payload, opts) => {
        calls.refunds.push(payload); calls.keys.push(opts && opts.idempotencyKey);
        if (script.refundThrows) { const e = new Error(script.refundThrows); e.code = script.refundCode; throw e; }
        return { id: 're_fixture_1' };
      },
    },
  };
}

const quiet = { error: () => {}, log: () => {} };
const EVENT = 'evt_test_123';

(async () => {
  // ---- RM1: the happy remedy — cancel + refund via the invoice ----
  {
    const stripe = makeStripe({ latestInvoice: 'in_1', invoicePI: 'pi_1' });
    const session = { id: 'cs_1', subscription: 'sub_1', customer: 'cus_1' };
    const r = await remedyFailedSignup({ stripe, session, eventId: EVENT, logger: quiet });
    check('RM1: subscription canceled AND the charge refunded — resolved through the subscription\'s latest_invoice (subscription-mode has no session payment_intent)',
      r.subscription === 'canceled' && r.refund === 'refunded' && r.refund_id === 're_fixture_1'
        && r.escalate === false
        && stripe.calls.cancels[0] === 'sub_1'
        && stripe.calls.refunds[0].payment_intent === 'pi_1',
      JSON.stringify({ r, calls: stripe.calls }));
  }

  // ---- RM2: idempotency keys derived from the EVENT id ----
  {
    const stripe = makeStripe({ latestInvoice: 'in_1', invoicePI: 'pi_1' });
    await remedyFailedSignup({ stripe, session: { subscription: 'sub_1' }, eventId: EVENT, logger: quiet });
    check('RM2: both mutating calls carry an idempotency key derived from the Stripe event id — a webhook REDELIVERY reuses the same refund instead of issuing a second one',
      stripe.calls.keys.length === 2
        && stripe.calls.keys[0] === 'sp4c-cancel-' + EVENT
        && stripe.calls.keys[1] === 'sp4c-refund-' + EVENT,
      JSON.stringify(stripe.calls.keys));
  }

  // ---- RM3: already-refunded / already-canceled read as SUCCESS ----
  {
    const stripe = makeStripe({
      latestInvoice: 'in_1', invoicePI: 'pi_1',
      cancelThrows: 'No such subscription: sub_1',
      refundThrows: 'Charge has already been refunded.', refundCode: 'charge_already_refunded',
    });
    const r = await remedyFailedSignup({ stripe, session: { subscription: 'sub_1' }, eventId: EVENT, logger: quiet });
    check('RM3: a second run (already canceled / already refunded) is SUCCESS, not an escalation — the redelivery path stays quiet and correct',
      r.subscription === 'already' && r.refund === 'already' && r.escalate === false,
      JSON.stringify(r));
    check('RM3b: isAlreadyDone recognizes both shapes and rejects a genuine error',
      isAlreadyDone({ code: 'charge_already_refunded' }) === true
        && isAlreadyDone({ message: 'No such subscription: sub_x' }) === true
        && isAlreadyDone({ message: 'Your card was declined' }) === false);
  }

  // ---- RM4: a REFUND FAILURE escalates loudly ----
  {
    const logs = [];
    const stripe = makeStripe({ latestInvoice: 'in_1', invoicePI: 'pi_1', refundThrows: 'insufficient funds in platform balance' });
    const r = await remedyFailedSignup({
      stripe, session: { subscription: 'sub_1' }, eventId: EVENT,
      logger: { error: (...a) => logs.push(a.join(' ')), log: () => {} },
    });
    check('RM4: a failed refund sets escalate, records the error, and logs the line that must never be quiet (customer charged with no account)',
      r.refund === 'failed' && r.escalate === true
        && r.errors.some((e) => /insufficient funds/.test(e))
        && logs.some((l) => /REFUND FAILED/.test(l) && /CHARGED WITH NO ACCOUNT/i.test(l)),
      JSON.stringify({ r, logs }));
  }

  // ---- RM5: nothing captured -> honest, not a failure ----
  {
    const stripe = makeStripe({ latestInvoice: null }); // no invoice, no PI
    const r = await remedyFailedSignup({ stripe, session: { subscription: 'sub_1' }, eventId: EVENT, logger: quiet });
    check("RM5: an 'unpaid' session with no captured charge reports nothing_to_refund (honest) — the subscription is still canceled and NO refund is attempted",
      r.subscription === 'canceled' && r.refund === 'nothing_to_refund'
        && r.escalate === false && stripe.calls.refunds.length === 0,
      JSON.stringify(r));
  }

  // ---- RM6: a session-level payment_intent short-circuits the lookup ----
  {
    const stripe = makeStripe({});
    const r = await remedyFailedSignup({
      stripe, session: { subscription: 'sub_1', payment_intent: 'pi_direct' }, eventId: EVENT, logger: quiet,
    });
    check('RM6: when the session carries a payment_intent it is refunded directly (no invoice round-trip)',
      r.refund === 'refunded' && stripe.calls.refunds[0].payment_intent === 'pi_direct');
  }

  // ---- RM7: no stripe client -> escalate, never silently keep the money ----
  {
    const r = await remedyFailedSignup({ stripe: null, session: { subscription: 'sub_1' }, eventId: EVENT, logger: quiet });
    check('RM7: a missing Stripe client degrades HONESTLY — subscription/refund both failed, escalate set (never a silent keep)',
      r.subscription === 'failed' && r.refund === 'failed' && r.escalate === true);
  }

  // ---- RM8: it never throws, even when Stripe misbehaves everywhere ----
  {
    const stripe = makeStripe({ subThrows: 'network down', cancelThrows: 'network down' });
    let threw = false, r = null;
    try {
      r = await remedyFailedSignup({ stripe, session: { subscription: 'sub_1' }, eventId: EVENT, logger: quiet });
    } catch (e) { threw = true; }
    check('RM8: the remedy never throws — a broken Stripe yields a structured escalate result, not a crashed failure handler',
      threw === false && r && r.escalate === true, JSON.stringify(r));
  }

  // ---- RM9: the customer-facing summary tells the truth per outcome ----
  {
    check('RM9: remedySummary — refunded/already says refunded+canceled; nothing_to_refund says no payment captured; failed says the team was alerted (never claims a refund that did not happen)',
      /refunded and the subscription canceled/.test(remedySummary({ refund: 'refunded' }))
        && /refunded and the subscription canceled/.test(remedySummary({ refund: 'already' }))
        && /No payment was captured/.test(remedySummary({ refund: 'nothing_to_refund' }))
        && /could not complete the automatic refund/.test(remedySummary({ refund: 'failed' })));
  }

  // ---- RM10: orchestrator wiring, source-pinned ----
  {
    const orch = fs.readFileSync(path.join(__dirname, '..', 'lib', 'signup-orchestrator.js'), 'utf8');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const catchIdx = orch.indexOf('} catch (err) {', orch.indexOf('async function processCheckoutCompletedEvent'));
    const tail = orch.slice(catchIdx);
    const rollbackFirst = tail.indexOf("client.query('ROLLBACK')") < tail.indexOf('remedyFailedSignup(');
    const stamped = tail.includes("'{_remedy}'");
    const alertNames = tail.includes('REFUND FAILED — customer charged with no account. ');
    const opTask = tail.includes('URGENT: refund a failed signup manually') && tail.includes("username = 'admin'");
    const injected = orch.includes('async function processCheckoutCompletedEvent(event, pool, stripeClient)')
      && srv.includes('processCheckoutCompletedEvent(event, pool, stripeSignup)');
    check('RM10: the failure path rolls back BEFORE the remedy, stamps _remedy for forensics, names the refund failure in the operator alert, files the operator task, and the stripe client is injected from server.js',
      rollbackFirst && stamped && alertNames && opTask && injected,
      JSON.stringify({ rollbackFirst, stamped, alertNames, opTask, injected }));
  }

  console.log(`${pass}/${pass + fail} — signup-remedy suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

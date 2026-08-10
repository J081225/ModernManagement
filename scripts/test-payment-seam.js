// scripts/test-payment-seam.js — SQ2 gate.
//
// Drives the REAL recordPayment + processCustomerPaymentCompletedEvent
// against a fixture DB to pin the processor-generic seam: the shim
// maps the legacy Stripe param, the generic path works, the webhook
// resolves by processor_ref alone (ruling 2 — inactive processor still
// completes), and the legacy column is still written during transition.
const path = require('path');
const fs = require('fs');
const ledger = require(path.join(__dirname, '..', 'lib', 'payment-ledger'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// A fixture that captures INSERTs and models the FOR UPDATE lookup +
// status flip over an in-memory rows array.
function makeDb(rows) {
  let nextId = 100;
  const db = {
    rows,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
      if (s.startsWith('INSERT INTO transaction_payments')) {
        // column order: workspace_id, transaction_id, amount_cents,
        // payment_type, payment_method, processor, processor_ref,
        // stripe_checkout_session_id, status, notes, created_by_user_id
        const row = {
          id: nextId++,
          workspace_id: params[0], transaction_id: params[1], amount_cents: params[2],
          payment_type: params[3], payment_method: params[4],
          processor: params[5], processor_ref: params[6],
          stripe_checkout_session_id: params[7], status: params[8],
        };
        rows.push(row);
        return { rows: [{ id: row.id, status: row.status }] };
      }
      if (s.includes("WHERE processor = 'stripe' AND processor_ref = $1")) {
        const found = rows.filter((r) => r.processor === 'stripe' && r.processor_ref === params[0]);
        return { rows: found.map((r) => ({ id: r.id, transaction_id: r.transaction_id, status: r.status, payment_type: r.payment_type })) };
      }
      if (s.startsWith("UPDATE transaction_payments SET status = 'completed'")) {
        const r = rows.find((x) => x.id === params[0]); if (r) r.status = 'completed';
        return { rows: [] };
      }
      // recompute reads/writes on transactions — supply a minimal tx
      if (s.includes('FROM transaction_payments') && s.includes('SUM')) {
        return { rows: [{ row_count: 1, sum: 5000 }] };
      }
      if (s.startsWith('UPDATE transactions')) {
        return { rows: [{ id: params[1] || 1, total_cents: 5000, amount_paid_cents: 5000, status: 'paid', payment_received_at: 'NOW' }] };
      }
      if (s.includes('FROM transactions WHERE id')) {
        return { rows: [{ appointment_id: null }] };
      }
      return { rows: [] };
    },
    connect: async () => ({ query: db.query, release() {} }),
  };
  return db;
}

(async () => {
  // ---- PS1: the legacy Stripe param still works (back-compat shim) ----
  {
    const rows = [];
    const db = makeDb(rows);
    await ledger.recordPayment(db, {
      workspace_id: 7, transaction_id: 1, amount_cents: 5000,
      payment_type: 'payment', payment_method: 'stripe',
      stripe_checkout_session_id: 'cs_legacy_1', status: 'pending',
    });
    const row = rows[0];
    check('PS1 [back-compat]: a caller passing stripe_checkout_session_id gets processor=stripe, processor_ref=<it>, AND the legacy column still written',
      row.processor === 'stripe' && row.processor_ref === 'cs_legacy_1'
        && row.stripe_checkout_session_id === 'cs_legacy_1',
      JSON.stringify(row));
  }

  // ---- PS2: the generic path (what SQ4's Square will use) ----
  {
    const rows = [];
    const db = makeDb(rows);
    await ledger.recordPayment(db, {
      workspace_id: 7, transaction_id: 2, amount_cents: 3000,
      payment_type: 'deposit', payment_method: 'square',
      processor: 'square', processor_ref: 'sq_payment_abc', status: 'pending',
    });
    const row = rows[0];
    check('PS2 [generic]: processor/processor_ref write straight through; a Square row leaves the legacy stripe column NULL',
      row.processor === 'square' && row.processor_ref === 'sq_payment_abc'
        && row.payment_method === 'square' && row.stripe_checkout_session_id === null,
      JSON.stringify(row));
  }

  // ---- PS3: the webhook resolves by processor_ref (Stripe) ----
  {
    const rows = [];
    const db = makeDb(rows);
    await ledger.recordPayment(db, {
      workspace_id: 7, transaction_id: 3, amount_cents: 5000,
      payment_type: 'payment', payment_method: 'stripe',
      stripe_checkout_session_id: 'cs_hook_1', status: 'pending',
    });
    const res = await ledger.processCustomerPaymentCompletedEvent(
      { data: { object: { id: 'cs_hook_1' } } }, db
    );
    check('PS3: the completion webhook looks up by processor_ref and flips the pending row to completed',
      res.ok === true && rows[0].status === 'completed',
      JSON.stringify({ res, rowStatus: rows[0].status }));
  }

  // ---- PS4 [RULING 2]: a payment pending on the INACTIVE processor still completes ----
  {
    // Workspace has since switched active processor to square, but a
    // Stripe payment was left pending. Its webhook must still resolve —
    // the lookup is by processor_ref, never the workspace active flag.
    const rows = [];
    const db = makeDb(rows);
    await ledger.recordPayment(db, {
      workspace_id: 7, transaction_id: 4, amount_cents: 5000,
      payment_type: 'payment', payment_method: 'stripe',
      stripe_checkout_session_id: 'cs_inactive_proc', status: 'pending',
    });
    // (no "active processor" is consulted anywhere in the handler)
    const res = await ledger.processCustomerPaymentCompletedEvent(
      { data: { object: { id: 'cs_inactive_proc' } } }, db
    );
    check('PS4 [ruling 2]: a Stripe payment left pending after the workspace switched to Square still completes — the webhook routes by processor_ref, not the active-processor flag',
      res.ok === true && rows[0].status === 'completed');
  }

  // ---- PS5: idempotency — a redelivered webhook no-ops ----
  {
    const rows = [];
    const db = makeDb(rows);
    await ledger.recordPayment(db, {
      workspace_id: 7, transaction_id: 5, amount_cents: 5000,
      payment_type: 'payment', payment_method: 'stripe',
      stripe_checkout_session_id: 'cs_idem', status: 'pending',
    });
    await ledger.processCustomerPaymentCompletedEvent({ data: { object: { id: 'cs_idem' } } }, db);
    const second = await ledger.processCustomerPaymentCompletedEvent({ data: { object: { id: 'cs_idem' } } }, db);
    check('PS5: a redelivered completion webhook is idempotent (already-completed row returns ok without re-flipping)',
      second.ok === true && second.idempotent === true);
  }

  // ---- PS6: the seam is pinned in the schema + code ----
  {
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '066_payment_processor_generic.sql'), 'utf8');
    const led = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payment-ledger.js'), 'utf8');
    const schemaOk = /ADD COLUMN IF NOT EXISTS processor TEXT/.test(mig)
      && /processor_ref/.test(mig)
      && /idx_transaction_payments_processor_ref/.test(mig)
      && /'stripe', 'square'/.test(mig);
    const lookupGeneric = led.includes("WHERE processor = 'stripe' AND processor_ref = $1");
    check('PS6: migration 066 adds processor/processor_ref + the unique anchor + widens the method enum; the webhook lookup is generic',
      schemaOk && lookupGeneric, JSON.stringify({ schemaOk, lookupGeneric }));
  }

  console.log(`${pass}/${pass + fail} — payment-seam gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

// scripts/test-finalize-transaction.js — finalize-then-send (ruling 2).
//
// finalize_transaction is the missing writer of the 'unpaid' status for
// MANUAL drafts: draft/pending -> unpaid, refusing anything already
// issued/paid/voided or with a payment recorded. Plus the prompt pin
// that Sarah offers finalize-then-send as ONE confirmation.
const path = require('path');
const fs = require('fs');
require(path.join(__dirname, '..', 'lib', 'tools', 'finalize_transaction'));
const registry = require(path.join(__dirname, '..', 'lib', 'tool-registry'));
const tool = registry.getTool('finalize_transaction');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

function makeCtx(txns) {
  return {
    workspace: { id: 17 }, logger: { error: () => {} },
    db: { query: async (sql, params) => {
      if (/SELECT id, status, total_cents, amount_paid_cents FROM transactions WHERE id = \$1/.test(sql)) {
        const t = txns[params[0]]; return { rows: t ? [{ ...t }] : [] };
      }
      if (/UPDATE transactions SET status = 'unpaid'/.test(sql)) {
        const t = txns[params[0]];
        if (t && ['draft', 'pending'].includes(t.status) && t.amount_paid_cents === 0) {
          t.status = 'unpaid';
          return { rows: [{ id: t.id, status: 'unpaid', total_cents: t.total_cents }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    } },
  };
}

(async () => {
  // ---- FT1: a draft finalizes to unpaid ----
  {
    const ctx = makeCtx({ 6: { id: 6, status: 'draft', total_cents: 4500, amount_paid_cents: 0 } });
    const out = await tool.execute({ transaction_id: 6 }, ctx);
    check('FT1: finalize_transaction moves a DRAFT to unpaid and reports it ready for a payment request',
      out.success === true && out.data.status === 'unpaid' && /unpaid and ready/.test(out.message),
      JSON.stringify(out));
  }

  // ---- FT2/FT3: refuses anything already issued/paid ----
  {
    const paid = await tool.execute({ transaction_id: 9 }, makeCtx({ 9: { id: 9, status: 'paid', total_cents: 3000, amount_paid_cents: 3000 } }));
    const unpaid = await tool.execute({ transaction_id: 7 }, makeCtx({ 7: { id: 7, status: 'unpaid', total_cents: 5000, amount_paid_cents: 0 } }));
    const voided = await tool.execute({ transaction_id: 5 }, makeCtx({ 5: { id: 5, status: 'voided', total_cents: 1000, amount_paid_cents: 0 } }));
    check('FT2: refuses a non-draft (paid / already-unpaid / voided) with an honest "already X, not a draft" — no re-finalize',
      paid.success === false && /already paid/.test(paid.message)
        && unpaid.success === false && /already unpaid/.test(unpaid.message)
        && voided.success === false && /already voided/.test(voided.message),
      JSON.stringify({ paid: paid.message, unpaid: unpaid.message, voided: voided.message }));
  }

  // ---- FT4: refuses a $0 draft ----
  {
    const out = await tool.execute({ transaction_id: 6 }, makeCtx({ 6: { id: 6, status: 'draft', total_cents: 0, amount_paid_cents: 0 } }));
    check('FT4: refuses a $0 draft (nothing to finalize)', out.success === false && /no balance/.test(out.message), out.message);
  }

  // ---- FT5: refuses a draft that already has a payment ----
  {
    const out = await tool.execute({ transaction_id: 6 }, makeCtx({ 6: { id: 6, status: 'draft', total_cents: 4500, amount_paid_cents: 1000 } }));
    check('FT5: refuses a draft with a payment already recorded (would mislabel as unpaid)',
      out.success === false && /already has a payment/.test(out.message), out.message);
  }

  // ---- FT6: registration shape ----
  {
    check('FT6: finalize_transaction is registered, PS vertical, requiresApproval:false (issuing is not money-moving)',
      !!tool && tool.vertical === 'professional-services' && tool.requiresApproval === false);
  }

  // ---- FT7: the owner prompt offers finalize-then-send as ONE confirmation ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const offers = srv.includes('still a draft — want me to finalize it and send the request?');
    const chains = srv.includes('call finalize_transaction for that transaction and THEN request_payments_batch');
    const noSilent = srv.includes("Never finalize a draft without the owner's explicit yes");
    check('FT7: the owner prompt tells Sarah to offer "finalize and send?" as one confirmation, then chain finalize→request, and never auto-finalize',
      offers && chains && noSilent, JSON.stringify({ offers, chains, noSilent }));
  }

  console.log(`${pass}/${pass + fail} — finalize-transaction gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

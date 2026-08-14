// scripts/test-batch-skip.js — honest payment-request skip reasons +
// pre-queue read-back (batch-skip findings, ruling 1).
//
// Drives the REAL request_payments_batch: a draft is 'not_finalized'
// (never the misleading 'already_settled'/"already paid"); an all-
// unsendable batch is refused BEFORE queuing so the assistant reads
// back an honest reason instead of a phantom "queued." Source-pins the
// engine's pre-queue hook.
const path = require('path');
const fs = require('fs');
require(path.join(__dirname, '..', 'lib', 'tools', 'request_payments_batch'));
const registry = require(path.join(__dirname, '..', 'lib', 'tool-registry'));
const tool = registry.getTool('request_payments_batch');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const TXNS = {
  6: { id: 6, status: 'draft', total_cents: 4500, amount_paid_cents: 0 },
  7: { id: 7, status: 'unpaid', total_cents: 5000, amount_paid_cents: 0 },
  8: { id: 8, status: 'paid', total_cents: 3000, amount_paid_cents: 3000 },
};
const ctx = {
  workspace: { id: 17 }, user: { id: 14 }, env: {}, stripe: null, sms: null,
  logger: { error: () => {}, log: () => {} },
  db: { query: async (sql, params) => {
    if (/FROM transactions\s+WHERE id = \$1/.test(sql)) {
      const t = TXNS[params[0]]; return { rows: t ? [t] : [] };
    }
    return { rows: [] };
  } },
};
const req = (id) => ({ requests: [{ transaction_id: id, customer_name: 'Sarah Chen' }] });

(async () => {
  // ---- BK1: a draft is 'not_finalized', never 'already_settled' ----
  {
    const out = await tool.execute(req(6), ctx);
    const sk = out.data.skipped[0];
    check('BK1: request_payments_batch skips a DRAFT with reason "not_finalized" (draft ≠ settled) — never the misleading already_settled',
      sk && sk.reason === 'not_finalized' && sk.status === 'draft'
        && out.data.sent.length === 0, JSON.stringify(sk));
  }

  // ---- BK2: the read-back message says "still a draft", not "already paid" ----
  {
    const out = await tool.execute(req(6), ctx);
    check('BK2: the batch summary reads "Sent 0 payment requests; skipped 1 (still a draft)" — honest, never "already paid" for a draft',
      out.message === 'Sent 0 payment requests; skipped 1 (still a draft).', out.message);
  }

  // ---- BK3: a genuinely paid txn is still 'already_settled' ----
  {
    const out = await tool.execute(req(8), ctx);
    const sk = out.data.skipped[0];
    check('BK3: a genuinely paid transaction keeps reason "already_settled" — the two are distinguished, not merged',
      sk && sk.reason === 'already_settled' && out.message.includes('(already paid)'),
      JSON.stringify(sk) + ' | ' + out.message);
  }

  // ---- BK4: pre-queue refuses an all-draft batch (read-back, not queued) ----
  {
    const pre = await tool.validateBeforeQueue(req(6), ctx);
    check('BK4: validateBeforeQueue REFUSES an all-draft batch (ok:false), success:false, names the draft, and states nothing was queued — the assistant reads this back',
      pre.ok === false && pre.result.success === false
        && /not finalized|draft/i.test(pre.result.message)
        && /nothing was sent or queued/i.test(pre.result.message)
        && pre.result.data.not_finalized.includes(6),
      JSON.stringify(pre));
  }

  // ---- BK5: pre-queue ALLOWS a batch with at least one sendable row ----
  {
    const sendable = await tool.validateBeforeQueue(req(7), ctx);          // unpaid → sendable
    const mixed = await tool.validateBeforeQueue({ requests: [
      { transaction_id: 6, customer_name: 'A' }, { transaction_id: 7, customer_name: 'B' },
    ] }, ctx);
    const allPaid = await tool.validateBeforeQueue(req(8), ctx);            // paid → refuse
    check('BK5: validateBeforeQueue allows (ok:true) when ≥1 row is sendable (incl. mixed draft+unpaid) and refuses an all-settled batch',
      sendable.ok === true && mixed.ok === true && allPaid.ok === false,
      JSON.stringify({ sendable: sendable.ok, mixed: mixed.ok, allPaid: allPaid.ok }));
  }

  // ---- BK6: the engine runs the pre-queue gate BEFORE writing the queue ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const block = srv.slice(srv.indexOf('if (tool.requiresApproval) {'), srv.indexOf('INSERT INTO pending_actions (workspace_id, user_id, tool_name'));
    const gates = block.includes("typeof tool.validateBeforeQueue === 'function'")
      && /pre\.ok === false[\s\S]{0,120}continue;/.test(block);
    check('BK6: the engine calls tool.validateBeforeQueue and, on ok:false, returns the honest result and CONTINUES without inserting a pending_actions row',
      gates, JSON.stringify({ gates }));
  }

  console.log(`${pass}/${pass + fail} — batch-skip gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

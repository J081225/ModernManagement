// scripts/test-approval-copy.js — approval honesty (ruling 3).
//
// STRUCTURAL: the owner-assistant has NO tool to approve a queued
// action (approval is the owner's tap in the Pending Approvals card),
// and its copy never offers to approve or promises delivery it can't
// verify. See the no-self-approve-law memory / the refund gate.
const path = require('path');
const fs = require('fs');
require(path.join(__dirname, '..', 'lib', 'tools')); // load every tool
const registry = require(path.join(__dirname, '..', 'lib', 'tool-registry'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

(async () => {
  // ---- AC1: NO self-approve tool exists (structural, not prompt-level) ----
  {
    const all = registry.getAllTools();
    const approveTools = all.filter(t => /approv/i.test(t.name));
    const noApproveTool = approveTools.length === 0 && !registry.getTool('approve_pending_action');
    check('AC1: no registered tool approves a queued action (no approve_pending_action / *approve* tool) — the gate is structural, like the refund gate',
      noApproveTool, JSON.stringify(approveTools.map(t => t.name)));
  }

  // ---- AC2: approval flows ONLY through the human-owner endpoint ----
  {
    const humanEndpoint = srv.includes("app.post('/api/pending-actions/:id/approve', requireAuth");
    check('AC2: approval executes only via POST /api/pending-actions/:id/approve (requireAuth — the human owner)', humanEndpoint);
  }

  // ---- AC3: the assistant never offers to approve; points to the card ----
  {
    const cantApprove = srv.includes('You CANNOT approve a queued request yourself');
    const neverOffer = srv.includes('Never offer to approve');
    const pointsToCard = srv.includes("it's their tap in the Pending Approvals card");
    check('AC3: the owner prompt says the assistant cannot approve, must never offer to, and points the owner to the Pending Approvals card',
      cantApprove && neverOffer && pointsToCard, JSON.stringify({ cantApprove, neverOffer, pointsToCard }));
  }

  // ---- AC4: no delivery overclaim (the msg-172 fix) ----
  {
    const noPromise = srv.includes("Never promise delivery you can't verify");
    const onlyAfter = srv.includes('go out only AFTER the owner approves and a live balance re-check passes');
    const noCopyableLink = srv.includes('does not hand you a copyable link');
    check('AC4: the prompt forbids promising delivery it can\'t verify — link/SMS only go out post-approval; it does not hand the owner a copyable link',
      noPromise && onlyAfter && noCopyableLink, JSON.stringify({ noPromise, onlyAfter, noCopyableLink }));
  }

  console.log(`${pass}/${pass + fail} — approval-copy gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

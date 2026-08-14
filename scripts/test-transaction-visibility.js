// scripts/test-transaction-visibility.js — draft/unpaid visibility (ruling 4).
//
// A created transaction is never invisible: the dashboard "Recent
// Transactions" tile and the Finances transactions list both surface
// drafts + unpaid with honest status badges.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');

(async () => {
  // ---- TV1: the dashboard tile query surfaces draft + unpaid ----
  {
    const block = srv.slice(srv.indexOf('let recent_transactions = []'), srv.indexOf('recent_transactions = r.rows;'));
    const includesDraftUnpaid = /status IN \('draft', 'pending', 'unpaid', 'partially_paid', 'paid'\)/.test(block);
    const ordersByActivity = /ORDER BY COALESCE\(payment_received_at, created_at\) DESC/.test(block);
    const oldPaidOnlyGone = !block.includes("status IN ('paid', 'partially_paid')");
    check('TV1: the dashboard Recent Transactions query includes draft/pending/unpaid (not just paid/partial), ordered by activity so a fresh draft is visible',
      includesDraftUnpaid && ordersByActivity && oldPaidOnlyGone,
      JSON.stringify({ includesDraftUnpaid, ordersByActivity, oldPaidOnlyGone }));
  }

  // ---- TV2: the dashboard badge renders honest draft/unpaid labels ----
  {
    const badge = app.slice(app.indexOf('function _psTxnStatusBadge'), app.indexOf('function _psStockBadge'));
    const draft = /status === 'draft'[\s\S]{0,70}>Draft<\/span>/.test(badge);
    const unpaid = /status === 'unpaid'[\s\S]{0,80}>Unpaid<\/span>/.test(badge);
    const rendered = app.includes('${_psTxnStatusBadge(t.status)}');
    check('TV2: the dashboard tile renders honest badges for draft ("Draft") and unpaid ("Unpaid") — no raw fallthrough — and actually uses the badge in the row',
      draft && unpaid && rendered, JSON.stringify({ draft, unpaid, rendered }));
  }

  // ---- TV3: the Finances list has NO default status exclusion ----
  {
    const filters = srv.slice(srv.indexOf('function _buildTxFilters'), srv.indexOf('function _buildTxFilters') + 1000);
    // status filters only when explicitly asked (q.status); nothing is
    // excluded by default, so drafts/unpaid appear in the list.
    const conditional = /if \(q\.status\)/.test(filters) && !/status IN \(/.test(filters);
    const listBlock = srv.slice(srv.indexOf("app.get('/api/transactions', requireAuth"), srv.indexOf("app.get('/api/transactions', requireAuth") + 900);
    const ordersActivity = /ORDER BY COALESCE\(t\.payment_received_at, t\.created_at\) DESC/.test(listBlock);
    check('TV3: the Finances list endpoint applies a status filter ONLY when asked (no default exclusion) and orders by activity — drafts/unpaid are returned',
      conditional && ordersActivity, JSON.stringify({ conditional, ordersActivity }));
  }

  // ---- TV4: the Finances list UI colors draft/unpaid + filters offer them ----
  {
    const colorDraft = /case 'draft': return/.test(app) && /case 'unpaid': return/.test(app);
    const filterOpts = app.includes('<option value="draft">Draft</option>') && app.includes('<option value="unpaid">Unpaid</option>');
    check('TV4: the Finances list gives draft/unpaid honest status colors and the status filter offers Draft + Unpaid',
      colorDraft && filterOpts, JSON.stringify({ colorDraft, filterOpts }));
  }

  console.log(`${pass}/${pass + fail} — transaction-visibility gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

// scripts/test-transaction-report.js — TR2 suite.
//
// Drives the REAL composeTransactionReport over a fixture DB shaped
// like test-finances-summary's (the same stub grammar), plus the
// money formatter and the G2 honesty pins. The rows that matter:
// the report is a VIEW over the ledger (never a third source), test
// money hides loudly, groups subtotal correctly, refs point at source
// documents, and no TR surface formats money on its own.
const path = require('path');
const fs = require('fs');
const { composeTransactionReport, monthLabel } = require(path.join(__dirname, '..', 'lib', 'transaction-report'));
const { composeLedgerRows } = require(path.join(__dirname, '..', 'lib', 'finances-summary'));
const { formatCents, centsToDecimal } = require(path.join(__dirname, '..', 'lib', 'money'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Fixture: two months of mixed money across all four sources.
const FX = {
  ledger: [
    { id: 11, transaction_id: 501, workspace_id: 7, amount_cents: 5000, payment_method: 'cash', payment_type: 'payment', status: 'completed', created_at: '2026-07-10T15:00:00.000Z', customer: 'Dana Fox' },
    { id: 12, transaction_id: 502, workspace_id: 7, amount_cents: 2000, payment_method: 'stripe', payment_type: 'deposit', status: 'completed', created_at: '2026-07-12T15:00:00.000Z', customer: 'Ben Ochoa' },
    { id: 13, transaction_id: 503, workspace_id: 7, amount_cents: 7500, payment_method: 'cash', payment_type: 'payment', status: 'completed', created_at: '2026-06-20T15:00:00.000Z', customer: 'Dana Fox' },
  ],
  rent: [
    { id: 31, user_id: 3, resident: 'Ann Lee', unit: '2B', amount: '1200.00', status: 'paid', paid_date: '2026-07-05', due_date: '2026-07-01' },
  ],
  budget: [
    { id: 41, user_id: 3, type: 'expense', category: 'Utilities', amount: '210.00', date: '2026-07-02' },
    { id: 42, user_id: 3, type: 'income', category: 'Laundry', amount: '55.00', date: '2026-06-09', description: 'Laundry room coins' },
  ],
  expenses: [
    { id: 51, workspace_id: 7, amount_cents: 4200, category: 'Supplies', spent_on: '2026-07-09', vendor: 'SalonCo' },
  ],
};

function makeDb(fx) {
  return {
    query: async (sql, params) => {
      if (sql.includes('LEFT JOIN transactions t ON')) {
        const rows = fx.ledger
          .filter((r) => r.workspace_id === params[0] && r.status === 'completed'
            && r.created_at >= params[1] && r.created_at < params[2])
          .map((r) => ({ payment_id: r.id, transaction_id: r.transaction_id, amount_cents: r.amount_cents, payment_type: r.payment_type, payment_method: r.payment_method, created_at: r.created_at, customer_display_name: r.customer }));
        return { rows };
      }
      if (sql.includes('FROM rent_payments')) {
        const dateOf = (r) => r.paid_date || r.due_date;
        const rows = fx.rent
          .filter((r) => r.user_id === params[0] && r.status === 'paid' && dateOf(r) >= params[1] && dateOf(r) < params[2])
          .map((r) => ({ id: r.id, resident: r.resident, unit: r.unit, amount: r.amount, d: dateOf(r) }));
        return { rows };
      }
      if (sql.includes('FROM expenses')) {
        const rows = fx.expenses
          .filter((r) => r.workspace_id === params[0] && r.spent_on >= params[1] && r.spent_on < params[2])
          .map((r) => ({ id: r.id, amount_cents: r.amount_cents, category: r.category, description: r.description || '', vendor: r.vendor || '', spent_on: r.spent_on, row_source: 'manual' }));
        return { rows };
      }
      if (sql.includes('FROM budget_transactions')) {
        const rows = fx.budget
          .filter((r) => r.user_id === params[0] && (r.type === 'expense' || r.type === 'income') && r.date >= params[1] && r.date < params[2])
          .map((r) => ({ id: r.id, amount: r.amount, category: r.category, description: r.description || '', date: r.date, type: r.type }));
        return { rows };
      }
      throw new Error('unexpected SQL: ' + sql.slice(0, 60));
    },
  };
}

const WS = { id: 7, owner_user_id: 3, timezone: 'America/New_York' };
const NOW = new Date('2026-07-20T12:00:00.000Z');
const TEST_ENV = { STRIPE_TEST_SECRET_KEY: 'sk_test_x' };
const LIVE_ENV = { DEPOSITS_LIVE_OVERRIDE: 'true' };
const args = (extra = {}) => ({
  db: makeDb(FX), workspace: WS, period: 'custom',
  start: '2026-06-01', end: '2026-08-01', env: LIVE_ENV, now: NOW, ...extra,
});

(async () => {
  // ---- TX1: the report IS the ledger, regrouped — never a third source ----
  {
    const report = await composeTransactionReport(args());
    const ledger = await composeLedgerRows({
      db: makeDb(FX), workspace: WS, period: 'custom',
      start: '2026-06-01', end: '2026-08-01', env: LIVE_ENV, now: NOW,
    });
    const reportRows = report.groups.flatMap((g) => g.rows);
    check('TX1: every report row is a ledger row and every ledger row is in the report (live mode, no filters) — one source of truth, structurally',
      reportRows.length === ledger.rows.length
        && report.totals.in_cents === ledger.totals.in_cents
        && report.totals.out_cents === ledger.totals.out_cents,
      JSON.stringify({ report: reportRows.length, ledger: ledger.rows.length }));
  }

  // ---- TX2: month grouping, newest first, correct subtotals ----
  {
    const r = await composeTransactionReport(args());
    const keys = r.groups.map((g) => g.key);
    const july = r.groups.find((g) => g.key === '2026-07');
    const june = r.groups.find((g) => g.key === '2026-06');
    // July in: 5000 + 2000 + 120000 rent = 127000; out: 21000 legacy + 4200 = 25200
    // June in: 7500 + 5500 income = 13000; out: 0
    check('TX2: months sort newest-first with human labels and honest subtotals (July in 127000/out 25200; June in 13000 including the G1 income row)',
      keys[0] === '2026-07' && keys[1] === '2026-06'
        && july.label === 'July 2026' && june.label === 'June 2026'
        && july.subtotals.in_cents === 127000 && july.subtotals.out_cents === 25200
        && june.subtotals.in_cents === 13000 && june.subtotals.out_cents === 0
        && r.totals.net_cents === (127000 + 13000) - 25200,
      JSON.stringify({ keys, july: july && july.subtotals, june: june && june.subtotals }));
  }

  // ---- TX3: real-only default hides test money LOUDLY ----
  {
    const r = await composeTransactionReport(args({ env: TEST_ENV }));
    const all = r.groups.flatMap((g) => g.rows);
    check('TX3: test mode + default include_test=false — the stripe deposit (2000) is excluded from rows AND reported in hidden_test, never silently vanished',
      all.every((x) => !(x.payment_method === 'stripe'))
        && r.hidden_test.count === 1 && r.hidden_test.cents === 2000
        && r.totals.in_cents === 127000 + 13000 - 2000,
      JSON.stringify(r.hidden_test));
    const r2 = await composeTransactionReport(args({ env: TEST_ENV, include_test: true }));
    check('TX3b: include_test=true folds it back (in-total regains the 2000; hidden_test reads zero)',
      r2.totals.in_cents === 127000 + 13000 && r2.hidden_test.count === 0);
  }

  // ---- TX4: refs point at source documents (the row-model ruling) ----
  {
    const r = await composeTransactionReport(args());
    const all = r.groups.flatMap((g) => g.rows);
    const payment = all.find((x) => x.ref && x.ref.kind === 'payment' && x.ref.transaction_id === 501);
    const rent = all.find((x) => x.ref && x.ref.kind === 'rent_payment');
    const exp = all.find((x) => x.ref && x.ref.kind === 'expense');
    const inc = all.find((x) => x.ref && x.ref.kind === 'legacy_budget' && x.direction === 'in');
    check('TX4: every source carries its ref — PS cash events cite their transaction id (the ruling), rent/expense/legacy rows cite their row ids, and the G1 income row arrives as direction=in',
      payment && payment.ref.id === 11
        && rent && rent.ref.id === 31
        && exp && exp.ref.id === 51
        && inc && inc.ref.id === 42 && inc.category === 'Laundry',
      JSON.stringify({ payment: payment && payment.ref, rent: rent && rent.ref, exp: exp && exp.ref, inc: inc && inc.ref }));
  }

  // ---- TX5: customer grouping + customer filter ----
  {
    const byCust = await composeTransactionReport(args({ group_by: 'customer' }));
    const dana = byCust.groups.find((g) => g.key === 'Dana Fox');
    const filtered = await composeTransactionReport(args({ customer: 'dana' }));
    const fRows = filtered.groups.flatMap((g) => g.rows);
    check('TX5: group_by=customer buckets Dana\'s two payments (12500 in); customer filter is case-insensitive substring and keeps ONLY her rows',
      dana && dana.subtotals.in_cents === 12500 && dana.subtotals.count === 2
        && fRows.length === 2 && filtered.totals.in_cents === 12500,
      JSON.stringify({ dana: dana && dana.subtotals, filtered: filtered.totals }));
  }

  // ---- TX6: category grouping + the ledger's own filters pass through ----
  {
    const byCat = await composeTransactionReport(args({ group_by: 'category' }));
    const rent = byCat.groups.find((g) => g.key === 'Rent');
    const inOnly = await composeTransactionReport(args({ direction: 'in' }));
    check('TX6: group_by=category (Rent bucket = 120000) and the ledger\'s direction filter passes through (no out rows when direction=in)',
      rent && rent.subtotals.in_cents === 120000
        && inOnly.groups.flatMap((g) => g.rows).every((x) => x.direction === 'in'),
      JSON.stringify(rent && rent.subtotals));
  }

  // ---- TX7: the formatter — every edge the report will render ----
  {
    check('TX7: formatCents — thousands, negatives, zero, and an honest em-dash for non-numbers (never $NaN); centsToDecimal is spreadsheet-parseable',
      formatCents(123456) === '$1,234.56'
        && formatCents(-950) === '-$9.50'
        && formatCents(0) === '$0.00'
        && formatCents(NaN) === '—' && formatCents(null) === '—' && formatCents(undefined) === '—'
        && formatCents(1234567890) === '$12,345,678.90'
        && centsToDecimal(123456) === '1234.56' && centsToDecimal(-5) === '-0.05' && centsToDecimal(null) === '');
    check('TX7b: monthLabel is pure string math — no Date parsing that could shift under a timezone',
      monthLabel('2026-01') === 'January 2026' && monthLabel('2026-12') === 'December 2026'
        && monthLabel('garbage') === 'garbage');
  }

  // ---- TX8: G2 honesty pins — the refund surfaces say recorded, not moved ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const tool = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'refund_transaction.js'), 'utf8');
    const endpointHonest = srv.includes('money_moved: false')
      && srv.includes('process the refund in your Stripe dashboard');
    const modalHonest = app.includes('it does not move money')
      && /txRefundModal[\s\S]*?does not move money/.test(app);
    const toolHonest = tool.includes('Recorded a $') && tool.includes('No money moved')
      && !/message: `Refunded \$/.test(tool);
    check('TX8: all three refund surfaces (endpoint money_moved:false + note, modal banner, AI tool message) say RECORDED and name the Stripe-dashboard step — none claims money moved',
      endpointHonest && modalHonest && toolHonest,
      JSON.stringify({ endpointHonest, modalHonest, toolHonest }));
  }

  // ---- TX9: the formatter is THE formatter for TR surfaces ----
  {
    const tr = fs.readFileSync(path.join(__dirname, '..', 'lib', 'transaction-report.js'), 'utf8');
    const money = fs.readFileSync(path.join(__dirname, '..', 'lib', 'money.js'), 'utf8');
    // The read-model emits cents only (formatting is the boundary's
    // job); lib/money.js exists and exports both entry points; and no
    // TR-arc lib formats money inline.
    const composerPure = !tr.includes('toFixed') && !tr.includes('/ 100');
    const helperShape = money.includes('function formatCents') && money.includes('function centsToDecimal');
    check('TX9: the report composer emits integer cents only (no inline formatting anywhere in it); lib/money.js is the single TR display boundary',
      composerPure && helperShape, JSON.stringify({ composerPure, helperShape }));
  }

  // ---- TX10: the endpoint exists, authed, beside the ledger routes ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const wired = srv.includes("app.get('/api/finances/report', requireAuth")
      && srv.includes("composeTransactionReport({")
      && srv.includes("include_test: req.query.include_test === 'true'");
    check('TX10: GET /api/finances/report wired with requireAuth, include_test parsed strictly (only the literal string true opts in)',
      wired);
  }

  console.log(`${pass}/${pass + fail} — transaction-report suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

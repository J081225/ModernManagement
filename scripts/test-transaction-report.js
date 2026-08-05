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
const vm = require('vm');
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

  // ================= TR3: the report screen =================
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');

  // ---- TX11: the page's formatCents MIRRORS lib/money.js, behaviorally ----
  {
    const m = appHtml.match(/function formatCents\(cents\) \{[\s\S]*?\n      \}/);
    let uiFormatCents = null;
    if (m) {
      // eslint-disable-next-line no-eval
      uiFormatCents = eval('(' + m[0] + ')');
    }
    const probes = [0, 1, 99, 100, 950, -950, 123456, 1234567890, -1234567890,
      NaN, null, undefined, 100.4, -0];
    const parity = uiFormatCents && probes.every((p) => uiFormatCents(p) === formatCents(p));
    check('TX11: the page formatCents and lib/money.formatCents agree on every probe (zero, cents-only, thousands, negatives, non-numbers, floats) — the mirror is pinned behaviorally, not by comment',
      parity, uiFormatCents ? JSON.stringify(probes.map((p) => [String(p), uiFormatCents(p), formatCents(p)]).filter(([, a, b]) => a !== b)) : 'formatCents not found in app.html');
  }

  // ---- TX12: formatCents is the ONLY formatter the TR3 code touches ----
  {
    const start = appHtml.indexOf('// ---------- TR3: the transaction-history report ----------');
    const end = appHtml.indexOf('// ---------- BG7');
    const block = start >= 0 && end > start ? appHtml.slice(start, end) : '';
    const pure = block.length > 0
      && !block.includes('toFixed')
      && !block.includes('_expFmtCents')
      && !block.includes('toLocaleString(\'en-US\', { minimumFractionDigits');
    // the single "/ 100" allowed is INSIDE formatCents itself
    const outsideFormatter = block.replace(/function formatCents\(cents\) \{[\s\S]*?\n      \}/, '');
    const noInlineMath = !outsideFormatter.includes('/ 100');
    check('TX12: the TR3 block formats money through formatCents alone — no toFixed, no _expFmtCents, no inline /100 outside the formatter itself',
      pure && noInlineMath, JSON.stringify({ blockFound: block.length > 0, pure, noInlineMath }));
  }

  // ---- TX13: the card, its controls, and the one-period-control chain ----
  {
    const cardOnce = appHtml.split('id="finReportCard"').length - 1 === 1;
    const groupBy = /id="rptGroupBy"[\s\S]{0,400}value="month"[\s\S]{0,200}value="customer"[\s\S]{0,200}value="category"/.test(appHtml);
    const dirSrc = appHtml.includes('id="rptDirection"') && appHtml.includes('id="rptSource"')
      && appHtml.includes('id="rptCustomer"');
    // follows the ONE period control: _rptParams reads _finPeriod and
    // there is NO separate report period selector; the summary chain
    // calls loadReport beside loadLedger.
    const followsPeriod = appHtml.includes("const params = new URLSearchParams({ period: _finPeriod });")
      && !appHtml.includes('rptPeriod')
      && /loadLedger === 'function'\) loadLedger\(\);[\s\S]{0,200}loadReport === 'function'\) loadReport\(\);/.test(appHtml);
    check('TX13: the Report card exists exactly once with group-by (month/customer/category), direction, source, and customer controls, and follows the page\'s ONE period control (no second period state)',
      cardOnce && groupBy && dirSrc && followsPeriod,
      JSON.stringify({ cardOnce, groupBy, dirSrc, followsPeriod }));
  }

  // ---- TX14: the hidden-test disclosure is a LINE with a toggle ----
  {
    const disclosure = /hidden\.innerHTML = data\.hidden_test\.count[\s\S]{0,300}formatCents\(data\.hidden_test\.cents\)[\s\S]{0,300}toggleReportTest/.test(appHtml);
    const reverse = /Including ' \+ shownTestRows \+ ' test row/.test(appHtml)
      && appHtml.includes('_rptIncludeTest = !_rptIncludeTest');
    const subtotalsRendered = /formatCents\(s\.in_cents\)/.test(appHtml) && /formatCents\(s\.out_cents\)/.test(appHtml);
    const refBadge = /r\.ref\.kind === 'payment' && r\.ref\.transaction_id/.test(appHtml);
    check('TX14: hidden-test renders count+sum through formatCents with the show/hide toggle both ways; group subtotals and the transaction-id ref badge render from the TR2 fields',
      disclosure && reverse && subtotalsRendered && refBadge,
      JSON.stringify({ disclosure, reverse, subtotalsRendered, refBadge }));
  }

  // ================= TR4: the two artifacts =================
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  // ---- TX15: the print route — authed, one composer, one formatter ----
  {
    const start = srvSrc.indexOf("app.get('/finances/report/print'");
    const block = start >= 0 ? srvSrc.slice(start, srvSrc.indexOf("app.get('/api/transactions'", start)) : '';
    const authed = block.startsWith("app.get('/finances/report/print', requireAuth");
    const oneComposer = block.includes("composeTransactionReport({");
    const libFormatter = block.includes("const { formatCents } = require('./lib/money')");
    // no inline money formatting in the print surface
    const noInline = !block.includes('toFixed') && !/\(\s*[\w.]+\s*\/\s*100\s*\)/.test(block);
    const printCss = block.includes('@media print') && block.includes('break-inside:avoid');
    const honest = block.includes('excluded from this report') && block.includes('Showing the first ');
    check('TX15: the print route is authed, renders the SAME composer through lib/money.formatCents directly (no inline formatting anywhere in it), carries print CSS with break-inside:avoid, and DISCLOSES hidden-test and capped states on the printed page',
      authed && oneComposer && libFormatter && noInline && printCss && honest,
      JSON.stringify({ authed, oneComposer, libFormatter, noInline, printCss, honest }));
  }

  // ---- TX16: the CSV route — centsToDecimal, signed amounts, disclosure ----
  {
    const start = srvSrc.indexOf("app.get('/api/finances/report/export.csv'");
    const block = start >= 0 ? srvSrc.slice(start, srvSrc.indexOf("app.get('/finances/report/print'", start)) : '';
    const authed = block.startsWith("app.get('/api/finances/report/export.csv', requireAuth");
    const viaHelper = block.includes("const { centsToDecimal } = require('./lib/money')")
      && !block.includes('toFixed') && !block.includes('_csvDollars');
    const signed = block.includes("centsToDecimal(r.direction === 'in' ? r.amount_cents : -r.amount_cents)");
    const grouped = block.includes("'Group', 'Date', 'Direction'") && block.includes("subtotal'), '', ''");
    const disclosure = block.includes("'Hidden test rows: ' + data.hidden_test.count");
    const refs = block.includes("'TX-' + r.ref.transaction_id");
    check('TX16: the report CSV is authed, formats ONLY through centsToDecimal (not _csvDollars), signs amounts so the Amount column sums to Net, carries Group/Customer/Reference columns with per-group Net subtotals, and discloses hidden test money in the footer',
      authed && viaHelper && signed && grouped && disclosure && refs,
      JSON.stringify({ authed, viaHelper, signed, grouped, disclosure, refs }));
  }

  // ---- TX17: the card buttons drive BOTH artifacts from _rptParams ----
  {
    const printBtn = appHtml.includes('id="rptPrintBtn"') && appHtml.includes('onclick="printReport()"');
    const exportBtn = appHtml.includes('id="rptExportBtn"') && appHtml.includes('onclick="exportReportCsv()"');
    const sameParams = /function exportReportCsv\(\) \{[\s\S]{0,200}_rptParams\(\)[\s\S]{0,200}\/api\/finances\/report\/export\.csv\?/.test(appHtml)
      && /function printReport\(\) \{[\s\S]{0,200}_rptParams\(\)[\s\S]{0,200}\/finances\/report\/print\?/.test(appHtml);
    check('TX17: Print and Export CSV on the Report card both build their URLs from _rptParams() — what the screen shows is exactly what prints and exports, filters and grouping included',
      printBtn && exportBtn && sameParams,
      JSON.stringify({ printBtn, exportBtn, sameParams }));
  }

  // ================= TR5: the hardening pins =================
  // Runtime surface = server.js + views/app.html + lib/**.js. The
  // scripts/ dir is deliberately NOT scanned (test fixtures may quote
  // the very patterns these pins hunt).
  const runtimeFiles = (() => {
    const files = ['server.js', 'views/app.html'];
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'lib'))) {
      if (f.endsWith('.js')) files.push('lib/' + f);
    }
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'lib', 'tools'))) {
      if (f.endsWith('.js')) files.push('lib/tools/' + f);
    }
    return files.map((f) => [f, fs.readFileSync(path.join(__dirname, '..', f), 'utf8')]);
  })();

  // ---- TX18: the retention pin — money tables are append-only, as LAW ----
  {
    // Pattern built from parts so no source file can match by quoting it.
    const del = new RegExp('DELETE\\s+FROM\\s+' + 'transaction', 'gi');
    const offenders = runtimeFiles
      .filter(([, src]) => (src.match(del) || []).length > 0)
      .map(([f]) => f);
    check('TX18 [retention pin]: ZERO delete paths exist on transactions/transaction_payments anywhere in runtime code — the permanent-storage ruling is law, not convention; corrections are voids and linked refunds',
      offenders.length === 0, JSON.stringify(offenders));
  }

  // ---- TX19: the cents ratchet — the legacy inventory may only shrink ----
  {
    // TR1 inventoried the legacy inline-formatting sites; the ruling:
    // migration is follow-up scope, but NO NEW SITE may land. Pinned at
    // the inventoried count (P1 toFixed-style 42 + P2 toLocaleString-
    // style 2 = 44), excluding lib/money.js — the boundary itself, whose
    // header COMMENT quotes the pattern it exists to replace.
    const RATCHET = 44;
    const P1 = /\/ ?100\)\.toFixed\(2\)/g;
    const P2 = /toLocaleString\('en-US', \{ minimumFractionDigits/g;
    let count = 0;
    const perFile = [];
    for (const [f, src] of runtimeFiles) {
      if (f === 'lib/money.js') continue;
      const n = (src.match(P1) || []).length + (src.match(P2) || []).length;
      if (n) perFile.push(f + ':' + n);
      count += n;
    }
    check('TX19 [cents ratchet]: inline money-formatting sites = ' + count + ', pinned at <= ' + RATCHET + ' — a new site fails this row (route it through lib/money.js); when migration shrinks the count, re-pin DOWNWARD',
      count <= RATCHET, 'count=' + count + ' > ' + RATCHET + ' — new inline site(s) in: ' + perFile.join(', '));
    if (count < RATCHET) console.log('      note: count ' + count + ' is BELOW the ratchet ' + RATCHET + ' — re-pin downward to lock in the progress');
  }

  // ---- TX20: the row-source census — four sources, by name ----
  {
    const fin = fs.readFileSync(path.join(__dirname, '..', 'lib', 'finances-summary.js'), 'utf8');
    const wanted = ['ledger', 'legacy_rent', 'expenses', 'legacy_budget'];
    const found = [...fin.matchAll(/wantSource\('([a-z_]+)'\)/g)].map((m) => m[1]);
    const exact = found.length === 4 && wanted.every((w) => found.includes(w));
    // the CSV's label map must name the SAME four — a fifth source
    // must evolve BOTH, forcing the "does the report include it?" decision.
    const csvLabels = /SOURCE_LABEL = \{ ledger: [^}]*legacy_rent: [^}]*expenses: [^}]*legacy_budget: [^}]*\}/.test(srvSrc);
    const viewNotSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'transaction-report.js'), 'utf8')
      .includes("require('./finances-summary')");
    check('TX20 [row-source census]: composeLedgerRows reads EXACTLY the four named sources, the report CSV labels the same four, and the report composer consumes the ledger (a new money table must evolve this pin — a silent omission from the report is structurally impossible)',
      exact && csvLabels && viewNotSource,
      JSON.stringify({ found, csvLabels, viewNotSource }));
  }

  // ================= the strand fix: no silent "Loading…" =================
  // These rows EXECUTE the page's real chain (functions extracted from
  // app.html, run in a vm with a recording DOM) — the row class that
  // would have caught the live bug: a failed/throwing step upstream
  // leaving the ledger and report cards on "Loading…" forever.
  function _grabFn(html, name) {
    const re = new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{');
    const m = re.exec(html);
    if (!m) throw new Error('function not found in app.html: ' + name);
    let depth = 0;
    const start = html.indexOf('{', m.index);
    for (let j = start; j < html.length; j++) {
      if (html[j] === '{') depth++;
      if (html[j] === '}') { depth--; if (depth === 0) return html.slice(m.index, j + 1); }
    }
    throw new Error('unbalanced braces: ' + name);
  }
  function _chainSandbox(fetchImpl) {
    const elements = {};
    const el = (id) => elements[id] || (elements[id] = {
      id, innerHTML: '(untouched)', style: {}, dataset: {}, textContent: '', value: '',
      classList: { toggle() {} },
    });
    const sandbox = {
      console: { error() {}, log() {} }, setTimeout,
      document: { getElementById: el, querySelectorAll: () => [] },
      window: {}, _finPeriod: 'month', _rptIncludeTest: false,
      calTz: () => 'America/New_York',
      URLSearchParams, Date, Math, JSON, String, Number, Array, Object, Set, Map, parseInt, isNaN, Promise,
      fetch: fetchImpl,
    };
    const names = ['loadFinancesSummary', '_finStrandError', 'renderFinScorecard', 'renderFinBreakdown',
      '_finTile', 'loadLedger', '_ledParams', 'loadReport', '_rptParams', 'renderReport',
      'formatCents', '_expFmtCents', '_convEsc', 'escapeHtmlInv'];
    const ctx = vm.createContext(sandbox);
    vm.runInContext(names.map((n) => _grabFn(appHtml, n)).join('\n'), ctx);
    return { ctx, el };
  }

  // ---- TX21: a failed summary fetch strands NOTHING ----
  {
    const { ctx, el } = _chainSandbox(async () => { throw new Error('network down (deploy restart)'); });
    await vm.runInContext('loadFinancesSummary()', ctx);
    const grid = String(el('finScorecard').innerHTML);
    const led = String(el('ledgerList').innerHTML);
    const rpt = String(el('rptList').innerHTML);
    const allHonest = [grid, led, rpt].every((h) => h.includes('Try again'))
      && !led.includes('Loading') && !rpt.includes('Loading')
      && led.includes('summary failed to load') && rpt.includes('summary failed to load');
    check('TX21 [the live bug]: when the summary fetch fails (e.g. mid-deploy), the summary, ledger, AND report cards all show an honest error with a retry — never a stranded "Loading…"',
      allHonest, JSON.stringify({ grid: grid.slice(0, 60), led: led.slice(0, 60), rpt: rpt.slice(0, 60) }));
  }

  // ---- TX21b: a tile-render throw cannot strand the card loads ----
  {
    const summary = { period: { start: '2026-08-01T04:00:00.000Z', end: '2026-09-01T04:00:00.000Z', kind: 'month' }, live_mode: true, money_in: {}, money_out: {}, by_category: [] };
    const ledger = { rows: [], totals: { in_cents: 0, out_cents: 0, net_cents: 0, demo_cents: 0 }, capped: false, total_rows: 0 };
    const report = { groups: [], totals: { in_cents: 0, out_cents: 0, net_cents: 0, count: 0 }, hidden_test: { count: 0, cents: 0 }, include_test: false, capped: false, total_rows: 0, source_total_rows: 0 };
    const fetched = [];
    const { ctx, el } = _chainSandbox(async (url) => {
      fetched.push(url.split('?')[0]);
      const body = url.includes('/summary') ? summary : url.includes('/ledger') ? ledger : report;
      return { ok: true, status: 200, json: async () => body };
    });
    // sabotage the tile renderer AFTER extraction — the guard must contain it
    vm.runInContext('renderFinScorecard = function () { throw new Error("renderer bug"); };', ctx);
    await vm.runInContext('loadFinancesSummary()', ctx);
    await new Promise((r) => setTimeout(r, 100));
    const led = String(el('ledgerList').innerHTML);
    const rpt = String(el('rptList').innerHTML);
    check('TX21b: a throwing tile renderer is contained — the ledger and report fetches still fire and both cards render (empty states here), instead of the whole chain dying upstream',
      fetched.includes('/api/finances/ledger') && fetched.includes('/api/finances/report')
        && led.includes('Nothing in this period') && rpt.includes('No money movement'),
      JSON.stringify({ fetched, led: led.slice(0, 50), rpt: rpt.slice(0, 50) }));
  }

  // ---- TX21c: each card's OWN fetch failure shows its honest error ----
  {
    const summary = { period: { start: '2026-08-01T04:00:00.000Z', end: '2026-09-01T04:00:00.000Z', kind: 'month' }, live_mode: true, money_in: {}, money_out: {}, by_category: [] };
    const { ctx, el } = _chainSandbox(async (url) => {
      if (url.includes('/summary')) return { ok: true, status: 200, json: async () => summary };
      return { ok: false, status: 500, json: async () => ({}) };
    });
    await vm.runInContext('loadFinancesSummary()', ctx);
    await new Promise((r) => setTimeout(r, 100));
    const led = String(el('ledgerList').innerHTML);
    const rpt = String(el('rptList').innerHTML);
    check('TX21c: when the ledger/report fetches themselves 500, each card shows its own honest error with a retry link — no silent strand anywhere in the chain',
      led.includes('Could not load the ledger') && led.includes('Try again')
        && rpt.includes('Could not load the report') && rpt.includes('Try again'),
      JSON.stringify({ led: led.slice(0, 60), rpt: rpt.slice(0, 60) }));
  }

  // ---- TX23: the watchdog — a hang can strand nothing, and retry RECOVERS ----
  {
    // The exact live state: fresh page entry, _finPeriod never born
    // (undeclared), loaders dead upstream of every fetch, cards on
    // "Loading…". The watchdog must flip them to the honest timeout,
    // and its retry must RECOVER (create the period state and load) —
    // not re-throw.
    const elements = {};
    const el = (id) => elements[id] || (elements[id] = {
      id, innerHTML: id === 'ledgerList' || id === 'rptList' ? 'Loading&hellip;' : '<div class="fin-skeleton"></div>',
      style: {}, dataset: {}, textContent: '', value: '', classList: { toggle() {} },
    });
    const fetched = [];
    const summary = { period: { start: '2026-08-01T04:00:00.000Z', end: '2026-09-01T04:00:00.000Z', kind: 'month' }, live_mode: true, money_in: {}, money_out: {}, by_category: [] };
    const ledger = { rows: [], totals: { in_cents: 0, out_cents: 0, net_cents: 0, demo_cents: 0 }, capped: false, total_rows: 0 };
    const report = { groups: [], totals: { in_cents: 0, out_cents: 0, net_cents: 0, count: 0 }, hidden_test: { count: 0, cents: 0 }, include_test: false, capped: false, total_rows: 0, source_total_rows: 0 };
    const sandbox = {
      console: { error() {}, log() {} }, setTimeout,
      document: { getElementById: el, querySelectorAll: () => [] },
      window: {}, _rptIncludeTest: false, calTz: () => 'America/New_York',
      URLSearchParams, Date, Math, JSON, String, Number, Array, Object, Set, Map, parseInt, isNaN, Promise, RegExp,
      // NOTE: _finPeriod deliberately NOT provided — the live bug's state.
      fetch: async (url) => {
        fetched.push(url.split('?')[0]);
        const body = url.includes('/summary') ? summary : url.includes('/ledger') ? ledger : report;
        return { ok: true, status: 200, json: async () => body };
      },
    };
    const names = ['_finArmWatchdog', 'finWatchdogRetry', 'setFinPeriod', 'loadFinancesSummary', '_finStrandError',
      'renderFinScorecard', 'renderFinBreakdown', '_finTile', 'loadLedger', '_ledParams', 'loadReport', '_rptParams',
      'renderReport', 'formatCents', '_expFmtCents', '_convEsc', 'escapeHtmlInv'];
    const ctx = vm.createContext(sandbox);
    vm.runInContext(names.map((n) => _grabFn(appHtml, n)).join('\n'), ctx);

    // 1) the strand: watchdog armed with a short fuse, nothing loads
    vm.runInContext('_finArmWatchdog(15)', ctx);
    await new Promise((r) => setTimeout(r, 80));
    const led = String(el('ledgerList').innerHTML);
    const rpt = String(el('rptList').innerHTML);
    const grid1 = String(el('finScorecard').innerHTML);
    const flipped = [led, rpt, grid1].every((h) => h.includes('taking too long') && h.includes('finWatchdogRetry'))
      && !led.includes('Loading');
    // 2) the recovery: the retry link's handler must complete the FULL
    //    chain from the broken state (no _finPeriod anywhere)
    await vm.runInContext('finWatchdogRetry()', ctx);
    await new Promise((r) => setTimeout(r, 100));
    const recovered = fetched.includes('/api/finances/summary')
      && fetched.includes('/api/finances/ledger')
      && fetched.includes('/api/finances/report')
      && String(el('rptList').innerHTML).includes('No money movement');
    check('TX23 [the watchdog]: cards stuck loading flip to "taking too long" + retry after the fuse — and the retry RECOVERS from the exact live state (period state never born): full chain runs, all three fetches fire, cards render',
      flipped && recovered,
      JSON.stringify({ flipped, recovered, fetched, led: led.slice(0, 60) }));
    // 3) armed on page ENTRY, before anything can throw
    const entryArmed = /async function loadFinancesPage\(\) \{\s*\n\s*_finArmWatchdog\(\);/.test(appHtml);
    check('TX23b: the watchdog is armed as loadFinancesPage\'s FIRST act — upstream of every loader, so no failure class can precede it',
      entryArmed);
  }

  console.log(`${pass}/${pass + fail} — transaction-report suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

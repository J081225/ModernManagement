#!/usr/bin/env node
// scripts/test-finances-summary.js — BG1 commit 4: the summary suite.
// Run: node scripts/test-finances-summary.js (no DB needed — fixture-driven).
const { computeFinancesSummary, composeLedgerRows, resolvePeriod, legacyDollarsToCents } = require('../lib/finances-summary');

const WS_A = { id: 7, owner_user_id: 3, timezone: 'America/New_York' };
const NOW = '2026-07-19T18:00:00Z';

// Fixture DB: two workspaces' money, driven by the lib's actual SQL shapes.
function makeDb(fx) {
  return {
    query: async (sql, params) => {
      if (sql.includes('FROM transaction_payments')) {
        const wsId = params[0];
        let rows = fx.ledger.filter((r) => r.workspace_id === wsId && r.status === 'completed');
        if (sql.includes('created_at >= $2')) {
          rows = rows.filter((r) => r.created_at >= params[1] && r.created_at < params[2]);
        } else if (sql.includes('created_at > $2')) {
          rows = rows.filter((r) => r.created_at > params[1]); // STRICT — the half-open window
        }
        return { rows: [{
          total: rows.reduce((a, r) => a + r.amount_cents, 0),
          stripe: rows.filter((r) => r.payment_method === 'stripe').reduce((a, r) => a + r.amount_cents, 0),
          deposits: rows.filter((r) => r.payment_type === 'deposit').reduce((a, r) => a + r.amount_cents, 0),
          deposits_stripe: rows.filter((r) => r.payment_type === 'deposit' && r.payment_method === 'stripe').reduce((a, r) => a + r.amount_cents, 0),
        }] };
      }
      if (sql.includes('FROM rent_payments')) {
        const uid = params[0];
        let rows = fx.rent.filter((r) => r.user_id === uid && r.status === 'paid');
        const dateOf = (r) => r.paid_date || r.due_date;
        if (sql.includes('>= $2')) rows = rows.filter((r) => dateOf(r) >= params[1] && dateOf(r) < params[2]);
        else if (sql.includes('> $2')) rows = rows.filter((r) => dateOf(r) > params[1]);
        return { rows: [{ s: rows.reduce((a, r) => a + Number(r.amount), 0) }] };
      }
      if (sql.includes('FROM budget_transactions')) {
        const uid = params[0];
        // TR2 (G1): the stub honors the SQL's type filter — income and
        // expense are now distinct queries in the lib.
        const wantType = sql.includes("type = 'income'") ? 'income' : 'expense';
        let rows = fx.budget.filter((r) => r.user_id === uid && r.type === wantType);
        if (sql.includes('date >= $2')) rows = rows.filter((r) => r.date >= params[1] && r.date < params[2]);
        else if (sql.includes('date > $2')) rows = rows.filter((r) => r.date > params[1]);
        if (sql.includes('GROUP BY')) {
          const by = {};
          for (const r of rows) by[r.category || 'Other'] = (by[r.category || 'Other'] || 0) + Number(r.amount);
          return { rows: Object.entries(by).map(([category, s]) => ({ category, s })) };
        }
        return { rows: [{ s: rows.reduce((a, r) => a + Number(r.amount), 0) }] };
      }
      if (sql.includes('FROM expenses')) {
        const wsId = params[0];
        let rows = (fx.expenses || []).filter((r) => r.workspace_id === wsId);
        if (sql.includes('spent_on >= $2')) rows = rows.filter((r) => r.spent_on >= params[1] && r.spent_on < params[2]);
        else if (sql.includes('spent_on > $2')) rows = rows.filter((r) => r.spent_on > params[1]); // STRICT — half-open
        if (sql.includes('GROUP BY')) {
          const by = {};
          for (const r of rows) by[r.category] = (by[r.category] || 0) + r.amount_cents;
          return { rows: Object.entries(by).map(([category, s]) => ({ category, s })) };
        }
        return { rows: [{ s: rows.reduce((a, r) => a + r.amount_cents, 0) }] };
      }
      if (sql.includes('FROM budget_anchors')) {
        const rows = fx.anchors.filter((a) => a.workspace_id === params[0]).sort((a, b) => b.as_of.localeCompare(a.as_of));
        return { rows: rows.slice(0, 1) };
      }
      if (sql.includes('FROM budget_goals')) {
        const rows = fx.goals.filter((g) => g.workspace_id === params[0] && g.active && g.period === params[1]);
        return { rows: rows.slice(0, 1) };
      }
      throw new Error('unexpected SQL: ' + sql.slice(0, 50));
    },
  };
}

const FX = {
  ledger: [
    // July, workspace 7: $50 cash, $10 stripe deposit, June's $80 outside the period
    { workspace_id: 7, amount_cents: 5000, payment_method: 'cash', status: 'completed', created_at: '2026-07-10T15:00:00.000Z' },
    { workspace_id: 7, amount_cents: 1000, payment_method: 'stripe', status: 'completed', created_at: '2026-07-12T15:00:00.000Z' },
    { workspace_id: 7, amount_cents: 8000, payment_method: 'cash', status: 'completed', created_at: '2026-06-20T15:00:00.000Z' },
    { workspace_id: 7, amount_cents: 4000, payment_method: 'cash', status: 'pending', created_at: '2026-07-11T15:00:00.000Z' },
    // workspace 8's money — must never leak into 7
    { workspace_id: 8, amount_cents: 99900, payment_method: 'cash', status: 'completed', created_at: '2026-07-10T15:00:00.000Z' },
  ],
  rent: [
    { user_id: 3, amount: '1200.00', status: 'paid', paid_date: '2026-07-05', due_date: '2026-07-01' },
    { user_id: 3, amount: '1200.00', status: 'pending', paid_date: '', due_date: '2026-07-01' },
    { user_id: 9, amount: '5000.00', status: 'paid', paid_date: '2026-07-06', due_date: '2026-07-01' }, // other owner
  ],
  budget: [
    { user_id: 3, type: 'expense', category: 'Supplies', amount: '84.50', date: '2026-07-08' },
    { user_id: 3, type: 'expense', category: 'Utilities', amount: '210.00', date: '2026-07-02' },
    { user_id: 3, type: 'income', category: 'Rent', amount: '1200.00', date: '2026-07-05' },
  ],
  anchors: [],
  goals: [],
  // BG2: real expenses — workspace-scoped cents
  expenses: [
    { workspace_id: 7, amount_cents: 4200, category: 'Supplies', spent_on: '2026-07-09' },
    { workspace_id: 7, amount_cents: 15000, category: 'Payroll', spent_on: '2026-07-15' },
    { workspace_id: 7, amount_cents: 7700, category: 'Supplies', spent_on: '2026-06-15' }, // outside July
    { workspace_id: 8, amount_cents: 50000, category: 'Rent', spent_on: '2026-07-10' },    // other workspace
  ],
};
const clone = () => JSON.parse(JSON.stringify(FX));

// BG8: row-level stub over the SAME fixtures for composeLedgerRows.
function makeLedgerDb(fx) {
  return {
    query: async (sql, params) => {
      if (sql.includes('LEFT JOIN transactions t ON')) {
        const rows = fx.ledger
          .filter((r) => r.workspace_id === params[0] && r.status === 'completed'
            && r.created_at >= params[1] && r.created_at < params[2])
          .map((r, i) => ({ payment_id: r.id || (100 + i), transaction_id: r.transaction_id || (200 + i), amount_cents: r.amount_cents, payment_type: r.payment_type || 'payment', payment_method: r.payment_method, created_at: r.created_at, customer_display_name: 'Dana' }));
        return { rows };
      }
      if (sql.includes('FROM rent_payments')) {
        const dateOf = (r) => r.paid_date || r.due_date;
        const rows = fx.rent
          .filter((r) => r.user_id === params[0] && r.status === 'paid' && dateOf(r) >= params[1] && dateOf(r) < params[2])
          .map((r, i) => ({ id: r.id || (300 + i), resident: r.resident || 'Tenant', unit: r.unit || '', amount: r.amount, d: dateOf(r) }));
        return { rows };
      }
      if (sql.includes('FROM expenses')) {
        const rows = (fx.expenses || [])
          .filter((r) => r.workspace_id === params[0] && r.spent_on >= params[1] && r.spent_on < params[2])
          .map((r) => ({ amount_cents: r.amount_cents, category: r.category, description: r.description || '', vendor: r.vendor || '', spent_on: r.spent_on, row_source: r.source || 'manual' }));
        return { rows };
      }
      if (sql.includes('FROM budget_transactions')) {
        // TR2 (G1): the ledger reads BOTH types now, and carries type
        // + id through (the lib maps income -> direction 'in').
        const rows = fx.budget
          .filter((r) => r.user_id === params[0] && (r.type === 'expense' || r.type === 'income') && r.date >= params[1] && r.date < params[2])
          .map((r, i) => ({ id: r.id || (900 + i), amount: r.amount, category: r.category, description: r.description || '', date: r.date, type: r.type }));
        return { rows };
      }
      throw new Error('unexpected ledger SQL: ' + sql.slice(0, 50));
    },
  };
}
const TEST_ENV = { STRIPE_TEST_SECRET_KEY: 'sk_test_x' };
const LIVE_ENV = { DEPOSITS_LIVE_OVERRIDE: 'true' };

(async () => {
  let pass = 0, total = 0;
  const check = (l, x) => { total++; if (x) { pass++; console.log('PASS  ' + l); } else console.log('FAIL  ' + l); };

  // B1: money_in sums both feeds with provenance; pending + out-of-period excluded
  let s = await computeFinancesSummary({ db: makeDb(clone()), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW });
  check('B1 [evolved TR2/G1]: PS feed = completed July cents minus demo (5000), rent legacy = 120000, income legacy = 120000 (the once-invisible rows), combined 245000',
    s.money_in.ps_cents === 5000 && s.money_in.pm_rent_legacy_cents === 120000
    && s.money_in.legacy_budget_income_cents === 120000
    && s.money_in.combined_cents === 245000);
  check('B1b: pending rows and June money excluded from the period', s.money_in.ps_cents + s.money_in_demo_cents === 6000);

  // B2: test-mode demo split — stripe $10 reported as demo, not real
  check('B2: test-mode: stripe money is demo (1000), live_mode false', s.money_in_demo_cents === 1000 && s.live_mode === false);

  // B3: live mode folds it in
  s = await computeFinancesSummary({ db: makeDb(clone()), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  check('B3: live: stripe folds into real money_in (6000 PS), demo reads 0',
    s.money_in.ps_cents === 6000 && s.money_in_demo_cents === 0 && s.live_mode === true);

  // B4: legacy ×100 conversion + by_category + money_out shape
  check('B4: BG2 feed LIVE (19200 real) + legacy read-through (29450) coexist without double-count',
    s.money_out.expenses_cents === 19200 && s.money_out.legacy_budget_expense_cents === 29450
    && s.money_out.combined_cents === 48650);
  check('B4b: by_category carries BOTH sources — real rows labeled expenses, legacy labeled legacy',
    s.by_category.filter((c) => c.source === 'expenses').length === 2
    && s.by_category.filter((c) => c.source === 'legacy').length === 2
    && s.by_category.find((c) => c.source === 'expenses' && c.category === 'Payroll').cents === 15000
    && s.by_category.find((c) => c.source === 'legacy' && c.category === 'Utilities').cents === 21000);
  check('B4c: net = in − out', s.net_cents === (s.money_in.combined_cents - s.money_out.combined_cents));

  // B5: no anchor -> cash_current is NULL, not zero
  check('B5: unknown is not zero — cash_current null without an anchor', s.cash_current_cents === null && s.anchor === null);

  // B6: the half-open anchor window — an event dated EXACTLY at as_of never double-counts
  let fx = clone();
  fx.anchors.push({ workspace_id: 7, amount_cents: 100000, as_of: '2026-07-10T15:00:00.000Z' });
  // the 5000-cent cash payment is stamped exactly 2026-07-10T15:00:00.000Z — inside the drawer
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  // after as_of: stripe 1000 (live); rent 07-05 before; legacy expenses
  // 07-08/07-02 before; REAL expenses strictly after local date
  // 2026-07-10: only Payroll 07-15 (15000) — Supplies 07-09 is before.
  check('B6: event at exactly as_of stays inside the anchor (cash = 100000 + 1000 − 15000)',
    s.cash_current_cents === 100000 + 1000 - 15000);

  // B6b: move the anchor earlier — the same event now counts once, after
  fx = clone();
  fx.anchors.push({ workspace_id: 7, amount_cents: 100000, as_of: '2026-07-01T00:00:00.000Z' });
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  // after 07-01: PS 6000, rent 120000, legacy out 29450, real out 19200
  check('B6b [evolved TR2/G1]: earlier anchor counts each event exactly once, income included (100000+6000+120000+120000−29450−19200)',
    s.cash_current_cents === 100000 + 6000 + 120000 + 120000 - 29450 - 19200);

  // B6c: test-mode cash excludes the demo money entirely
  fx = clone();
  fx.anchors.push({ workspace_id: 7, amount_cents: 100000, as_of: '2026-07-01T00:00:00.000Z' });
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW });
  check('B6c [evolved TR2/G1]: test-mode drawer never holds test dollars (stripe 1000 excluded; real income included)',
    s.cash_current_cents === 100000 + 5000 + 120000 + 120000 - 29450 - 19200);

  // B7: goal progress
  fx = clone();
  fx.goals.push({ workspace_id: 7, type: 'revenue', label: 'July target', target_cents: 250000, period: 'month', active: true, id: 1 });
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  check('B7 [evolved TR2/G1]: goal read with progress vs combined money_in, income included (246000/250000 = 98%)',
    s.goal && s.goal.target_cents === 250000 && s.goal.progress_cents === 246000 && s.goal.progress_pct === 98);

  // B8: workspace isolation — workspace 8's summary sees only its own money
  const WS_B = { id: 8, owner_user_id: 9, timezone: 'America/New_York' };
  s = await computeFinancesSummary({ db: makeDb(clone()), workspace: WS_B, period: 'month', env: LIVE_ENV, now: NOW });
  check('B8: workspace B sees its 99900, owner-9 rent, and ONLY its own 50000 expense',
    s.money_in.ps_cents === 99900 && s.money_in.pm_rent_legacy_cents === 500000
    && s.money_out.legacy_budget_expense_cents === 0 && s.money_out.expenses_cents === 50000);

  // B9: period boundaries in workspace tz + quarter kind
  const p = resolvePeriod({ workspace: WS_A, period: 'quarter', now: NOW });
  check('B9: quarter resolves Jul-Oct in ws tz, ISO instants half-open',
    p.kind === 'quarter' && p.startDate === '2026-07-01' && p.endDate === '2026-10-01' && p.startIso.length > 10);

  // B10: nothing materialized — no budget-balance column anywhere
  const fs = require('fs');
  const path = require('path');
  const migDir = path.join(__dirname, '..', 'migrations', 'phase1-additive');
  const migs = fs.readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  check('B10: derived on read — no balance/running-total column in any migration or initDB',
    !/balance_cents|running_balance|current_cash_cents/i.test(migs) && !/balance_cents|running_balance/i.test(srv));

  check('B11: legacy conversion helper rounds correctly', legacyDollarsToCents('84.50') === 8450 && legacyDollarsToCents('0.015') === 2);

  // B12: an expense dated EXACTLY on the anchor's local date stays inside
  // the drawer (spent_on is a DATE — strict > excludes the boundary day).
  fx = clone();
  fx.anchors.push({ workspace_id: 7, amount_cents: 100000, as_of: '2026-07-09T23:00:00.000Z' }); // local date 2026-07-09
  fx.expenses = [{ workspace_id: 7, amount_cents: 4200, category: 'Supplies', spent_on: '2026-07-09' }];
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  // after local date 2026-07-09: PS 6000 (07-10, 07-12); rent 07-05
  // before; the 07-09 expense is AT the boundary — inside the drawer.
  check('B12: expense dated exactly at the anchor date never double-counts (cash excludes it)',
    s.cash_current_cents === 100000 + 6000 - 0);

  // ---- BG4 commit 1: money-in completeness PROVEN, not changed ----
  // Every PS money-in is a transaction_payments row (webhook flips
  // pending->completed; completion-time recordPayment inserts
  // completed rows; the manual tools too). Summing ROWS means a
  // transaction touched by BOTH a webhook payment and completion cash
  // counts each dollar exactly once — different rows, different money.
  fx = clone();
  fx.ledger.push(
    // one transaction (id irrelevant to the sum): $10 deposit via
    // webhook + $40 completion cash — same purchase, two real payments
    { workspace_id: 7, amount_cents: 1000, payment_method: 'stripe', status: 'completed', created_at: '2026-07-14T15:00:00.000Z' },
    { workspace_id: 7, amount_cents: 4000, payment_method: 'cash', status: 'completed', created_at: '2026-07-16T15:00:00.000Z' }
  );
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  check('B15: webhook + completion rows on one transaction each count once (6000 + 1000 + 4000)',
    s.money_in.ps_cents === 11000);

  // PM rent counts through BOTH flip paths: the PUT stamps paid_date;
  // a paid row with EMPTY paid_date falls back to due_date and still
  // counts — no paid rent is silently missing.
  fx = clone();
  fx.rent.push(
    { user_id: 3, amount: '900.00', status: 'paid', paid_date: '2026-07-11', due_date: '2026-07-01' },  // PUT-shaped
    { user_id: 3, amount: '800.00', status: 'paid', paid_date: '', due_date: '2026-07-03' }             // event/legacy-shaped
  );
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  check('B15b: both rent flip paths counted; empty paid_date falls back to due_date (120000+90000+80000)',
    s.money_in.pm_rent_legacy_cents === 290000);

  // ---- BG6: anchors are history; drift derives; goals govern ----
  // B17: TWO anchors — the summary uses the most recent; the older row
  // still exists (history preserved, never overwritten).
  fx = clone();
  fx.anchors.push(
    { workspace_id: 7, amount_cents: 50000, as_of: '2026-07-01T00:00:00.000Z' },
    { workspace_id: 7, amount_cents: 130000, as_of: '2026-07-15T00:00:00.000Z' }
  );
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  check('B17: re-anchoring wins by recency, history intact (anchor=130000; only post-07-15 events on top)',
    s.anchor.amount_cents === 130000 && fx.anchors.length === 2
    // after 07-15 local (07-14 EDT date is 2026-07-14): ledger rows after
    // 2026-07-15T00:00Z: none of the July rows (07-10, 07-12) qualify;
    // expenses spent_on > '2026-07-14': Payroll 07-15 counts.
    && s.cash_current_cents === 130000 + 0 - 15000);

  // B17b: drift derives from history + ledger, stored nowhere: expected
  // under the OLD anchor vs a new count.
  fx = clone();
  fx.anchors.push({ workspace_id: 7, amount_cents: 100000, as_of: '2026-07-01T00:00:00.000Z' });
  const pre = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  const counted = 200000;
  const drift = counted - pre.cash_current_cents;
  check('B17b [evolved TR2/G1]: drift = counted − expected (expected 297350 with income → drift −97350), pure derivation',
    pre.cash_current_cents === 100000 + 6000 + 120000 + 120000 - 29450 - 19200 && drift === counted - 297350);

  // B18: one ACTIVE goal per period governs; an inactive same-period
  // goal is ignored; workspace isolation holds for anchors and goals.
  fx = clone();
  fx.goals.push(
    { workspace_id: 7, id: 1, type: 'revenue', label: 'old', target_cents: 100000, period: 'month', active: false },
    { workspace_id: 7, id: 2, type: 'revenue', label: 'current', target_cents: 250000, period: 'month', active: true },
    { workspace_id: 8, id: 3, type: 'revenue', label: 'other ws', target_cents: 1, period: 'month', active: true }
  );
  fx.anchors.push({ workspace_id: 8, amount_cents: 999999, as_of: '2026-07-01T00:00:00.000Z' });
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  check('B18: the ACTIVE goal governs (250000, label current); workspace B goal + anchor never leak into A',
    s.goal && s.goal.target_cents === 250000 && s.goal.label === 'current' && s.cash_current_cents === null);

  // B19: endpoint discipline, static: anchors are INSERT-only (no
  // UPDATE budget_anchors anywhere in the codebase), goal replacement
  // DEACTIVATES (never deletes) in the POST, and all four new routes
  // carry requireAuth.
  const srvSrc2 = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  check('B19: INSERT-only anchors; deactivate-not-delete goal replacement; owner-only routes',
    !srvSrc2.includes('UPDATE budget_anchors')
    && srvSrc2.includes("UPDATE budget_goals SET active = FALSE WHERE workspace_id = $1 AND period = $2 AND active = TRUE")
    && srvSrc2.includes("app.post('/api/finances/anchor', requireAuth")
    && srvSrc2.includes("app.post('/api/finances/goal', requireAuth")
    && srvSrc2.includes("app.patch('/api/finances/goal/:id', requireAuth")
    && srvSrc2.includes("app.delete('/api/finances/goal/:id', requireAuth"));

  // B20: manual expense entry reachable from the dashboard (BG2's card
  // + modal absorbed by BG3 — verified, no polish needed).
  const appSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'views', 'app.html'), 'utf8');
  check('B20: add-expense modal + card + wire all present exactly once',
    appSrc.split('id="financesExpensesCard"').length - 1 === 1
    && appSrc.split('id="addExpenseModal"').length - 1 === 1
    && appSrc.includes('onclick="openAddExpense()"'));

  // ---- BG4 commit 2: deposits labeled + test-money across ALL sources ----
  // One fixture, every money-in source at once: a stripe full payment,
  // a stripe deposit, a CASH deposit, completion cash, and PM rent.
  fx = clone();
  fx.ledger = [
    { workspace_id: 7, amount_cents: 1000, payment_method: 'stripe', payment_type: 'payment', status: 'completed', created_at: '2026-07-10T15:00:00.000Z' },
    { workspace_id: 7, amount_cents: 2000, payment_method: 'stripe', payment_type: 'deposit', status: 'completed', created_at: '2026-07-11T15:00:00.000Z' },
    { workspace_id: 7, amount_cents: 1500, payment_method: 'cash', payment_type: 'deposit', status: 'completed', created_at: '2026-07-12T15:00:00.000Z' },
    { workspace_id: 7, amount_cents: 4000, payment_method: 'cash', payment_type: 'payment', status: 'completed', created_at: '2026-07-13T15:00:00.000Z' },
  ];
  // TEST MODE: stripe rows (payment 1000 + deposit 2000) are demo.
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW });
  check('B16: test mode — real PS = cash only (5500), demo = every stripe dollar (3000)',
    s.money_in.ps_cents === 5500 && s.money_in_demo_cents === 3000);
  check('B16b: the labeled deposit figure counts only REAL deposits (cash 1500; the stripe 2000 is demo)',
    s.money_in.deposits_cents === 1500);
  fx.anchors.push({ workspace_id: 7, amount_cents: 100000, as_of: '2026-07-01T00:00:00.000Z' });
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW });
  check('B16c [evolved TR2/G1]: cash_current holds only real money across all sources, income included (100000+5500+120000+120000−29450−19200)',
    s.cash_current_cents === 100000 + 5500 + 120000 + 120000 - 29450 - 19200);
  // LIVE MODE: everything folds in.
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  check('B16d: live — all sources fold in (PS 8500, deposits 3500, demo 0)',
    s.money_in.ps_cents === 8500 && s.money_in.deposits_cents === 3500 && s.money_in_demo_cents === 0);
  check('B16e [evolved TR2/G1]: live cash_current includes the former demo dollars and the income rows',
    s.cash_current_cents === 100000 + 8500 + 120000 + 120000 - 29450 - 19200);

  // ---- BG2: expense validation + the invoice bridge ----
  const { validateExpenseInput, bridgeInvoiceToExpense } = require('../lib/expenses');
  check('B13: cents-only — dollars-as-float (84.5) REJECTED, never rounded',
    validateExpenseInput({ amount_cents: 84.5, category: 'Supplies', spent_on: '2026-07-19' }).ok === false
    && validateExpenseInput({ amount_cents: 8450, category: 'Supplies', spent_on: '2026-07-19' }).ok === true);
  check('B13b: bad category and fake date rejected',
    validateExpenseInput({ amount_cents: 100, category: 'Bribes', spent_on: '2026-07-19' }).ok === false
    && validateExpenseInput({ amount_cents: 100, category: 'Fees', spent_on: 'not-a-date' }).ok === false);

  const bridged = [];
  const bridgeClient = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id FROM expenses')) {
        return { rows: bridged.filter((b) => b.invoice_id === params[1]).map((b) => ({ id: b.id })) };
      }
      if (sql.includes('INSERT INTO expenses')) {
        const row = { id: bridged.length + 1, invoice_id: params[5], amount_cents: params[1] };
        bridged.push(row);
        return { rows: [{ id: row.id }] };
      }
      throw new Error('unexpected: ' + sql.slice(0, 40));
    },
  };
  const inv = { id: 44, amount: '320.00', vendor: 'AcePlumbing Co.', description: 'Plumbing repair' };
  let b = await bridgeInvoiceToExpense(bridgeClient, { workspaceId: 7, invoice: inv, userId: 3, spentOn: '2026-07-19' });
  check('B14: the bridge converts legacy dollars ×100 exactly once (32000 cents)',
    b.bridged === true && b.amount_cents === 32000);
  b = await bridgeInvoiceToExpense(bridgeClient, { workspaceId: 7, invoice: inv, userId: 3, spentOn: '2026-07-19' });
  check('B14b: re-marking is idempotent — the second bridge never doubles the money-out',
    b.bridged === false && b.reason === 'already_bridged' && bridged.length === 1);
  b = await bridgeInvoiceToExpense(bridgeClient, { workspaceId: 7, invoice: { id: 45, amount: '0.00', vendor: 'X' }, userId: 3, spentOn: '2026-07-19' });
  check('B14c: a zero/invalid invoice amount refuses to bridge', b.bridged === false && b.reason === 'invoice_amount_invalid');

  // ---- BG8: the unified ledger — totals match the summary ----
  // THE PROOF THAT MATTERS: same fixtures, same period — the ledger's
  // totals and the dashboard summary must be EQUAL. Same feeds, same
  // boundaries, same demo arithmetic; they cannot disagree.
  fx = clone();
  const sum8 = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW });
  const led8 = await composeLedgerRows({ db: makeLedgerDb(fx), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW });
  check('B21: LEDGER TOTALS === SUMMARY (in, out, net, demo) — the report and the dashboard read one truth',
    led8.totals.in_cents === sum8.money_in.combined_cents
    && led8.totals.out_cents === sum8.money_out.combined_cents
    && led8.totals.net_cents === sum8.net_cents
    && led8.totals.demo_cents === sum8.money_in_demo_cents);

  // B21b: both directions present, correctly shaped and labeled.
  check('B21b: rows span both directions with source + demo labels',
    led8.rows.some((r) => r.direction === 'in' && r.source === 'ledger')
    && led8.rows.some((r) => r.direction === 'in' && r.source === 'legacy_rent')
    && led8.rows.some((r) => r.direction === 'out' && r.source === 'expenses')
    && led8.rows.some((r) => r.direction === 'out' && r.source === 'legacy_budget')
    && led8.rows.some((r) => r.demo === true));

  // B21c: filters — direction narrows, category narrows, source skips feeds.
  const ledIn = await composeLedgerRows({ db: makeLedgerDb(clone()), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW, direction: 'in' });
  const ledSup = await composeLedgerRows({ db: makeLedgerDb(clone()), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW, category: 'Supplies' });
  const ledExp = await composeLedgerRows({ db: makeLedgerDb(clone()), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW, source: 'expenses' });
  check('B21c: direction=in has no out rows; category=Supplies only Supplies; source=expenses only that feed',
    ledIn.rows.every((r) => r.direction === 'in') && ledIn.totals.out_cents === 0
    && ledSup.rows.every((r) => r.category === 'Supplies')
    && ledExp.rows.every((r) => r.source === 'expenses'));

  // B21d: workspace isolation — B's ledger never contains A's money.
  const ledB = await composeLedgerRows({ db: makeLedgerDb(clone()), workspace: { id: 8, owner_user_id: 9, timezone: 'America/New_York' }, period: 'month', env: LIVE_ENV, now: NOW });
  check('B21d: workspace B ledger = only its own rows (99900 in, 50000 out, 500000 rent)',
    ledB.totals.in_cents === 99900 + 500000 && ledB.totals.out_cents === 50000
    && !ledB.rows.some((r) => r.amount_cents === 5000 || r.amount_cents === 120000));

  // B21e: CSV escaping — the extracted helper handles commas/quotes.
  const srvCsv = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  check('B21e: one escaping implementation — extracted _csvEscape used by BOTH exports',
    srvCsv.includes('const _csvEscape = (v) =>')
    && srvCsv.includes('const escapeCsv = _csvEscape;')
    && srvCsv.split('_csvEscape(').length - 1 >= 2
    && srvCsv.includes("app.get('/api/finances/ledger/export.csv', requireAuth"));

  console.log(pass + '/' + total + (pass === total ? ' — budget summary gate PASSED' : ' — GATE FAILED'));
  process.exit(pass === total ? 0 : 1);
})();

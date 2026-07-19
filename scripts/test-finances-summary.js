#!/usr/bin/env node
// scripts/test-finances-summary.js — BG1 commit 4: the summary suite.
// Run: node scripts/test-finances-summary.js (no DB needed — fixture-driven).
const { computeFinancesSummary, resolvePeriod, legacyDollarsToCents } = require('../lib/finances-summary');

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
        let rows = fx.budget.filter((r) => r.user_id === uid && r.type === 'expense');
        if (sql.includes('date >= $2')) rows = rows.filter((r) => r.date >= params[1] && r.date < params[2]);
        else if (sql.includes('date > $2')) rows = rows.filter((r) => r.date > params[1]);
        if (sql.includes('GROUP BY')) {
          const by = {};
          for (const r of rows) by[r.category || 'Other'] = (by[r.category || 'Other'] || 0) + Number(r.amount);
          return { rows: Object.entries(by).map(([category, s]) => ({ category, s })) };
        }
        return { rows: [{ s: rows.reduce((a, r) => a + Number(r.amount), 0) }] };
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
};
const clone = () => JSON.parse(JSON.stringify(FX));
const TEST_ENV = { STRIPE_TEST_SECRET_KEY: 'sk_test_x' };
const LIVE_ENV = { DEPOSITS_LIVE_OVERRIDE: 'true' };

(async () => {
  let pass = 0, total = 0;
  const check = (l, x) => { total++; if (x) { pass++; console.log('PASS  ' + l); } else console.log('FAIL  ' + l); };

  // B1: money_in sums both feeds with provenance; pending + out-of-period excluded
  let s = await computeFinancesSummary({ db: makeDb(clone()), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW });
  check('B1: PS feed = completed July cents minus demo (5000), rent legacy = 120000, combined 125000',
    s.money_in.ps_cents === 5000 && s.money_in.pm_rent_legacy_cents === 120000 && s.money_in.combined_cents === 125000);
  check('B1b: pending rows and June money excluded from the period', s.money_in.ps_cents + s.money_in_demo_cents === 6000);

  // B2: test-mode demo split — stripe $10 reported as demo, not real
  check('B2: test-mode: stripe money is demo (1000), live_mode false', s.money_in_demo_cents === 1000 && s.live_mode === false);

  // B3: live mode folds it in
  s = await computeFinancesSummary({ db: makeDb(clone()), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  check('B3: live: stripe folds into real money_in (6000 PS), demo reads 0',
    s.money_in.ps_cents === 6000 && s.money_in_demo_cents === 0 && s.live_mode === true);

  // B4: legacy ×100 conversion + by_category + money_out shape
  check('B4: legacy expenses ×100 (8450 + 21000 = 29450), BG2 feed wired at 0',
    s.money_out.legacy_budget_expense_cents === 29450 && s.money_out.expenses_cents === 0 && s.money_out.combined_cents === 29450);
  check('B4b: by_category labeled legacy with correct cents',
    s.by_category.length === 2 && s.by_category.every((c) => c.source === 'legacy')
    && s.by_category.find((c) => c.category === 'Utilities').cents === 21000);
  check('B4c: net = in − out', s.net_cents === (s.money_in.combined_cents - s.money_out.combined_cents));

  // B5: no anchor -> cash_current is NULL, not zero
  check('B5: unknown is not zero — cash_current null without an anchor', s.cash_current_cents === null && s.anchor === null);

  // B6: the half-open anchor window — an event dated EXACTLY at as_of never double-counts
  let fx = clone();
  fx.anchors.push({ workspace_id: 7, amount_cents: 100000, as_of: '2026-07-10T15:00:00.000Z' });
  // the 5000-cent cash payment is stamped exactly 2026-07-10T15:00:00.000Z — inside the drawer
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  // after as_of: stripe 1000 (live) + rent 120000 (paid 07-05?? no — strictly after 2026-07-10 local date '2026-07-10': paid 07-05 is BEFORE) − expenses after 07-10: none (07-08, 07-02 before)
  check('B6: event at exactly as_of stays inside the anchor (cash = 100000 + 1000 + 0 − 0)',
    s.cash_current_cents === 101000);

  // B6b: move the anchor earlier — the same event now counts once, after
  fx = clone();
  fx.anchors.push({ workspace_id: 7, amount_cents: 100000, as_of: '2026-07-01T00:00:00.000Z' });
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  // after 07-01: PS 5000+1000, rent 120000 (07-05), expenses 8450+21000 (07-08, 07-02)
  check('B6b: earlier anchor counts each event exactly once (100000+6000+120000−29450)',
    s.cash_current_cents === 100000 + 6000 + 120000 - 29450);

  // B6c: test-mode cash excludes the demo money entirely
  fx = clone();
  fx.anchors.push({ workspace_id: 7, amount_cents: 100000, as_of: '2026-07-01T00:00:00.000Z' });
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: TEST_ENV, now: NOW });
  check('B6c: test-mode drawer never holds test dollars (stripe 1000 excluded from cash)',
    s.cash_current_cents === 100000 + 5000 + 120000 - 29450);

  // B7: goal progress
  fx = clone();
  fx.goals.push({ workspace_id: 7, type: 'revenue', label: 'July target', target_cents: 250000, period: 'month', active: true, id: 1 });
  s = await computeFinancesSummary({ db: makeDb(fx), workspace: WS_A, period: 'month', env: LIVE_ENV, now: NOW });
  check('B7: goal read with progress vs combined money_in (126000/250000 = 50%)',
    s.goal && s.goal.target_cents === 250000 && s.goal.progress_cents === 126000 && s.goal.progress_pct === 50);

  // B8: workspace isolation — workspace 8's summary sees only its own money
  const WS_B = { id: 8, owner_user_id: 9, timezone: 'America/New_York' };
  s = await computeFinancesSummary({ db: makeDb(clone()), workspace: WS_B, period: 'month', env: LIVE_ENV, now: NOW });
  check('B8: workspace B sees its 99900 and owner-9 rent only — nothing of A',
    s.money_in.ps_cents === 99900 && s.money_in.pm_rent_legacy_cents === 500000
    && s.money_out.legacy_budget_expense_cents === 0);

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

  console.log(pass + '/' + total + (pass === total ? ' — budget summary gate PASSED' : ' — GATE FAILED'));
  process.exit(pass === total ? 0 : 1);
})();

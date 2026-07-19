#!/usr/bin/env node
// scripts/test-budget-insights.js — BG7 commit 3: the no-nag proofs.
// Run: node scripts/test-budget-insights.js (no DB — fixture-driven).
const path = require('path');
const { runBudgetInsightPass, prevMonthRange } = require(path.join(__dirname, '..', 'lib', 'budget-insights'));

const WS = { id: 7, owner_user_id: 3, timezone: 'America/New_York', business_name: 'Luxe' };
const LIVE_ENV = { DEPOSITS_LIVE_OVERRIDE: 'true' };
const TEST_ENV = { STRIPE_TEST_SECRET_KEY: 'sk_test_x' };
const wsToday = () => '2026-07-19';

// Fixture db serving the summary's SQL shapes + the insight pass's own
// cap/dismissal/task queries.
function makeDb(fx) {
  const inserts = [];
  return {
    inserts,
    query: async (sql, params) => {
      if (sql.includes('COUNT(*)::int AS n')) return { rows: [{ n: fx.unresolved || 0 }] };
      if (sql.includes('dismissed_at IS NOT NULL')) return { rows: (fx.dismissed || []).map((t) => ({ title: t })) };
      if (sql.includes('INSERT INTO tasks')) { inserts.push({ sql, params }); return { rowCount: 1 }; }
      if (sql.includes('FROM transaction_payments')) {
        const inRange = (r) => sql.includes('created_at >= $2') ? (r.created_at >= params[1] && r.created_at < params[2]) : true;
        const rows = (fx.ledger || []).filter((r) => r.workspace_id === params[0] && r.status === 'completed' && inRange(r));
        return { rows: [{
          total: rows.reduce((a, r) => a + r.amount_cents, 0),
          stripe: rows.filter((r) => r.payment_method === 'stripe').reduce((a, r) => a + r.amount_cents, 0),
          deposits: rows.filter((r) => r.payment_type === 'deposit').reduce((a, r) => a + r.amount_cents, 0),
          deposits_stripe: rows.filter((r) => r.payment_type === 'deposit' && r.payment_method === 'stripe').reduce((a, r) => a + r.amount_cents, 0),
        }] };
      }
      if (sql.includes('FROM rent_payments')) return { rows: [{ s: 0 }] };
      if (sql.includes('FROM budget_transactions')) {
        if (sql.includes('GROUP BY')) return { rows: [] };
        return { rows: [{ s: 0 }] };
      }
      if (sql.includes('FROM expenses')) {
        const inRange = (r) => sql.includes('spent_on >= $2') ? (r.spent_on >= params[1] && r.spent_on < params[2]) : true;
        const rows = (fx.expenses || []).filter((r) => r.workspace_id === params[0] && inRange(r));
        if (sql.includes('GROUP BY')) {
          const by = {};
          for (const r of rows) by[r.category] = (by[r.category] || 0) + r.amount_cents;
          return { rows: Object.entries(by).map(([category, s]) => ({ category, s })) };
        }
        return { rows: [{ s: rows.reduce((a, r) => a + r.amount_cents, 0) }] };
      }
      if (sql.includes('FROM budget_anchors')) return { rows: fx.anchor ? [fx.anchor] : [] };
      if (sql.includes('FROM budget_goals')) return { rows: fx.goal ? [fx.goal] : [] };
      throw new Error('unexpected SQL: ' + sql.slice(0, 50));
    },
  };
}
function makeAnthropic(reply) {
  const calls = [];
  return { calls, messages: { create: async (opts) => { calls.push(opts); return { content: [{ type: 'text', text: reply }] }; } } };
}
const quiet = { log: () => {}, error: () => {} };

(async () => {
  let pass = 0, total = 0;
  const check = (l, x) => { total++; if (x) { pass++; console.log('PASS  ' + l); } else console.log('FAIL  ' + l); };

  // I1: behind-goal workspace — the CONTEXT carries the real numbers,
  // and the model's pace insight lands with them in aiReason.
  let fx = {
    ledger: [{ workspace_id: 7, amount_cents: 620000, payment_method: 'cash', payment_type: 'payment', status: 'completed', created_at: '2026-07-10T15:00:00.000Z' }],
    goal: { id: 1, type: 'revenue', label: 'July', target_cents: 800000, period: 'month', active: true },
  };
  let db = makeDb(fx);
  let ai = makeAnthropic('[{"title":"Behind on your July goal","reason":"You are at $6,200.00 of your $8,000.00 goal with 12 days left."}]');
  let r = await runBudgetInsightPass({ db, anthropic: ai, model: 'haiku-test', workspace: WS, env: LIVE_ENV, logger: quiet, wsToday });
  const ctx = JSON.parse(ai.calls[0].messages[0].content.replace('Budget snapshot (all amounts integer cents):\n', ''));
  check('I1: context carries the REAL goal numbers (620000 of 800000, days_left present)',
    ctx.goal.progress_cents === 620000 && ctx.goal.target_cents === 800000 && Number.isInteger(ctx.goal.days_left_in_period));
  check('I1b: the pace insight lands as a budget_insight suggestion citing the numbers',
    r.inserted === 1 && db.inserts[0].sql.includes("'budget_insight'") && db.inserts[0].params[4].includes('$6,200.00'));

  // I2: THE NO-NAG PROOF — healthy workspace, model returns [], zero inserts.
  db = makeDb(fx);
  ai = makeAnthropic('[]');
  r = await runBudgetInsightPass({ db, anthropic: ai, model: 'haiku-test', workspace: WS, env: LIVE_ENV, logger: quiet, wsToday });
  check('I2: a healthy month emits ZERO — ran, called once, inserted nothing',
    r.ran === true && r.inserted === 0 && ai.calls.length === 1 && db.inserts.length === 0);
  check('I2b: the prompt grants zero EXPLICITLY ("empty array is the expected, correct answer")',
    ai.calls[0].system.includes('empty array is the expected, correct answer'));

  // I3: category spike is DERIVABLE — both periods' by_category reach the model.
  fx = {
    ledger: [],
    expenses: [
      { workspace_id: 7, amount_cents: 140000, category: 'Supplies', spent_on: '2026-07-10' },
      { workspace_id: 7, amount_cents: 90000, category: 'Supplies', spent_on: '2026-06-10' },
    ],
  };
  db = makeDb(fx);
  ai = makeAnthropic('[{"title":"Supplies spending up","reason":"Supplies is $1,400.00 this month vs $900.00 last month."}]');
  r = await runBudgetInsightPass({ db, anthropic: ai, model: 'haiku-test', workspace: WS, env: LIVE_ENV, logger: quiet, wsToday });
  const ctx3 = JSON.parse(ai.calls[0].messages[0].content.replace('Budget snapshot (all amounts integer cents):\n', ''));
  check('I3: this month (140000) AND last month (90000) Supplies both in context — spikes are real comparisons',
    ctx3.this_month.by_category.find((c) => c.category === 'Supplies').cents === 140000
    && ctx3.last_month.by_category.find((c) => c.category === 'Supplies').cents === 90000
    && r.inserted === 1);

  // I4: the unresolved cap holds — no call, no spend, no insight.
  db = makeDb({ ...fx, unresolved: 5 });
  ai = makeAnthropic('[{"title":"x","reason":"y"}]');
  r = await runBudgetInsightPass({ db, anthropic: ai, model: 'haiku-test', workspace: WS, env: LIVE_ENV, logger: quiet, wsToday });
  check('I4: at 5 unresolved suggestions the pass drops BEFORE the model call',
    r.reason === 'cap_reached' && ai.calls.length === 0 && db.inserts.length === 0);

  // I5: a dismissed insight does not return next run.
  db = makeDb({ ...fx, dismissed: ['Supplies spending up'] });
  ai = makeAnthropic('[{"title":"Supplies spending up!","reason":"Supplies is $1,400.00 this month vs $900.00 last month."}]');
  r = await runBudgetInsightPass({ db, anthropic: ai, model: 'haiku-test', workspace: WS, env: LIVE_ENV, logger: quiet, wsToday });
  check('I5: dismissal dedupe — the same insight (normalized) never regenerates', r.inserted === 0 && db.inserts.length === 0);

  // I6: TEST MONEY cannot fake revenue — structural: a test-only
  // workspace's context shows REAL money_in of 0 with the demo dollars
  // in the labeled field, and the prompt names them play money.
  fx = { ledger: [{ workspace_id: 7, amount_cents: 500000, payment_method: 'stripe', payment_type: 'payment', status: 'completed', created_at: '2026-07-10T15:00:00.000Z' }] };
  db = makeDb(fx);
  ai = makeAnthropic('[]');
  r = await runBudgetInsightPass({ db, anthropic: ai, model: 'haiku-test', workspace: WS, env: TEST_ENV, logger: quiet, wsToday });
  const ctx6 = JSON.parse(ai.calls[0].messages[0].content.replace('Budget snapshot (all amounts integer cents):\n', ''));
  check('I6: test-only workspace — real money_in is 0, the $5,000 sits ONLY in demo_cents, live_mode false',
    ctx6.this_month.money_in_cents === 0 && ctx6.demo_cents_this_month === 500000 && ctx6.live_mode === false);
  check('I6b: the prompt names demo money as test-mode play money, never revenue',
    ai.calls[0].system.includes('TEST-MODE play money'));

  // I7: rails — no tools on the call; prevMonthRange handles January.
  check('I7: NO tools parameter on the insight call', !('tools' in ai.calls[0]));
  const jan = prevMonthRange('2026-01-15');
  check('I7b: prevMonthRange crosses the year (Dec 2025)', jan.start === '2025-12-01' && jan.end === '2026-01-01');

  console.log(pass + '/' + total + (pass === total ? ' — budget-insights gate PASSED' : ' — GATE FAILED'));
  process.exit(pass === total ? 0 : 1);
})();

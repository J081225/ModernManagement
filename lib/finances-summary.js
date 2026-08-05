// lib/finances-summary.js — BG1, the spine of the live budget.
//
// A DERIVED view, computed on read, NOTHING materialized (the E14
// lesson: materialized money drifts; recompute-on-read with one
// implementation does not). Every later budget checkpoint reads this.
//
// BOUNDARY (055's decision, enforced here): all new money is
// workspace-scoped INTEGER CENTS. The legacy PM feeds (rent_payments,
// budget_transactions — user-scoped NUMERIC dollars) are read-through
// only: converted ×100 at read via legacyDollarsToCents, labeled
// legacy in the response, never written.
//
// THE TEST-MONEY GATE (investigation §6, same signal as FD3-CP6 —
// lib/deposits.depositsLive, no second detector): Stripe-origin
// money-in (payment_method='stripe' ledger rows) is DEMO money while
// the key is test-mode. Demo money is excluded from real money_in and
// from cash_current (a drawer never holds test dollars) but reported
// in money_in_demo_cents so the dashboard can show "test payments"
// honestly. When depositsLive() is true it folds into real money_in
// and the demo field reads 0.
//
// THE ANCHOR WINDOW is half-open at as_of: an event with timestamp
// <= as_of is inside the owner's counted drawer BY DEFINITION; only
// events strictly AFTER as_of compose on top. Nothing double-counts.

const { depositsLive } = require('./deposits');
const { wsTz, toZonedISO } = require('./time-helpers');

function legacyDollarsToCents(v) {
  return Math.round(Number(v || 0) * 100);
}

// Period boundaries computed in the WORKSPACE's timezone: [start, end)
// as UTC instants, plus the matching YYYY-MM-DD strings for the legacy
// TEXT-date feeds (lexical compare is safe on ISO dates).
function resolvePeriod({ workspace, period, start, end, now }) {
  const tz = wsTz(workspace);
  const nowDate = now ? new Date(now) : new Date();
  const todayLocal = nowDate.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const [y, m] = todayLocal.split('-').map(Number);

  if (period === 'custom' && start && end) {
    const s = String(start).slice(0, 10);
    const e = String(end).slice(0, 10);
    return {
      kind: 'custom',
      startIso: toZonedISO(s + 'T00:00:00', tz),
      endIso: toZonedISO(e + 'T00:00:00', tz),
      startDate: s,
      endDate: e,
    };
  }
  if (period === 'quarter') {
    const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
    const sD = `${y}-${String(qStartMonth).padStart(2, '0')}-01`;
    const eY = qStartMonth + 3 > 12 ? y + 1 : y;
    const eM = qStartMonth + 3 > 12 ? 1 : qStartMonth + 3;
    const eD = `${eY}-${String(eM).padStart(2, '0')}-01`;
    return { kind: 'quarter', startIso: toZonedISO(sD + 'T00:00:00', tz), endIso: toZonedISO(eD + 'T00:00:00', tz), startDate: sD, endDate: eD };
  }
  // month (default)
  const sD = `${y}-${String(m).padStart(2, '0')}-01`;
  const eY = m === 12 ? y + 1 : y;
  const eM = m === 12 ? 1 : m + 1;
  const eD = `${eY}-${String(eM).padStart(2, '0')}-01`;
  return { kind: 'month', startIso: toZonedISO(sD + 'T00:00:00', tz), endIso: toZonedISO(eD + 'T00:00:00', tz), startDate: sD, endDate: eD };
}

// PS money-in over [startIso, endIso): completed ledger rows, split
// real vs stripe-origin. Same workspace-scoped SUM shape as the PS
// dashboard's revenue aggregate (server.js ~2594), against the ledger
// rows rather than the rollup so partial payments count exactly once.
async function psMoneyIn(db, workspaceId, startIso, endIso) {
  // BG4: the deposit split rides the same query — deposits are IN the
  // sum (they always were; payment_type was never filtered) and now
  // carry a labeled sub-total so the dashboard can say "deposits
  // collected" apart from full payments. The stripe-typed splits let
  // the demo gate exclude test deposits from the REAL deposit figure.
  const r = await db.query(
    `SELECT
        COALESCE(SUM(amount_cents), 0)::int AS total,
        COALESCE(SUM(amount_cents) FILTER (WHERE payment_method = 'stripe'), 0)::int AS stripe,
        COALESCE(SUM(amount_cents) FILTER (WHERE payment_type = 'deposit'), 0)::int AS deposits,
        COALESCE(SUM(amount_cents) FILTER (WHERE payment_type = 'deposit' AND payment_method = 'stripe'), 0)::int AS deposits_stripe
       FROM transaction_payments
      WHERE workspace_id = $1 AND status = 'completed'
        AND created_at >= $2 AND created_at < $3`,
    [workspaceId, startIso, endIso]
  );
  const row = r.rows[0] || { total: 0, stripe: 0, deposits: 0, deposits_stripe: 0 };
  return { total: row.total, stripe: row.stripe, deposits: row.deposits || 0, deposits_stripe: row.deposits_stripe || 0 };
}

// Legacy PM rent money-in: user-scoped dollars ×100 at read. The paid
// date is the row's paid_date (TEXT), falling back to due_date.
async function pmRentIn(db, ownerUserId, startDate, endDate) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS s
       FROM rent_payments
      WHERE user_id = $1 AND status = 'paid'
        AND COALESCE(NULLIF(paid_date, ''), due_date) >= $2
        AND COALESCE(NULLIF(paid_date, ''), due_date) < $3`,
    [ownerUserId, startDate, endDate]
  );
  return legacyDollarsToCents(r.rows[0] ? r.rows[0].s : 0);
}

// Legacy PM expenses (budget_transactions type='expense'): read-through
// until BG2's expenses table supersedes it; also feeds by_category.
async function legacyExpensesOut(db, ownerUserId, startDate, endDate) {
  const r = await db.query(
    `SELECT COALESCE(category, 'Other') AS category, COALESCE(SUM(amount), 0)::numeric AS s
       FROM budget_transactions
      WHERE user_id = $1 AND type = 'expense'
        AND date >= $2 AND date < $3
      GROUP BY COALESCE(category, 'Other')
      ORDER BY 2 DESC`,
    [ownerUserId, startDate, endDate]
  );
  const by_category = r.rows.map((row) => ({
    category: row.category,
    cents: legacyDollarsToCents(row.s),
    source: 'legacy',
  }));
  const total = by_category.reduce((a, c) => a + c.cents, 0);
  return { total, by_category };
}

// TR2 (G1): legacy PM INCOME — budget_transactions type='income'.
// These rows existed live (4 of them at discovery) and were invisible
// to every reader: legacyExpensesOut and the ledger both filtered
// type='expense'. Money-in the owner recorded must appear wherever
// money-in appears — summary, ledger, export, and the anchor math.
async function legacyIncomeIn(db, ownerUserId, startDate, endDate) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS s
       FROM budget_transactions
      WHERE user_id = $1 AND type = 'income'
        AND date >= $2 AND date < $3`,
    [ownerUserId, startDate, endDate]
  );
  return legacyDollarsToCents(r.rows[0] ? r.rows[0].s : 0);
}

// BG2: the REAL money-out feed — the expenses table, workspace-scoped
// cents, grouped by category with source 'expenses'. Coexists with the
// legacy read-through above: separate tables, separate sums, both
// reported — no row can be counted twice because no row lives twice.
async function expensesOut(db, workspaceId, startDate, endDate) {
  const r = await db.query(
    `SELECT category, COALESCE(SUM(amount_cents), 0)::int AS s
       FROM expenses
      WHERE workspace_id = $1
        AND spent_on >= $2::date AND spent_on < $3::date
      GROUP BY category
      ORDER BY 2 DESC`,
    [workspaceId, startDate, endDate]
  );
  const by_category = r.rows.map((row) => ({ category: row.category, cents: row.s, source: 'expenses' }));
  const total = by_category.reduce((a, c) => a + c.cents, 0);
  return { total, by_category };
}

async function computeFinancesSummary({ db, workspace, period, start, end, env, now }) {
  const p = resolvePeriod({ workspace, period, start, end, now });
  const live = depositsLive(env);
  const wsId = workspace.id;
  const owner = workspace.owner_user_id;

  const ps = await psMoneyIn(db, wsId, p.startIso, p.endIso);
  const pmRent = await pmRentIn(db, owner, p.startDate, p.endDate);
  const legacyIncome = await legacyIncomeIn(db, owner, p.startDate, p.endDate);
  const legacyOut = await legacyExpensesOut(db, owner, p.startDate, p.endDate);
  const realOut = await expensesOut(db, wsId, p.startDate, p.endDate);

  // Demo split: test-mode Stripe money is reported, never counted real.
  const demo = live ? 0 : ps.stripe;
  const psReal = ps.total - demo;
  // BG4: real deposits — test-mode stripe deposits are demo money and
  // leave the labeled figure too (a demo deposit is not "collected").
  const depositsReal = ps.deposits - (live ? 0 : ps.deposits_stripe);
  // TR2 (G1): legacy income joins the combined figure — same
  // read-through treatment as legacy rent and legacy expenses.
  const moneyInCombined = psReal + pmRent + legacyIncome;

  // BG2: the real feed is live. Legacy PM expenses stay read-through
  // (labeled legacy) so old history shows alongside — new expenses in
  // the real table, both visible, never double-counted (§7).
  const expensesCents = realOut.total;
  const moneyOutCombined = expensesCents + legacyOut.total;

  // Anchor + cash_current. Half-open: strictly AFTER as_of (see header).
  let anchor = null;
  let cash_current_cents = null;
  try {
    const aR = await db.query(
      `SELECT amount_cents, as_of FROM budget_anchors
        WHERE workspace_id = $1 ORDER BY as_of DESC LIMIT 1`,
      [wsId]
    );
    if (aR.rows[0]) {
      anchor = { amount_cents: aR.rows[0].amount_cents, as_of: aR.rows[0].as_of };
      const inR = await db.query(
        `SELECT
            COALESCE(SUM(amount_cents), 0)::int AS total,
            COALESCE(SUM(amount_cents) FILTER (WHERE payment_method = 'stripe'), 0)::int AS stripe
           FROM transaction_payments
          WHERE workspace_id = $1 AND status = 'completed' AND created_at > $2`,
        [wsId, anchor.as_of]
      );
      const inRow = inR.rows[0] || { total: 0, stripe: 0 };
      const inSincePs = live ? inRow.total : inRow.total - inRow.stripe;
      const anchorDate = new Date(anchor.as_of).toLocaleDateString('en-CA', { timeZone: wsTz(workspace) });
      const rentSince = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS s
           FROM rent_payments
          WHERE user_id = $1 AND status = 'paid'
            AND COALESCE(NULLIF(paid_date, ''), due_date) > $2`,
        [owner, anchorDate]
      );
      const outSince = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS s
           FROM budget_transactions
          WHERE user_id = $1 AND type = 'expense' AND date > $2`,
        [owner, anchorDate]
      );
      // TR2 (G1): income-since joins the cash math with the same
      // strict > boundary — the ledger showing income rows while the
      // cash figure ignored them would be a new inconsistency.
      const incSince = await db.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS s
           FROM budget_transactions
          WHERE user_id = $1 AND type = 'income' AND date > $2`,
        [owner, anchorDate]
      );
      // BG2: real expenses join the out-since sum — same strict > as
      // every other anchor query (half-open at as_of).
      const expSince = await db.query(
        `SELECT COALESCE(SUM(amount_cents), 0)::int AS s
           FROM expenses
          WHERE workspace_id = $1 AND spent_on > $2::date`,
        [wsId, anchorDate]
      );
      cash_current_cents = anchor.amount_cents
        + inSincePs
        + legacyDollarsToCents(rentSince.rows[0] ? rentSince.rows[0].s : 0)
        + legacyDollarsToCents(incSince.rows[0] ? incSince.rows[0].s : 0)
        - legacyDollarsToCents(outSince.rows[0] ? outSince.rows[0].s : 0)
        - (expSince.rows[0] ? expSince.rows[0].s : 0);
    }
  } catch (err) {
    (console).error('[finances-summary] anchor math failed (cash omitted):', err.message);
    anchor = null;
    cash_current_cents = null;
  }

  // Goal for this period kind, when one exists.
  let goal = null;
  try {
    const gR = await db.query(
      `SELECT id, type, label, target_cents, period FROM budget_goals
        WHERE workspace_id = $1 AND active = TRUE AND period = $2
        ORDER BY id DESC LIMIT 1`,
      [wsId, p.kind === 'custom' ? 'once' : p.kind]
    );
    if (gR.rows[0]) {
      const g = gR.rows[0];
      goal = {
        id: g.id, type: g.type, label: g.label, target_cents: g.target_cents, period: g.period,
        progress_cents: moneyInCombined,
        progress_pct: g.target_cents > 0 ? Math.round((moneyInCombined / g.target_cents) * 100) : null,
      };
    }
  } catch (err) {
    (console).error('[finances-summary] goal read failed (omitted):', err.message);
  }

  return {
    unit: 'integer cents (USD)',
    period: { kind: p.kind, start: p.startIso, end: p.endIso },
    live_mode: live,
    money_in: {
      ps_cents: psReal,
      pm_rent_legacy_cents: pmRent,
      // TR2 (G1): additive — the once-invisible legacy income rows.
      legacy_budget_income_cents: legacyIncome,
      // BG4: additive — of ps_cents, how much arrived as deposits.
      deposits_cents: depositsReal,
      combined_cents: moneyInCombined,
    },
    money_in_demo_cents: demo,
    money_out: {
      expenses_cents: expensesCents,
      legacy_budget_expense_cents: legacyOut.total,
      combined_cents: moneyOutCombined,
    },
    net_cents: moneyInCombined - moneyOutCombined,
    cash_current_cents,
    anchor,
    goal,
    by_category: [...realOut.by_category, ...legacyOut.by_category],
  };
}

// BG8: the unified ledger — BOTH sides, row-level, same feeds and same
// period boundaries as the summary above, so the ledger and the
// dashboard CANNOT disagree (the totals-match gate proves it). Demo
// rows (test-mode Stripe) are shown but labeled, and excluded from the
// real in-total exactly as the summary excludes them.
// `now` threads to resolvePeriod exactly as computeFinancesSummary's
// does — the ledger and the summary must resolve the SAME window from
// the SAME clock, or "one truth" quietly becomes two under a pinned or
// skewed clock. Omitted in production callers: real clock, unchanged.
async function composeLedgerRows({ db, workspace, period, start, end, env, direction, category, source, now }) {
  const p = resolvePeriod({ workspace, period, start, end, now });
  const live = depositsLive(env);
  const wsId = workspace.id;
  const owner = workspace.owner_user_id;
  const tz = wsTz(workspace);
  const localDate = (ts) => {
    try { return new Date(ts).toLocaleDateString('en-CA', { timeZone: tz }); }
    catch (err) { return String(ts).slice(0, 10); }
  };
  const rows = [];

  const wantSource = (s) => !source || source === s;

  if (wantSource('ledger')) {
    const r = await db.query(
      `SELECT tp.id AS payment_id, tp.transaction_id, tp.amount_cents,
              tp.payment_type, tp.payment_method, tp.created_at,
              t.customer_display_name
         FROM transaction_payments tp
         LEFT JOIN transactions t ON t.id = tp.transaction_id
        WHERE tp.workspace_id = $1 AND tp.status = 'completed'
          AND tp.created_at >= $2 AND tp.created_at < $3
        ORDER BY tp.created_at DESC
        LIMIT 1000`,
      [wsId, p.startIso, p.endIso]
    );
    for (const x of r.rows) {
      rows.push({
        date: localDate(x.created_at),
        direction: 'in',
        description: x.customer_display_name || 'Customer payment',
        category: x.payment_type === 'deposit' ? 'Deposit' : 'Payment',
        source: 'ledger',
        demo: !live && x.payment_method === 'stripe',
        amount_cents: x.amount_cents,
        // TR2: cash events reference their source document (the ruling:
        // row = cash event, transaction id as reference). Additive —
        // existing consumers ignore it.
        customer: x.customer_display_name || null,
        payment_method: x.payment_method,
        ref: { kind: 'payment', id: x.payment_id, transaction_id: x.transaction_id },
      });
    }
  }
  if (wantSource('legacy_rent')) {
    const r = await db.query(
      `SELECT id, resident, unit, amount,
              COALESCE(NULLIF(paid_date, ''), due_date) AS d
         FROM rent_payments
        WHERE user_id = $1 AND status = 'paid'
          AND COALESCE(NULLIF(paid_date, ''), due_date) >= $2
          AND COALESCE(NULLIF(paid_date, ''), due_date) < $3
        ORDER BY 5 DESC
        LIMIT 1000`,
      [owner, p.startDate, p.endDate]
    );
    for (const x of r.rows) {
      rows.push({
        date: x.d,
        direction: 'in',
        description: (x.resident || 'Rent') + (x.unit ? ' — Unit ' + x.unit : ''),
        category: 'Rent',
        source: 'legacy_rent',
        demo: false,
        amount_cents: legacyDollarsToCents(x.amount),
        customer: x.resident || null,
        ref: { kind: 'rent_payment', id: x.id },
      });
    }
  }
  if (wantSource('expenses')) {
    const r = await db.query(
      `SELECT id, amount_cents, category, description, vendor, spent_on, source AS row_source
         FROM expenses
        WHERE workspace_id = $1
          AND spent_on >= $2::date AND spent_on < $3::date
        ORDER BY spent_on DESC
        LIMIT 1000`,
      [wsId, p.startDate, p.endDate]
    );
    for (const x of r.rows) {
      rows.push({
        date: String(x.spent_on).slice(0, 10),
        direction: 'out',
        description: x.vendor || x.description || 'Expense',
        category: x.category || 'Other',
        source: 'expenses',
        demo: false,
        amount_cents: x.amount_cents,
        ref: { kind: 'expense', id: x.id },
      });
    }
  }
  if (wantSource('legacy_budget')) {
    // TR2 (G1): BOTH types now. Income rows were invisible to every
    // reader until TR1 found 4 of them live — they join as
    // direction='in' with the same source label.
    const r = await db.query(
      `SELECT id, amount, category, description, date, type
         FROM budget_transactions
        WHERE user_id = $1 AND type IN ('expense', 'income')
          AND date >= $2 AND date < $3
        ORDER BY date DESC
        LIMIT 1000`,
      [owner, p.startDate, p.endDate]
    );
    for (const x of r.rows) {
      const isIncome = x.type === 'income';
      rows.push({
        date: x.date,
        direction: isIncome ? 'in' : 'out',
        description: x.description || (isIncome ? 'Income' : 'Expense'),
        category: x.category || (isIncome ? 'Income' : 'Other'),
        source: 'legacy_budget',
        demo: false,
        amount_cents: legacyDollarsToCents(x.amount),
        ref: { kind: 'legacy_budget', id: x.id },
      });
    }
  }

  let filtered = rows;
  if (direction === 'in' || direction === 'out') filtered = filtered.filter((r) => r.direction === direction);
  if (category) filtered = filtered.filter((r) => r.category === category);
  filtered.sort((a, b) => b.date.localeCompare(a.date));

  // Totals over the FULL filtered set (before the row cap). Real in
  // excludes demo, matching the summary's arithmetic exactly.
  const totals = {
    in_cents: filtered.filter((r) => r.direction === 'in' && !r.demo).reduce((a, r) => a + r.amount_cents, 0),
    out_cents: filtered.filter((r) => r.direction === 'out').reduce((a, r) => a + r.amount_cents, 0),
    demo_cents: filtered.filter((r) => r.direction === 'in' && r.demo).reduce((a, r) => a + r.amount_cents, 0),
  };
  totals.net_cents = totals.in_cents - totals.out_cents;

  const capped = filtered.length > 500;
  return {
    unit: 'integer cents (USD)',
    period: { kind: p.kind, start: p.startIso, end: p.endIso },
    live_mode: live,
    rows: filtered.slice(0, 500),
    totals,
    total_rows: filtered.length,
    capped,
  };
}

module.exports = { computeFinancesSummary, composeLedgerRows, resolvePeriod, legacyDollarsToCents };

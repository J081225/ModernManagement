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
  const r = await db.query(
    `SELECT
        COALESCE(SUM(amount_cents), 0)::int AS total,
        COALESCE(SUM(amount_cents) FILTER (WHERE payment_method = 'stripe'), 0)::int AS stripe
       FROM transaction_payments
      WHERE workspace_id = $1 AND status = 'completed'
        AND created_at >= $2 AND created_at < $3`,
    [workspaceId, startIso, endIso]
  );
  const row = r.rows[0] || { total: 0, stripe: 0 };
  return { total: row.total, stripe: row.stripe };
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
  const legacyOut = await legacyExpensesOut(db, owner, p.startDate, p.endDate);
  const realOut = await expensesOut(db, wsId, p.startDate, p.endDate);

  // Demo split: test-mode Stripe money is reported, never counted real.
  const demo = live ? 0 : ps.stripe;
  const psReal = ps.total - demo;
  const moneyInCombined = psReal + pmRent;

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

module.exports = { computeFinancesSummary, resolvePeriod, legacyDollarsToCents };

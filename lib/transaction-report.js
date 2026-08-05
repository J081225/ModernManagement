// lib/transaction-report.js — TR2.
//
// The transaction-history report read-model. A VIEW over
// composeLedgerRows — the TR1 one-source-of-truth ruling: the report
// must never be a third query stack that could drift from the ledger
// and the dashboard. Every row here IS a ledger row (cash event, per
// the row-model ruling), regrouped and subtotaled.
//
// Rulings encoded here:
//   - Row = cash event; refs carry the source-document ids
//     (transaction id for PS payments) that composeLedgerRows now
//     attaches.
//   - Real-only by DEFAULT: test/demo rows (test-mode Stripe) are
//     excluded unless include_test — and their count/sum is reported
//     so the UI can say "N test rows hidden" instead of hiding money
//     silently.
//   - Grouping: month (default) | customer | category, each group
//     with in/out/net subtotals. Month keys sort newest-first;
//     customer/category groups sort by absolute money volume.
//
// `now` threads through to composeLedgerRows/resolvePeriod exactly as
// the summary's does — one clock, one window (the AD4 lesson).

const { composeLedgerRows } = require('./finances-summary');

const GROUP_KINDS = ['month', 'customer', 'category'];

function monthLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return String(ym);
  const NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return NAMES[m - 1] + ' ' + y;
}

function groupKeyOf(row, groupBy) {
  if (groupBy === 'customer') return row.customer || row.description || 'Unknown';
  if (groupBy === 'category') return row.category || 'Other';
  return String(row.date).slice(0, 7); // YYYY-MM
}

function subtotalsOf(rows) {
  const s = { in_cents: 0, out_cents: 0, net_cents: 0, count: rows.length };
  for (const r of rows) {
    if (r.direction === 'in') s.in_cents += r.amount_cents;
    else s.out_cents += r.amount_cents;
  }
  s.net_cents = s.in_cents - s.out_cents;
  return s;
}

async function composeTransactionReport({
  db, workspace, period, start, end, env, now,
  direction, category, source, customer,
  include_test = false,
  group_by = 'month',
}) {
  const groupBy = GROUP_KINDS.includes(group_by) ? group_by : 'month';

  // One source of truth: the ledger composes, the report arranges.
  const ledger = await composeLedgerRows({
    db, workspace, period, start, end, env, direction, category, source, now,
  });

  let rows = ledger.rows;

  // The customer filter is the report's own (the ledger has no such
  // dimension): case-insensitive substring over customer/description.
  if (customer) {
    const needle = String(customer).toLowerCase();
    rows = rows.filter((r) =>
      String(r.customer || r.description || '').toLowerCase().includes(needle));
  }

  // Real-only default — hidden test money is COUNTED and reported,
  // never silently vanished.
  const testRows = rows.filter((r) => r.demo);
  if (!include_test) rows = rows.filter((r) => !r.demo);

  // Group, preserving the ledger's newest-first row order inside each.
  const byKey = new Map();
  for (const r of rows) {
    const k = groupKeyOf(r, groupBy);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const groups = [...byKey.entries()].map(([key, groupRows]) => ({
    key,
    label: groupBy === 'month' ? monthLabel(key) : key,
    rows: groupRows,
    subtotals: subtotalsOf(groupRows),
  }));
  if (groupBy === 'month') {
    groups.sort((a, b) => b.key.localeCompare(a.key)); // newest month first
  } else {
    groups.sort((a, b) =>
      (b.subtotals.in_cents + b.subtotals.out_cents) - (a.subtotals.in_cents + a.subtotals.out_cents));
  }

  // Totals over exactly the rows THIS report contains — the report can
  // never disagree with its own groups. The ledger's capped flag rides
  // along so a >500-row window is surfaced, not silently truncated.
  const totals = subtotalsOf(rows);

  return {
    unit: 'integer cents (USD)',
    period: ledger.period,
    live_mode: ledger.live_mode,
    group_by: groupBy,
    include_test,
    groups,
    totals,
    hidden_test: include_test
      ? { count: 0, cents: 0 }
      : { count: testRows.length, cents: testRows.reduce((a, r) => a + r.amount_cents, 0) },
    total_rows: rows.length,
    source_total_rows: ledger.total_rows,
    capped: ledger.capped,
  };
}

module.exports = { composeTransactionReport, monthLabel };

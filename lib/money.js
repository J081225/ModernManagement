// lib/money.js — TR2.
//
// THE shared cents formatter. TR1 inventoried ~25 independent money-
// formatting sites (inline (cents/100).toFixed(2), per-file helpers,
// toLocaleString variants); the TR ruling: TR introduces ONE formatter
// and every TR surface uses it exclusively. Migrating the legacy sites
// is follow-up work, not TR scope — but nothing new may format money
// any other way.
//
// Storage is integer cents everywhere (BG's B13 pin rejects float
// dollars at the door). These functions are the display boundary.

// formatCents(123456)        -> '$1,234.56'
// formatCents(-950)          -> '-$9.50'
// formatCents(0)             -> '$0.00'
// formatCents(null/undefined/NaN) -> '—' (an honest dash, never $NaN)
function formatCents(cents) {
  if (!Number.isFinite(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rem = String(abs % 100).padStart(2, '0');
  return sign + '$' + dollars + '.' + rem;
}

// centsToDecimal(123456) -> '1234.56' — CSV/plain contexts: no symbol,
// no thousands separators (spreadsheets parse it as a number).
function centsToDecimal(cents) {
  if (!Number.isFinite(cents)) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

module.exports = { formatCents, centsToDecimal };

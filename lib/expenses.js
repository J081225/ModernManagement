// lib/expenses.js — BG2. The money-out policy module: the category
// set, cents-only validation shared by POST/PATCH, and the invoice
// paid-state bridge. CENTS ONLY — the one place dollars appear is the
// legacy invoice bridge, converted ×100 exactly once at bridge time
// via the same helper the summary layer uses.

const { legacyDollarsToCents } = require('./finances-summary');

// Small fixed set to start (finances-investigation §8-CP2), extendable
// later. Free-text description carries the specifics.
const EXPENSE_CATEGORIES = ['Supplies', 'Payroll', 'Rent', 'Utilities', 'Marketing', 'Fees', 'Other'];
const EXPENSE_SOURCES = ['manual', 'ai_confirmed', 'invoice'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates a create/update payload. `partial: true` (PATCH) accepts a
// subset; create requires amount_cents + spent_on. Returns
// { ok, error?, value? } — value carries only recognized fields.
// CENTS ONLY: amount_cents must be a positive INTEGER — 84.5 (dollars
// as float) is rejected, never rounded; the caller converts at the
// input edge or doesn't get in.
function validateExpenseInput(body, { partial = false } = {}) {
  const b = body || {};
  const out = {};

  if (Object.prototype.hasOwnProperty.call(b, 'amount_cents') || !partial) {
    const a = b.amount_cents;
    if (typeof a !== 'number' || !Number.isInteger(a) || a <= 0) {
      return { ok: false, error: 'amount_cents must be a positive integer (cents, never dollars)' };
    }
    out.amount_cents = a;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'category') || !partial) {
    const c = b.category == null || b.category === '' ? 'Other' : String(b.category);
    if (!EXPENSE_CATEGORIES.includes(c)) {
      return { ok: false, error: `category must be one of ${EXPENSE_CATEGORIES.join(', ')}` };
    }
    out.category = c;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'spent_on') || !partial) {
    const d = String(b.spent_on || '');
    if (!DATE_RE.test(d) || isNaN(new Date(d + 'T00:00:00Z').getTime())) {
      return { ok: false, error: 'spent_on must be a real YYYY-MM-DD date' };
    }
    out.spent_on = d;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'description')) out.description = String(b.description || '').slice(0, 500);
  if (Object.prototype.hasOwnProperty.call(b, 'vendor')) out.vendor = String(b.vendor || '').slice(0, 200);
  if (Object.prototype.hasOwnProperty.call(b, 'contact_id')) {
    out.contact_id = b.contact_id == null ? null : parseInt(b.contact_id, 10) || null;
  }
  if (partial && Object.keys(out).length === 0) {
    return { ok: false, error: 'No fields to update' };
  }
  return { ok: true, value: out };
}

// BG2 commit 5 — the invoice paid-state bridge. A paid bill becomes
// real money-out: one expense row (source 'invoice', invoice_id set,
// legacy dollars ×100 at bridge time). Idempotent by invoice_id — a
// second mark-paid can never double the money-out. Both writes in one
// BEGIN/COMMIT via the passed client.
async function bridgeInvoiceToExpense(client, { workspaceId, invoice, userId, spentOn }) {
  const existing = await client.query(
    `SELECT id FROM expenses WHERE workspace_id = $1 AND invoice_id = $2 LIMIT 1`,
    [workspaceId, invoice.id]
  );
  if (existing.rows.length) {
    return { bridged: false, expense_id: existing.rows[0].id, reason: 'already_bridged' };
  }
  const cents = legacyDollarsToCents(invoice.amount);
  if (!Number.isInteger(cents) || cents <= 0) {
    return { bridged: false, reason: 'invoice_amount_invalid' };
  }
  const r = await client.query(
    `INSERT INTO expenses
       (workspace_id, amount_cents, category, description, vendor, spent_on, source, invoice_id, created_by)
     VALUES ($1, $2, 'Other', $3, $4, $5, 'invoice', $6, $7)
     RETURNING id`,
    [workspaceId, cents,
      invoice.description || `Invoice #${invoice.id}`,
      invoice.vendor || null, spentOn, invoice.id, userId]
  );
  return { bridged: true, expense_id: r.rows[0].id, amount_cents: cents };
}

module.exports = { EXPENSE_CATEGORIES, EXPENSE_SOURCES, validateExpenseInput, bridgeInvoiceToExpense };

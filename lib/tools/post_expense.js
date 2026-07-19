// lib/tools/post_expense.js — BG5 commit 1.
//
// The brain's money-out entry: "I paid the towel vendor $200 for
// supplies" becomes an approval chip, never an instant silent write.
// requiresApproval: true — the owner's Approve IS "yes, this came out
// of the budget" (finances-investigation §5); execution then writes
// ONE expenses row via BG2's validation, source 'ai_confirmed'.
//
// AUTONOMY LANE (stated per the BG5 spec): 'payments' — the existing,
// VISIBLE matrix row — not a new hidden 'finances' category. Three
// reasons: requiresApproval already makes 'act' impossible (the lane
// can only queue or decline, exactly what the two-position payments
// row tells the owner); the matrix governs only the CUSTOMER engine,
// where this tool is unreachable anyway (not in the allowlist —
// customers never post expenses to the business); and a category the
// matrix UI doesn't render would be a control the owner can't see.
//
// OWNER-ONLY: vertical 'core' (both verticals — BG2's expenses serve
// both), never added to APPOINTMENT_TOOL_NAMES. Boundary proven in
// the BG5 suite: the engine never OFFERS it, and even a forged
// tool_use block from an ai_inbound ctx can only queue (FD2 property).

const registry = require('../tool-registry');
const { validateExpenseInput } = require('../expenses');
const { wsToday } = require('../time-helpers');

registry.register({
  name: 'post_expense',
  description: "Record a business expense in the budget ledger (money OUT). Use when the owner says they paid for something — a vendor, supplies, rent, a bill. amount_cents must be INTEGER CENTS (e.g. $200 = 20000). Queues for the owner's approval; approving posts it to the expenses ledger.",
  vertical: 'core',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      amount_cents: { type: 'integer', description: 'The amount in integer cents. $84.50 = 8450. Never dollars, never a float.' },
      category: { type: 'string', enum: ['Supplies', 'Payroll', 'Rent', 'Utilities', 'Marketing', 'Fees', 'Other'], description: "Expense category. Use 'Other' when unsure." },
      vendor: { type: 'string', description: 'Optional. Who was paid.' },
      description: { type: 'string', description: 'What the expense was for.' },
      spent_on: { type: 'string', description: 'Optional YYYY-MM-DD. Defaults to today in the business timezone.' },
    },
    required: ['amount_cents', 'category'],
  },
  navigationPolicy: 'auto',
  navigateTo: '/finances',
  requiresApproval: true,
  async execute(input, ctx) {
    // Same validator as the BG2 endpoints — cents only, real dates,
    // the fixed category set. A float that survived the schema dies
    // here.
    const v = validateExpenseInput({
      amount_cents: input.amount_cents,
      category: input.category,
      spent_on: input.spent_on || wsToday(ctx.workspace),
      vendor: input.vendor,
      description: input.description,
    });
    if (!v.ok) return { success: false, message: v.error };
    const e = v.value;
    try {
      const r = await ctx.db.query(
        `INSERT INTO expenses
           (workspace_id, amount_cents, category, description, vendor, spent_on, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'ai_confirmed', $7)
         RETURNING id`,
        [ctx.workspace.id, e.amount_cents, e.category, e.description || null,
          e.vendor || null, e.spent_on, ctx.user.id]
      );
      const dollars = (e.amount_cents / 100).toFixed(2);
      return {
        success: true,
        data: { expense_id: r.rows[0].id },
        message: `Posted $${dollars} to ${e.category}${e.vendor ? ` (${e.vendor})` : ''}.`,
      };
    } catch (err) {
      ctx.logger.error('[post_expense] INSERT failed:', err.message);
      return { success: false, message: `Could not post the expense: ${err.message}` };
    }
  },
});

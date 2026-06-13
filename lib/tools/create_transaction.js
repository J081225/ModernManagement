// lib/tools/create_transaction.js
//
// Create a transaction in 'draft' or 'pending' state. Used for walk-ins,
// product sales, or any manual creation. NOT used for appointment
// completions — that path is auto-created by complete_appointment.
//
// Workspace-scoped (transactions table). The contact_id (if provided) is
// soft-linked; we do not enforce it because contacts is user_id-scoped
// (legacy table). The customer_display_name is always populated, so the
// transaction is readable even if a contact link is missing.
//
// Totals are always recomputed server-side from line_items × quantity ×
// unit_price_cents — never trust caller-provided totals.

const registry = require('../tool-registry');
const paymentLedger = require('../payment-ledger');

function computeLineTotal(item) {
  const qty = Math.max(0, parseInt(item.quantity, 10) || 1);
  const unit = parseInt(item.unit_price_cents, 10) || 0;
  return qty * unit;
}

registry.register({
  name: 'create_transaction',
  description: 'Create a transaction (sale, walk-in, product sale, or manual income). Use this when the user wants to record a payment that did NOT come from an appointment completion. Provide line items, optional tax/tip/discount, and payment method. Totals are calculated automatically from line items.',
  vertical: 'professional-services',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      customer_name: { type: 'string', description: 'Customer name (use "Walk-in" if unknown).' },
      contact_id: { type: 'integer', description: 'Optional contact ID if the customer is on file.' },
      line_items: {
        type: 'array',
        description: 'Array of {description, quantity, unit_price_cents, type?}. Total per item computed server-side.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'integer' },
            unit_price_cents: { type: 'integer' },
            type: { type: 'string', description: 'service, product, addon, fee, or other' },
          },
        },
      },
      tax_cents: { type: 'integer' },
      tip_cents: { type: 'integer' },
      discount_cents: { type: 'integer' },
      amount_paid_cents: { type: 'integer' },
      payment_method: { type: 'string', description: 'cash, card, venmo, zelle, gift_card, other, or unpaid' },
      notes_internal: { type: 'string' },
      notes_customer: { type: 'string' },
      source: { type: 'string', description: 'walk_in, product_sale, or manual (defaults to manual)' },
    },
    required: ['customer_name'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const customer_name = (input.customer_name || '').trim() || 'Walk-in';
    const lineItemsIn = Array.isArray(input.line_items) ? input.line_items : [];
    const tax_cents = parseInt(input.tax_cents, 10) || 0;
    const tip_cents = parseInt(input.tip_cents, 10) || 0;
    const discount_cents = parseInt(input.discount_cents, 10) || 0;
    const payment_method = input.payment_method || null;
    const source = input.source && ['walk_in', 'product_sale', 'manual'].includes(input.source)
      ? input.source : 'manual';

    // Normalize line items + compute per-line totals
    const line_items = lineItemsIn.map(it => {
      const total_cents = computeLineTotal(it);
      return {
        description: String(it.description || 'Item'),
        quantity: Math.max(1, parseInt(it.quantity, 10) || 1),
        unit_price_cents: parseInt(it.unit_price_cents, 10) || 0,
        total_cents,
        type: it.type || 'other',
      };
    });

    const subtotal_cents = line_items.reduce((s, i) => s + i.total_cents, 0);
    const total_cents = Math.max(0, subtotal_cents + tax_cents + tip_cents - discount_cents);
    const amount_paid_cents = input.amount_paid_cents != null
      ? parseInt(input.amount_paid_cents, 10)
      : 0;

    // E14: INSERT + ledger + recompute run on ONE dedicated client inside
    // ONE BEGIN/COMMIT so a mid-sequence failure can't leave a transaction
    // row without its backing ledger row (or vice versa).
    const client = await ctx.db.connect();
    let tx;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO transactions
           (workspace_id, contact_id, customer_display_name, line_items,
            subtotal_cents, tax_cents, tip_cents, discount_cents, total_cents,
            amount_paid_cents, payment_method, status, source,
            notes_internal, notes_customer, created_by_user_id,
            payment_received_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,0,$10,'draft',$11,$12,$13,$14,NULL)
         RETURNING id, total_cents, status`,
        [
          ctx.workspace.id,
          input.contact_id || null,
          customer_name,
          JSON.stringify(line_items),
          subtotal_cents, tax_cents, tip_cents, discount_cents, total_cents,
          payment_method, source,
          input.notes_internal || null,
          input.notes_customer || null,
          ctx.user.id,
        ]
      );
      tx = r.rows[0];

      if (amount_paid_cents > 0) {
        await paymentLedger.recordPayment(client, {
          workspace_id: ctx.workspace.id,
          transaction_id: tx.id,
          amount_cents: amount_paid_cents,
          payment_type: 'payment',
          payment_method: payment_method || 'cash',
          status: 'completed',
          created_by_user_id: ctx.user.id,
        });
        const rolled = await paymentLedger.recomputeTransactionPaidStatus(client, tx.id);
        if (rolled) tx = { id: tx.id, total_cents: rolled.total_cents, status: rolled.status };
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* best-effort */ }
      ctx.logger.error('[create_transaction] insert failed:', err.message);
      return { success: false, message: `Could not create transaction: ${err.message}` };
    } finally {
      client.release();
    }

    return {
      success: true,
      data: { transaction_id: tx.id, total_cents: tx.total_cents, status: tx.status },
      message: `Created transaction #${tx.id} for ${customer_name}: $${(tx.total_cents / 100).toFixed(2)} (${tx.status}).`,
    };
  },
});

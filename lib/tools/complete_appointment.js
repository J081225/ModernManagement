// lib/tools/complete_appointment.js
//
// Marks an appointment completed and optionally records final price /
// payment.
//
// E3 enhancement (this is the ONE allowed lib/tools/ modification beyond
// add_calendar_event from E2): now auto-creates a draft transaction with
// the booked service as the line item. The transaction lands in the
// Finances → Transactions list for Sarah to review and finalize.
//
// Failure of the transaction creation does NOT fail the appointment
// completion. The appointment is canonical; the transaction is a side
// effect. We log on failure and return success without draft_transaction_id.

const registry = require('../tool-registry');
const paymentLedger = require('../payment-ledger');

registry.register({
  name: 'complete_appointment',
  description: 'Mark an appointment as completed. Sets status="completed" and stamps completed_at. Optionally records final price, amount paid, payment method, and tip. Auto-creates a draft transaction (E3) with the booked service as a line item; this draft lands in Finances → Transactions for review.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'integer' },
      final_price_cents: { type: 'integer' },
      amount_paid_cents: { type: 'integer' },
      payment_method: { type: 'string', description: 'cash, card, venmo, zelle, gift_card, other, or unpaid.' },
      tip_cents: { type: 'integer', description: 'Tip received at completion. Added to the auto-created draft transaction.' },
    },
    required: ['appointment_id'],
  },
  navigationPolicy: 'auto',
  navigateTo: '/calendar',
  requiresApproval: false,
  async execute(input, ctx) {
    const { appointment_id, final_price_cents, amount_paid_cents, payment_method } = input;
    if (!appointment_id) return { success: false, message: 'appointment_id is required.' };

    const found = await ctx.db.query(
      `SELECT * FROM appointments WHERE id = $1 AND workspace_id = $2`,
      [appointment_id, ctx.workspace.id]
    );
    if (found.rows.length === 0) {
      return { success: false, message: `No appointment with id ${appointment_id} in this workspace.` };
    }
    const appointment = found.rows[0];
    if (appointment.status === 'completed') return { success: false, message: `Appointment #${appointment_id} already completed.` };
    if (appointment.status === 'canceled') return { success: false, message: `Appointment #${appointment_id} is canceled.` };

    try {
      await ctx.db.query(
        `UPDATE appointments
            SET status = 'completed',
                completed_at = NOW(),
                final_price_cents = COALESCE($1, final_price_cents),
                amount_paid_cents = COALESCE($2, amount_paid_cents),
                payment_method    = COALESCE($3, payment_method),
                payment_collected_at = CASE WHEN $2 IS NOT NULL THEN NOW() ELSE payment_collected_at END,
                updated_at = NOW()
          WHERE id = $4 AND workspace_id = $5`,
        [final_price_cents || null, amount_paid_cents || null, payment_method || null,
          appointment_id, ctx.workspace.id]
      );
    } catch (err) {
      return { success: false, message: `Could not complete: ${err.message}` };
    }

    // E3: Auto-create a draft transaction for this completed appointment.
    // Best-effort — failure here must NOT fail the appointment completion.
    let draft_transaction_id = null;
    try {
      const apt = await ctx.db.query(
        `SELECT a.*, c.name AS contact_name
           FROM appointments a
           LEFT JOIN contacts c ON c.id = a.contact_id AND c.user_id = $1
          WHERE a.id = $2 AND a.workspace_id = $3`,
        [ctx.workspace.owner_user_id, appointment_id, ctx.workspace.id]
      );
      if (apt.rows.length > 0) {
        const a = apt.rows[0];
        const customerName = a.contact_name || 'Walk-in';
        const unitPrice = a.final_price_cents || a.quoted_price_cents || 0;
        const lineItems = [{
          description: a.title || 'Service',
          quantity: 1,
          unit_price_cents: unitPrice,
          total_cents: unitPrice,
          type: 'service',
        }];
        const subtotal = unitPrice;
        const tip = parseInt(input.tip_cents, 10) || 0;
        const total = subtotal + tip;
        const pm = payment_method || null;
        const paid = amount_paid_cents != null ? parseInt(amount_paid_cents, 10) : 0;

        // E14: INSERT + ledger + recompute run on ONE dedicated client
        // inside ONE BEGIN/COMMIT, so a failure after the INSERT can't
        // leave us with a transaction row but no ledger row (or vice
        // versa). The appointment UPDATE above already committed — the
        // appointment-canonical rule is preserved by the outer try/catch:
        // if this whole block fails, the appointment stays completed and
        // ROLLBACK guarantees no orphaned half-written transaction.
        const client = await ctx.db.connect();
        try {
          await client.query('BEGIN');
          const r = await client.query(
            `INSERT INTO transactions
               (workspace_id, contact_id, appointment_id, customer_display_name,
                line_items, subtotal_cents, tip_cents, total_cents, amount_paid_cents,
                payment_method, status, source, created_by_user_id,
                payment_received_at)
             VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,0,$9,'draft','appointment_completion',$10,NULL)
             RETURNING id`,
            [ctx.workspace.id, a.contact_id, appointment_id, customerName,
             JSON.stringify(lineItems), subtotal, tip, total,
             pm, ctx.user.id]
          );
          draft_transaction_id = r.rows[0].id;

          // If money came in at completion, route it through the ledger
          // so the rollup is the single source of truth for amount_paid_cents
          // and status.
          if (paid > 0) {
            await paymentLedger.recordPayment(client, {
              workspace_id: ctx.workspace.id,
              transaction_id: draft_transaction_id,
              amount_cents: paid,
              payment_type: 'payment',
              payment_method: pm || 'cash',
              status: 'completed',
              created_by_user_id: ctx.user.id,
            });
            await paymentLedger.recomputeTransactionPaidStatus(client, draft_transaction_id);
          }
          await client.query('COMMIT');
        } catch (innerErr) {
          try { await client.query('ROLLBACK'); } catch (_) { /* best-effort */ }
          // The INSERT (if it succeeded) is undone by ROLLBACK, so don't
          // report a draft_transaction_id that no longer exists.
          draft_transaction_id = null;
          throw innerErr;
        } finally {
          client.release();
        }
      }
    } catch (err) {
      ctx.logger.error('[complete_appointment] draft transaction creation failed (appointment still completed):', err.message);
    }

    return {
      success: true,
      data: { appointment_id, draft_transaction_id },
      message: draft_transaction_id
        ? `Completed appointment #${appointment_id}. Draft transaction #${draft_transaction_id} created.`
        : `Completed appointment #${appointment_id}.`,
    };
  },
});

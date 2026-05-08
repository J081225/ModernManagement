// lib/tools/complete_appointment.js
//
// Marks an appointment completed and optionally records final price /
// payment. E3 will hook this into the auto-creation of a draft service
// receipt; for E2 it just updates the appointment row.

const registry = require('../tool-registry');

registry.register({
  name: 'complete_appointment',
  description: 'Mark an appointment as completed. Sets status="completed" and stamps completed_at. Optionally records final price and amount paid. E3 will hook this into auto-creation of a draft transaction; for now, it just updates the appointment.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'integer' },
      final_price_cents: { type: 'integer' },
      amount_paid_cents: { type: 'integer' },
      payment_method: { type: 'string', description: 'cash, card, venmo, zelle, gift_card, other, or unpaid.' },
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

    return { success: true, data: { appointment_id }, message: `Completed appointment #${appointment_id}.` };
  },
});

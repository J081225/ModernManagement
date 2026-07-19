// lib/tools/cancel_appointment.js
//
// Cancels an appointment and removes the linked calendar event so the
// slot opens back up on the unified calendar.

const registry = require('../tool-registry');
const { callerOwnsAppointment, escalateScopeMismatch, SCOPE_REFUSAL } = require('../customer-scope');

registry.register({
  name: 'cancel_appointment',
  description: 'Cancel an appointment. Sets status to "canceled" and records who/why. The calendar entry stays visible (shown as canceled) but the time slot opens back up for new bookings.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'integer' },
      reason: { type: 'string' },
      canceled_by: { type: 'string', enum: ['customer', 'staff', 'ai'] },
    },
    required: ['appointment_id'],
  },
  navigationPolicy: 'auto',
  navigateTo: '/calendar',
  requiresApproval: false,
  async execute(input, ctx) {
    const { appointment_id, reason, canceled_by } = input;
    if (!appointment_id) return { success: false, message: 'appointment_id is required.' };

    const found = await ctx.db.query(
      `SELECT * FROM appointments WHERE id = $1 AND workspace_id = $2`,
      [appointment_id, ctx.workspace.id]
    );
    if (found.rows.length === 0) {
      return { success: false, message: `No appointment with id ${appointment_id} in this workspace.` };
    }
    const appointment = found.rows[0];
    // FD2: inbound customers may cancel only their own appointment. The
    // check runs before any status detail is revealed to a stranger.
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      const owns = await callerOwnsAppointment(ctx, appointment);
      if (!owns) {
        await escalateScopeMismatch(ctx, appointment, 'cancel');
        return { success: false, message: SCOPE_REFUSAL };
      }
    }
    if (appointment.status === 'canceled') {
      return { success: false, message: `Appointment #${appointment_id} is already canceled.` };
    }

    try {
      await ctx.db.query(
        `UPDATE appointments
            SET status = 'canceled',
                canceled_at = NOW(),
                canceled_by = $1,
                canceled_reason = $2,
                updated_at = NOW()
          WHERE id = $3 AND workspace_id = $4`,
        [canceled_by || 'staff', reason || null, appointment_id, ctx.workspace.id]
      );
    } catch (err) {
      return { success: false, message: `Could not cancel: ${err.message}` };
    }

    // CP5: the linked cal_events row is kept so the calendar shows the
    // booking grayed as canceled. The slot still re-opens for booking —
    // propose_appointment_times excludes canceled-appointment events.

    return { success: true, data: { appointment_id }, message: `Canceled appointment #${appointment_id}. The slot is open again.` };
  },
});

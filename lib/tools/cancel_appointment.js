// lib/tools/cancel_appointment.js
//
// Cancels an appointment and removes the linked calendar event so the
// slot opens back up on the unified calendar.

const registry = require('../tool-registry');

registry.register({
  name: 'cancel_appointment',
  description: 'Cancel an appointment. Sets status to "canceled" and records who/why. Removes the linked calendar event so the slot opens back up.',
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

    if (appointment.cal_event_id) {
      try {
        await ctx.db.query(`DELETE FROM cal_events WHERE id = $1`, [appointment.cal_event_id]);
      } catch (err) {
        ctx.logger.error('[cancel_appointment] cal_event delete failed (appointment canceled):', err.message);
      }
    }

    return { success: true, data: { appointment_id }, message: `Canceled appointment #${appointment_id}.` };
  },
});

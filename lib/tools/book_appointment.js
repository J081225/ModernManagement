// lib/tools/book_appointment.js
//
// Books an appointment for a Professional Services workspace.
// Creates BOTH the appointments row AND a linked cal_events row so the
// time is blocked off on the unified calendar.
//
// Schema reality:
//   appointments and appointment_threads are workspace-scoped (E2)
//   cal_events is workspace-scoped post-E2 with starts_at / ends_at /
//     event_type / appointment_id; the legacy `date` TEXT column is also
//     written so calendar UI that still reads `date` keeps working.
//   contacts is user-scoped (legacy) — fuzzy-match via
//     workspaces.owner_user_id.

const registry = require('../tool-registry');

registry.register({
  name: 'book_appointment',
  description: 'Book an appointment for a customer. Use only when you have a customer name (or "walk-in"), a service title, a confirmed start time, and a duration. Creates both an appointments row and a calendar event so the time is blocked off. If the workspace has appointment_auto_confirm=false (default), the appointment is created as "requested" awaiting owner approval. If true, status is "confirmed" immediately.',
  vertical: 'professional-services',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      customer_name: { type: 'string', description: 'Customer name (use "walk-in" if unknown).' },
      title: { type: 'string', description: 'Short title for the appointment, e.g., "Gel Manicure".' },
      starts_at: { type: 'string', description: 'ISO 8601 timestamp for the appointment start.' },
      duration_minutes: { type: 'integer', description: 'Length of the appointment in minutes.' },
      quoted_price_cents: { type: 'integer', description: 'Quoted price in cents.' },
      notes_internal: { type: 'string' },
      notes_customer: { type: 'string' },
      source: { type: 'string', enum: ['ai_inbound_sms', 'ai_inbound_email', 'ai_inbound_voicemail', 'staff_command_bar', 'walk_in'] },
    },
    required: ['customer_name', 'title', 'starts_at', 'duration_minutes'],
  },
  navigationPolicy: 'auto',
  navigateTo: '/calendar',
  requiresApproval: false,
  async execute(input, ctx) {
    const {
      customer_name, title, starts_at, duration_minutes,
      quoted_price_cents, notes_internal, notes_customer, source,
    } = input;
    if (!customer_name || !title || !starts_at || !duration_minutes) {
      return { success: false, message: 'Missing required fields.' };
    }
    if (duration_minutes < 5 || duration_minutes > 720) {
      return { success: false, message: 'duration_minutes must be between 5 and 720.' };
    }

    let contact_id = null;
    if (customer_name && customer_name.toLowerCase() !== 'walk-in') {
      const f = await ctx.db.query(
        `SELECT id FROM contacts WHERE user_id = $1 AND LOWER(name) LIKE $2 ORDER BY name LIMIT 1`,
        [ctx.workspace.owner_user_id, `%${customer_name.toLowerCase()}%`]
      );
      if (f.rows.length > 0) contact_id = f.rows[0].id;
    }

    const startsAtDate = new Date(starts_at);
    if (isNaN(startsAtDate.getTime())) {
      return { success: false, message: `Could not parse starts_at: "${starts_at}".` };
    }
    const endsAt = new Date(startsAtDate.getTime() + duration_minutes * 60 * 1000);

    const initialStatus = ctx.workspace.appointment_auto_confirm ? 'confirmed' : 'requested';
    const sourceValue = source ||
      (ctx.origin && ctx.origin.channel === 'ai_inbound' ? 'ai_inbound_sms' : 'staff_command_bar');

    let appointment;
    try {
      const r = await ctx.db.query(
        `INSERT INTO appointments
           (workspace_id, contact_id, title, notes_internal, notes_customer,
            starts_at, duration_minutes, ends_at,
            status, quoted_price_cents, source, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [ctx.workspace.id, contact_id, title, notes_internal || null, notes_customer || null,
          startsAtDate.toISOString(), duration_minutes, endsAt.toISOString(),
          initialStatus, quoted_price_cents || null, sourceValue, ctx.user.id]
      );
      appointment = r.rows[0];
    } catch (err) {
      ctx.logger.error('[book_appointment] INSERT failed:', err.message);
      return { success: false, message: `Could not book the appointment: ${err.message}` };
    }

    let cal_event_id = null;
    try {
      const calRes = await ctx.db.query(
        `INSERT INTO cal_events
           (user_id, workspace_id, date, title, starts_at, ends_at, is_all_day, event_type, appointment_id)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,'appointment',$7) RETURNING id`,
        [ctx.workspace.owner_user_id, ctx.workspace.id,
          startsAtDate.toISOString().slice(0, 10), title,
          startsAtDate.toISOString(), endsAt.toISOString(), appointment.id]
      );
      cal_event_id = calRes.rows[0].id;
      await ctx.db.query(
        `UPDATE appointments SET cal_event_id = $1 WHERE id = $2`,
        [cal_event_id, appointment.id]
      );
    } catch (err) {
      ctx.logger.error('[book_appointment] cal_events INSERT failed (appointment kept):', err.message);
    }

    if (ctx.origin && ctx.origin.appointment_thread_id) {
      try {
        await ctx.db.query(
          `UPDATE appointment_threads
              SET appointment_id = $1, state = $2, updated_at = NOW()
            WHERE id = $3`,
          [appointment.id,
            initialStatus === 'confirmed' ? 'complete' : 'awaiting_confirmation',
            ctx.origin.appointment_thread_id]
        );
      } catch (err) {
        ctx.logger.error('[book_appointment] thread link failed (non-fatal):', err.message);
      }
    }

    const niceTime = startsAtDate.toLocaleString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const userMessage = initialStatus === 'confirmed'
      ? `Booked: ${title} for ${customer_name} on ${niceTime} (${duration_minutes} min). Calendar updated.`
      : `Requested: ${title} for ${customer_name} on ${niceTime} (${duration_minutes} min). Awaiting your confirmation.`;

    return {
      success: true,
      data: { appointment_id: appointment.id, cal_event_id, status: initialStatus },
      message: userMessage,
    };
  },
});

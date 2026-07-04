// lib/tools/update_appointment.js
//
// Updates an existing appointment (reschedule, change service, change
// duration, edit notes). Keeps the linked cal_events row in sync.

const registry = require('../tool-registry');
const { wsTz, toZonedISO } = require('../time-helpers');

registry.register({
  name: 'update_appointment',
  description: 'Update an existing appointment by id. Use to reschedule (change starts_at and/or duration_minutes), update notes, or change the title. Updates the linked calendar event automatically.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      appointment_id: { type: 'integer' },
      title: { type: 'string' },
      starts_at: { type: 'string', description: 'New start time as ISO 8601 WITH timezone offset, e.g. 2026-07-15T09:30:00-04:00. Never pass a naive time without an offset.' },
      duration_minutes: { type: 'integer' },
      notes_internal: { type: 'string' },
      notes_customer: { type: 'string' },
      quoted_price_cents: { type: 'integer' },
    },
    required: ['appointment_id'],
  },
  navigationPolicy: 'auto',
  navigateTo: '/calendar',
  requiresApproval: false,
  async execute(input, ctx) {
    const { appointment_id } = input;
    if (!appointment_id) return { success: false, message: 'appointment_id is required.' };

    const found = await ctx.db.query(
      `SELECT * FROM appointments WHERE id = $1 AND workspace_id = $2`,
      [appointment_id, ctx.workspace.id]
    );
    if (found.rows.length === 0) {
      return { success: false, message: `No appointment with id ${appointment_id} in this workspace.` };
    }
    const current = found.rows[0];

    const updates = {};
    if (input.title !== undefined) updates.title = input.title;
    if (input.notes_internal !== undefined) updates.notes_internal = input.notes_internal;
    if (input.notes_customer !== undefined) updates.notes_customer = input.notes_customer;
    if (input.quoted_price_cents !== undefined) updates.quoted_price_cents = input.quoted_price_cents;

    let newStartsAt = current.starts_at;
    let newDuration = current.duration_minutes;
    let newEndsAt = current.ends_at;

    if (input.starts_at !== undefined) {
      // Belt-and-suspenders: naive strings are interpreted in the
      // workspace's timezone rather than eaten as UTC. See lib/time-helpers.
      const startIso = toZonedISO(input.starts_at, wsTz(ctx.workspace));
      if (!startIso) return { success: false, message: 'Invalid starts_at timestamp.' };
      newStartsAt = startIso;
      updates.starts_at = newStartsAt;
    }
    if (input.duration_minutes !== undefined) {
      if (input.duration_minutes < 5 || input.duration_minutes > 720) {
        return { success: false, message: 'duration_minutes must be between 5 and 720.' };
      }
      newDuration = input.duration_minutes;
      updates.duration_minutes = newDuration;
    }
    if (input.starts_at !== undefined || input.duration_minutes !== undefined) {
      newEndsAt = new Date(new Date(newStartsAt).getTime() + newDuration * 60 * 1000).toISOString();
      updates.ends_at = newEndsAt;
    }

    if (Object.keys(updates).length === 0) {
      return { success: false, message: 'No fields to update.' };
    }

    const setClauses = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(updates)) {
      setClauses.push(`${k} = $${i++}`);
      values.push(v);
    }
    setClauses.push('updated_at = NOW()');
    values.push(appointment_id, ctx.workspace.id);

    try {
      await ctx.db.query(
        `UPDATE appointments SET ${setClauses.join(', ')} WHERE id = $${i++} AND workspace_id = $${i}`,
        values
      );
    } catch (err) {
      ctx.logger.error('[update_appointment] UPDATE failed:', err.message);
      return { success: false, message: `Could not update appointment: ${err.message}` };
    }

    if (current.cal_event_id && (updates.starts_at || updates.ends_at || updates.title)) {
      try {
        await ctx.db.query(
          `UPDATE cal_events
              SET starts_at = COALESCE($1, starts_at),
                  ends_at   = COALESCE($2, ends_at),
                  title     = COALESCE($3, title),
                  date      = COALESCE($4, date)
            WHERE id = $5`,
          [updates.starts_at || null,
            updates.ends_at || null,
            updates.title || null,
            updates.starts_at ? new Date(updates.starts_at).toISOString().slice(0, 10) : null,
            current.cal_event_id]
        );
      } catch (err) {
        ctx.logger.error('[update_appointment] cal_event sync failed (appointment updated):', err.message);
      }
    }

    return { success: true, data: { appointment_id }, message: `Updated appointment #${appointment_id}.` };
  },
});

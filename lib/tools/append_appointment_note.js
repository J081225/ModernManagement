// lib/tools/append_appointment_note.js — FD3-CP5 commit 2.
//
// Day-of logistics: "running late" / "on my way" becomes a timestamped
// line APPENDED to notes_internal on the customer's TODAY appointment
// (look-first (b): notes_internal is the owner-facing operational note
// and already renders in the event detail modal; notes_customer is the
// customer-visible field and stays untouched). Append — never
// overwrite — so FD2's "customers may only reschedule" boundary on
// update_appointment stays intact; this tool writes exactly one
// system-worded, timestamped line and nothing else.
//
// FD2 scope: for ai_inbound the target must be the CALLER's OWN
// appointment happening TODAY (phone/email match via the same last-10-
// digit comparison the other guards use, plus the thread-phone
// fallback). Owner-side callers pass an explicit appointment_id and
// skip the caller scoping (workspace check only).
//
// Owner ping (CP4 routing): ONLY if the appointment starts within the
// next 2 hours or is currently in progress — a note for this evening's
// appointment should not buzz the owner's phone at 9 AM.

const registry = require('../tool-registry');
const { wsTz } = require('../time-helpers');
const { phoneDigits10 } = require('../phone');
const { callerOwnsAppointment } = require('../customer-scope');
const { sendOwnerAlert } = require('../owner-alert');

registry.register({
  name: 'append_appointment_note',
  description: "Attach a short timestamped note to an appointment happening TODAY (e.g. the customer says they are running late or on their way). Appends to the appointment's internal notes so staff see it; never replaces existing notes. If the customer has no appointment today, this fails — take a message with add_task instead.",
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: "The message to attach, in the customer's words (e.g. 'Running about 15 minutes late')." },
      appointment_id: { type: 'integer', description: 'Optional. If omitted for a customer conversation, their soonest appointment today is used.' },
    },
    required: ['note'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const note = (input.note || '').trim();
    if (!note) return { success: false, message: 'Nothing to note.' };

    const tz = wsTz(ctx.workspace);
    const isCustomer = !!(ctx.origin && ctx.origin.channel === 'ai_inbound');

    let appointment = null;
    if (isCustomer) {
      // Caller's TODAY appointments, soonest first — same identity
      // matching as loadCallerAppointments (FD2).
      const digits = phoneDigits10(ctx.customer_phone);
      const email = ctx.customer_email ? String(ctx.customer_email) : null;
      if (!digits && !email) {
        return { success: false, message: 'I could not verify which appointment this is for.' };
      }
      const r = await ctx.db.query(
        `SELECT a.* FROM appointments a
          WHERE a.workspace_id = $1
            AND a.status IS DISTINCT FROM 'canceled'
            AND (a.starts_at AT TIME ZONE $5)::date = (NOW() AT TIME ZONE $5)::date
            AND (
              a.contact_id IN (
                SELECT c.id FROM contacts c
                 WHERE c.user_id = $2
                   AND (
                     ($3::text IS NOT NULL AND RIGHT(regexp_replace(c.phone, '\\D', '', 'g'), 10) = $3)
                     OR ($4::text IS NOT NULL AND LOWER(c.email) = LOWER($4))
                   )
              )
              OR ($3::text IS NOT NULL AND a.id IN (
                SELECT t.appointment_id FROM appointment_threads t
                 WHERE t.appointment_id IS NOT NULL
                   AND RIGHT(regexp_replace(t.customer_phone, '\\D', '', 'g'), 10) = $3
              ))
            )
          ORDER BY a.starts_at ASC
          LIMIT 5`,
        [ctx.workspace.id, ctx.workspace.owner_user_id, digits, email, tz]
      );
      if (input.appointment_id) {
        appointment = r.rows.find((a) => a.id === input.appointment_id) || null;
        // Belt-and-suspenders: an id outside today's own list gets the
        // full FD2 ownership treatment before we say anything specific.
        if (!appointment) {
          const other = await ctx.db.query(
            `SELECT * FROM appointments WHERE id = $1 AND workspace_id = $2`,
            [input.appointment_id, ctx.workspace.id]
          );
          if (other.rows[0] && await callerOwnsAppointment(ctx, other.rows[0])) {
            return { success: false, message: 'That appointment is not today — I can only attach day-of notes to a same-day appointment.' };
          }
          return { success: false, message: 'I could not find that appointment for you.' };
        }
      } else {
        appointment = r.rows[0] || null;
      }
      if (!appointment) {
        return { success: false, message: 'No appointment today on file for this customer. Take a message with add_task instead.' };
      }
    } else {
      if (!input.appointment_id) {
        return { success: false, message: 'appointment_id is required.' };
      }
      const r = await ctx.db.query(
        `SELECT * FROM appointments WHERE id = $1 AND workspace_id = $2`,
        [input.appointment_id, ctx.workspace.id]
      );
      appointment = r.rows[0];
      if (!appointment) return { success: false, message: `No appointment with id ${input.appointment_id} in this workspace.` };
    }

    const stamp = new Date().toLocaleString('en-US', {
      timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const line = `[${stamp}] ${note.slice(0, 300)}`;
    try {
      await ctx.db.query(
        `UPDATE appointments
            SET notes_internal = COALESCE(notes_internal || E'\\n', '') || $1
          WHERE id = $2 AND workspace_id = $3`,
        [line, appointment.id, ctx.workspace.id]
      );
    } catch (err) {
      return { success: false, message: `Could not attach the note: ${err.message}` };
    }

    // CP4 owner routing, imminence-gated: starts within 2 hours, or in
    // progress (started, not yet past its scheduled end).
    let pinged = false;
    const msUntil = new Date(appointment.starts_at).getTime() - Date.now();
    const durMs = (appointment.duration_minutes || 30) * 60 * 1000;
    if (msUntil <= 2 * 60 * 60 * 1000 && msUntil > -durMs) {
      try {
        const startLocal = new Date(appointment.starts_at).toLocaleString('en-US', {
          timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
        });
        await sendOwnerAlert(
          { db: ctx.db, twilio: ctx.sms, sendgrid: ctx.sendgrid || ctx.mailer, env: ctx.env, logger: ctx.logger },
          ctx.workspace.owner_user_id,
          {
            smsBody: `Heads-up for the ${startLocal} ${appointment.title}: "${note.slice(0, 120)}"`,
            emailSubject: `Heads-up about today's ${startLocal} appointment`,
            respectEnabled: true,
          }
        );
        pinged = true;
      } catch (err) {
        ctx.logger.error('[append_appointment_note] owner ping failed (note saved):', err.message);
      }
    }

    return {
      success: true,
      data: { appointment_id: appointment.id, pinged },
      message: `Noted on the ${appointment.title} appointment${pinged ? ' and the owner was pinged' : ''}.`,
    };
  },
});

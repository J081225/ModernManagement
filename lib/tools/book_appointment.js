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
const { wsTz, toZonedISO } = require('../time-helpers');
const { normalizePhone, phoneDigits10, callerPlaceholderName } = require('../phone');
const { depositsLive, computeDepositCents } = require('../deposits');
const { decideAutonomyAction } = require('../autonomy');
const { sendOwnerAlert } = require('../owner-alert');

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
      starts_at: { type: 'string', description: 'ISO 8601 WITH timezone offset, e.g. 2026-07-15T09:30:00-04:00. Never pass a naive time without an offset.' },
      duration_minutes: { type: 'integer', description: 'Length of the appointment in minutes.' },
      quoted_price_cents: { type: 'integer', description: 'Quoted price in cents.' },
      notes_internal: { type: 'string' },
      notes_customer: { type: 'string' },
      source: { type: 'string', enum: ['ai_inbound_sms', 'ai_inbound_email', 'ai_inbound_voicemail', 'ai_inbound_voice', 'staff_command_bar', 'walk_in'] },
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

    // FD1 contact resolution, in strict order:
    //   (a) exact match on the channel's phone number (normalized both
    //       sides — stored contacts.phone is free text);
    //   (b) legacy name fuzzy-match as fallback only;
    //   (c) no match → CREATE the contact deterministically right here
    //       (phone from ctx; name from customer_name, else a recoverable
    //       "Caller +1 ..." placeholder) and link it.
    let contact_id = null;
    const callerDigits = phoneDigits10(ctx.customer_phone);
    if (callerDigits) {
      const byPhone = await ctx.db.query(
        `SELECT id FROM contacts
          WHERE user_id = $1
            AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = $2
          ORDER BY id LIMIT 1`,
        [ctx.workspace.owner_user_id, callerDigits]
      );
      if (byPhone.rows.length > 0) contact_id = byPhone.rows[0].id;
    }
    if (!contact_id && customer_name && customer_name.toLowerCase() !== 'walk-in') {
      const f = await ctx.db.query(
        `SELECT id FROM contacts WHERE user_id = $1 AND LOWER(name) LIKE $2 ORDER BY name LIMIT 1`,
        [ctx.workspace.owner_user_id, `%${customer_name.toLowerCase()}%`]
      );
      if (f.rows.length > 0) contact_id = f.rows[0].id;
    }
    if (!contact_id && (callerDigits || (customer_name && customer_name.toLowerCase() !== 'walk-in'))) {
      const newName = (customer_name && customer_name.toLowerCase() !== 'walk-in')
        ? customer_name
        : callerPlaceholderName(ctx.customer_phone);
      const newPhone = normalizePhone(ctx.customer_phone) || '';
      const newEmail = ctx.customer_email || '';
      // FD3-CP2: honest contact type per vertical — a salon's callers
      // are customers, not residents.
      const newType = ctx.workspace.vertical === 'professional-services' ? 'customer' : 'resident';
      try {
        const created = await ctx.db.query(
          `INSERT INTO contacts (user_id, name, type, unit, email, phone, notes)
           VALUES ($1, $2, $3, '', $4, $5, $6) RETURNING id`,
          [ctx.workspace.owner_user_id, newName, newType, newEmail, newPhone,
            'Auto-created from an AI booking.']
        );
        contact_id = created.rows[0].id;
      } catch (err) {
        ctx.logger.error('[book_appointment] contact auto-create failed (booking continues unlinked):', err.message);
      }
    }

    // Belt-and-suspenders: the schema asks for offset-aware ISO, but a
    // naive "YYYY-MM-DDTHH:mm" still gets interpreted as wall-clock in the
    // workspace's timezone rather than eaten as UTC. See lib/time-helpers.
    const startIso = toZonedISO(starts_at, wsTz(ctx.workspace));
    if (!startIso) {
      return { success: false, message: 'Invalid starts_at timestamp.' };
    }
    const startsAtDate = new Date(startIso);
    const endsAt = new Date(startsAtDate.getTime() + duration_minutes * 60 * 1000);

    const initialStatus = ctx.workspace.appointment_auto_confirm ? 'confirmed' : 'requested';
    // FD3-CP2: provenance from the actual channel (voice bookings were
    // labeled as SMS — investigation §1 delta table, last row).
    const CHANNEL_SOURCE = { voice: 'ai_inbound_voice', voicemail: 'ai_inbound_voicemail', email: 'ai_inbound_email', sms: 'ai_inbound_sms' };
    const sourceValue = source ||
      (ctx.origin && ctx.origin.channel === 'ai_inbound'
        ? (CHANNEL_SOURCE[ctx.origin.channel_detail] || 'ai_inbound_sms')
        : 'staff_command_bar');

    // BK1: the availability check and the write are ONE ATOMIC unit.
    // A transaction-scoped per-workspace advisory lock serializes all
    // bookings for a workspace; the overlap check (same semantics as
    // propose_appointment_times: non-canceled cal_events block) and
    // BOTH inserts (appointments + the cal_events block row) happen
    // inside that one transaction — concurrent double-book is
    // structurally impossible, and a failed block-row now rolls the
    // whole booking back instead of leaving an unblocked appointment.
    // A lost race returns reason 'slot_taken' with the conflict named
    // so the model can relay it honestly and re-propose.
    const BOOKING_LOCK_NS = 424242;
    if (typeof ctx.db.connect !== 'function') {
      return { success: false, message: 'Booking requires a transactional db handle (pool.connect).' };
    }
    const client = await ctx.db.connect();
    let appointment;
    let cal_event_id = null;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [BOOKING_LOCK_NS, ctx.workspace.id]);
      const conflict = await client.query(
        `SELECT ce.starts_at, ce.ends_at
           FROM cal_events ce
           LEFT JOIN appointments a ON a.id = ce.appointment_id
          WHERE ce.workspace_id = $1
            AND ce.starts_at < $2 AND ce.ends_at > $3
            AND (a.id IS NULL OR a.status IS DISTINCT FROM 'canceled')
          ORDER BY ce.starts_at ASC
          LIMIT 1`,
        [ctx.workspace.id, endsAt.toISOString(), startsAtDate.toISOString()]
      );
      if (conflict.rows.length) {
        await client.query('ROLLBACK');
        const takenNice = new Date(conflict.rows[0].starts_at).toLocaleString('en-US',
          { timeZone: wsTz(ctx.workspace), hour: 'numeric', minute: '2-digit', hour12: true });
        return {
          success: false,
          reason: 'slot_taken',
          message: `That time was just taken — there is a booking at ${takenNice} that conflicts. Apologize briefly and offer the nearest open times (propose_appointment_times).`,
        };
      }
      const r = await client.query(
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
      const calRes = await client.query(
        `INSERT INTO cal_events
           (user_id, workspace_id, date, title, starts_at, ends_at, is_all_day, event_type, appointment_id)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,'appointment',$7) RETURNING id`,
        [ctx.workspace.owner_user_id, ctx.workspace.id,
          startsAtDate.toISOString().slice(0, 10), title,
          startsAtDate.toISOString(), endsAt.toISOString(), appointment.id]
      );
      cal_event_id = calRes.rows[0].id;
      await client.query(
        `UPDATE appointments SET cal_event_id = $1 WHERE id = $2`,
        [cal_event_id, appointment.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rbErr) { /* already aborted */ }
      ctx.logger.error('[book_appointment] atomic booking failed (rolled back):', err.message);
      return { success: false, message: `Could not book the appointment: ${err.message}` };
    } finally {
      if (typeof client.release === 'function') client.release();
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

    // FD3-CP6: deposits — the whole flow, shipped asleep. depositsLive()
    // is the dormancy gate (live-mode key prefix or the staging
    // override); until it opens, this block is dead code and bookings
    // are byte-identical. When open + enabled: a transaction carrying
    // the full quoted price is created against the appointment (source
    // 'booking_deposit', §5's missing piece), and the LINK REQUEST
    // enters the payments autonomy lane as a queued
    // request_payments_batch — approve-by-default, so no link reaches
    // a customer without the owner saying so. Best-effort: any failure
    // here logs and the booking stands.
    let deposit_note = '';
    try {
      const depositCents = depositsLive(ctx.env)
        ? computeDepositCents(ctx.workspace, quoted_price_cents || null)
        : null;
      if (depositCents) {
        const txTotal = quoted_price_cents || depositCents;
        const txRes = await ctx.db.query(
          `INSERT INTO transactions
             (workspace_id, contact_id, appointment_id, customer_display_name,
              line_items, subtotal_cents, total_cents, status, source, created_by_user_id)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6,'unpaid','booking_deposit',$7)
           RETURNING id`,
          [ctx.workspace.id, contact_id, appointment.id, customer_name,
            JSON.stringify([{ description: title, quantity: 1, unit_price_cents: txTotal, total_cents: txTotal, type: 'service' }]),
            txTotal, ctx.user.id]
        );
        const depositTxId = txRes.rows[0].id;
        await ctx.db.query(
          `UPDATE appointments SET deposit_required_cents = $1, deposit_transaction_id = $2 WHERE id = $3`,
          [depositCents, depositTxId, appointment.id]
        );
        const isCustomer = !!(ctx.origin && ctx.origin.channel === 'ai_inbound');
        const decision = decideAutonomyAction(ctx.workspace, { name: 'request_payments_batch', requiresApproval: true });
        const dollars = (depositCents / 100).toFixed(2);
        if (decision === 'decline') {
          // payments lane is OFF: no link request queues; the owner
          // collects the deposit manually via a suggested task.
          await ctx.db.query(
            `INSERT INTO tasks (user_id, title, category, "dueDate", notes, suggested, "aiReason")
             VALUES ($1, $2, 'follow_up', $3, $4, true, $5)`,
            [ctx.workspace.owner_user_id,
              `Collect a ${dollars} deposit from ${customer_name}`,
              new Date().toISOString().slice(0, 10),
              `Deposit for the ${title} booking (appointment #${appointment.id}). The payments autonomy lane is off, so no link was queued.`,
              'Deposits are enabled but payment actions are set to off.']
          );
        } else {
          // 'queue' (payments act/approve both queue — requiresApproval).
          await ctx.db.query(
            `INSERT INTO pending_actions
               (workspace_id, user_id, tool_name, input, ai_summary, status,
                customer_phone, customer_email, customer_channel, appointment_thread_id)
             VALUES ($1, $2, 'request_payments_batch', $3, $4, 'pending', $5, $6, $7, $8)`,
            [ctx.workspace.id, ctx.workspace.owner_user_id,
              JSON.stringify({ requests: [{ transaction_id: depositTxId, customer_name, amount_cents: depositCents, payment_type: 'deposit' }] }),
              `Deposit link for ${customer_name}: ${dollars} for ${title}`,
              isCustomer ? (ctx.customer_phone || null) : null,
              isCustomer ? (ctx.customer_email || null) : null,
              isCustomer ? ((ctx.origin && ctx.origin.channel_detail) || 'sms') : null,
              (ctx.origin && ctx.origin.appointment_thread_id) || null]
          );
          if (isCustomer) {
            // CP4 rule: customer-originated queue rows announce
            // themselves; owner-originated stay silent (the owner just
            // booked it and the badge already counts it).
            try {
              await sendOwnerAlert(
                { db: ctx.db, twilio: ctx.sms, sendgrid: ctx.sendgrid || ctx.mailer, env: ctx.env, logger: ctx.logger },
                ctx.workspace.owner_user_id,
                {
                  smsBody: 'A deposit link is waiting on your approval — open Modern Management to review.',
                  emailSubject: 'A deposit link is waiting on your approval',
                  respectEnabled: true,
                }
              );
            } catch (pingErr) {
              ctx.logger.error('[book_appointment] deposit ping failed (queue row intact):', pingErr.message);
            }
          }
          deposit_note = ` A ${dollars} deposit is requested to secure the booking — the payment link goes out after approval.`;
        }
      }
    } catch (err) {
      ctx.logger.error('[book_appointment] deposit setup failed (booking stands):', err.message);
    }

    // Format the confirmation string in the business timezone so the AI
    // relays local wall-clock time (2:00 PM), not the server-side UTC
    // rendering (6:00 PM) that would confuse the customer.
    const niceTime = startsAtDate.toLocaleString('en-US',
      { timeZone: wsTz(ctx.workspace), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
    const userMessage = (initialStatus === 'confirmed'
      ? `Booked: ${title} for ${customer_name} on ${niceTime} (${duration_minutes} min). Calendar updated.`
      : `Requested: ${title} for ${customer_name} on ${niceTime} (${duration_minutes} min). Awaiting your confirmation.`) + deposit_note;

    return {
      success: true,
      data: { appointment_id: appointment.id, cal_event_id, status: initialStatus },
      message: userMessage,
    };
  },
});

// lib/customer-scope.js — FD2 customer-scope security.
//
// Inbound customers (SMS / voice / voicemail, ctx.origin.channel ===
// 'ai_inbound') may only touch their OWN appointments. These helpers
// resolve "who is calling" from the channel identity FD1 threads into
// every tool ctx (customer_phone / customer_email), and verify
// ownership of a target appointment. Enforcement lives INSIDE each
// tool, CP6 belt-and-suspenders style, so allowlist drift can never
// reopen the boundary.

const { phoneDigits10 } = require('./phone');

const SCOPE_REFUSAL = 'I can only make changes to your own appointments — want me to check with the owner?';

// The caller's contact row (id, name) or null. Phone first (normalized
// last-10 comparison against free-text stored phones), then exact email.
async function resolveCallerContact(ctx) {
  const digits = phoneDigits10(ctx.customer_phone);
  if (digits) {
    const r = await ctx.db.query(
      `SELECT id, name FROM contacts
        WHERE user_id = $1
          AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = $2
        ORDER BY id LIMIT 1`,
      [ctx.workspace.owner_user_id, digits]
    );
    if (r.rows.length) return r.rows[0];
  }
  if (ctx.customer_email) {
    const r = await ctx.db.query(
      `SELECT id, name FROM contacts
        WHERE user_id = $1 AND LOWER(email) = LOWER($2)
        ORDER BY id LIMIT 1`,
      [ctx.workspace.owner_user_id, String(ctx.customer_email)]
    );
    if (r.rows.length) return r.rows[0];
  }
  return null;
}

// True when the appointment belongs to the caller: linked contact
// matches, or — for pre-FD1 rows with no contact link — the thread
// that produced the appointment carries the caller's phone.
async function callerOwnsAppointment(ctx, appointment) {
  if (!appointment) return false;
  const contact = await resolveCallerContact(ctx);
  if (contact && appointment.contact_id === contact.id) return true;
  const digits = phoneDigits10(ctx.customer_phone);
  if (digits) {
    const r = await ctx.db.query(
      `SELECT 1 FROM appointment_threads
        WHERE appointment_id = $1
          AND RIGHT(regexp_replace(customer_phone, '\\D', '', 'g'), 10) = $2
        LIMIT 1`,
      [appointment.id, digits]
    );
    if (r.rows.length) return true;
  }
  return false;
}

// A refused scope check still reaches a human: a legitimate edge case
// (customer changed numbers) becomes a suggested task for the owner.
async function escalateScopeMismatch(ctx, appointment, action) {
  try {
    await ctx.db.query(
      `INSERT INTO tasks (user_id, title, category, "dueDate", notes, suggested, "aiReason")
       VALUES ($1, $2, 'other', $3, $4, true, $5)`,
      [
        ctx.workspace.owner_user_id,
        `Verify a customer request to ${action} appointment #${appointment.id}`,
        new Date().toISOString().slice(0, 10),
        `A customer (${ctx.customer_phone || ctx.customer_email || 'unknown contact'}) asked to ${action} appointment #${appointment.id} ("${appointment.title || ''}"), but it does not appear to be theirs. If it actually is (for example they changed numbers), handle the request manually.`,
        'Customer-scope check could not match the caller to this appointment.',
      ]
    );
  } catch (err) {
    ctx.logger.error('[customer-scope] escalation task insert failed:', err.message);
  }
}

module.exports = { resolveCallerContact, callerOwnsAppointment, escalateScopeMismatch, SCOPE_REFUSAL };

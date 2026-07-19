// lib/tools/escalate_appointment_to_owner.js
//
// Flags an appointment thread as needing owner review and creates a
// follow-up task on the owner's task list. Used when the request is
// non-routine, ambiguous, or low-confidence.
//
// tasks columns: (user_id, title, category, "dueDate", notes, done,
// suggested, "aiReason") — quoted camelCase required.

const registry = require('../tool-registry');

registry.register({
  name: 'escalate_appointment_to_owner',
  description: 'Flag an appointment thread as needing owner review. Use when the request is non-routine, ambiguous, the customer is upset, or the AI cannot fulfill safely. Sets the thread state to escalated_to_staff and creates a follow-up task on the owner\'s task list.',
  vertical: 'professional-services',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      reason: { type: 'string' },
      kind: { type: 'string', enum: ['complaint', 'question', 'other'], description: 'complaint = an unhappy customer (urgent, owner sees it today); question = an unanswered customer question with a follow-up promised; other = general escalation.' },
      thread_id: { type: 'integer' },
    },
    required: ['reason'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const reason = input.reason;
    const thread_id = input.thread_id || (ctx.origin && ctx.origin.appointment_thread_id);
    if (!thread_id) {
      return { success: false, message: 'No thread_id provided and no thread context available.' };
    }

    try {
      await ctx.db.query(
        `UPDATE appointment_threads
            SET state = 'escalated_to_staff',
                escalated_at = NOW(),
                escalation_reason = $1,
                updated_at = NOW()
          WHERE id = $2 AND workspace_id = $3`,
        [reason, thread_id, ctx.workspace.id]
      );
    } catch (err) {
      return { success: false, message: `Could not escalate: ${err.message}` };
    }

    // FD3-CP5: complaints and promised follow-ups are REAL tasks due
    // today — the AI just told the customer "the owner sees this today"
    // / "someone will get back to you", and a suggested-banner item the
    // owner might dismiss unread would make that a lie. Generic
    // escalations keep the original suggested-task behavior.
    const kind = input.kind === 'complaint' || input.kind === 'question' ? input.kind : 'other';
    // The receipt: the customer's own words, carried by the engine on
    // ctx.origin — you read what they said, not what the AI thinks
    // they meant.
    const words = (ctx.origin && Array.isArray(ctx.origin.recent_customer_words))
      ? ctx.origin.recent_customer_words.filter(Boolean)
      : [];
    let notes = `Escalation reason: ${reason}`;
    if (words.length) {
      notes += `\n\nCustomer's own words (most recent last):\n` + words.map((w) => `\u00ab ${w} \u00bb`).join('\n');
    }
    try {
      if (kind === 'complaint' || kind === 'question') {
        const title = kind === 'complaint'
          ? 'Customer complaint — needs you today'
          : `Customer question needs an answer: ${reason.slice(0, 80)}`;
        const aiReason = kind === 'complaint'
          ? 'Customer complaint escalated by the AI — the playbook promises the owner sees it today.'
          : 'The AI promised this customer a follow-up — someone needs to get back to them.';
        await ctx.db.query(
          `INSERT INTO tasks (user_id, title, category, "dueDate", notes, suggested, "aiReason")
           VALUES ($1, $2, 'follow_up', $3, $4, FALSE, $5)`,
          [ctx.workspace.owner_user_id, title, new Date().toISOString().slice(0, 10), notes, aiReason]
        );
      } else {
        await ctx.db.query(
          `INSERT INTO tasks (user_id, title, category, "dueDate", notes, suggested, "aiReason")
           VALUES ($1, $2, 'follow_up', NULL, $3, TRUE, $4)`,
          [ctx.workspace.owner_user_id,
            `Review escalated appointment thread #${thread_id}`,
            notes,
            'AI escalated an appointment request that needs owner judgment.']
        );
      }
    } catch (err) {
      ctx.logger.error('[escalate_appointment_to_owner] task insert failed (escalation recorded):', err.message);
    }

    return { success: true, data: { thread_id }, message: `Escalated thread #${thread_id} for owner review.` };
  },
});

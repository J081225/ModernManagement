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

    try {
      await ctx.db.query(
        `INSERT INTO tasks (user_id, title, category, "dueDate", notes, suggested, "aiReason")
         VALUES ($1, $2, 'follow_up', NULL, $3, TRUE, $4)`,
        [ctx.workspace.owner_user_id,
          `Review escalated appointment thread #${thread_id}`,
          `Escalation reason: ${reason}`,
          'AI escalated an appointment request that needs owner judgment.']
      );
    } catch (err) {
      ctx.logger.error('[escalate_appointment_to_owner] task insert failed (escalation recorded):', err.message);
    }

    return { success: true, data: { thread_id }, message: `Escalated thread #${thread_id} for owner review.` };
  },
});

// lib/tools/delete_task.js — AP3 destructive tool, precision-only.
// HARD RULE: no fuzzy-match deletion. Resolve by id, or by an exact
// (case-insensitive) title match; multiple candidates → return the
// list and delete nothing.

const registry = require('../tool-registry');

registry.register({
  name: 'delete_task',
  description: 'Delete a task. Prefer task_id (from a find_task result or on-screen context). A title is accepted only as an EXACT match — if several tasks share the title, nothing is deleted and the candidates are returned so the owner can pick.',
  vertical: 'core',
  category: 'delete',
  schema: {
    type: 'object',
    properties: {
      task_id: { type: 'integer', description: 'Preferred. Exact task id.' },
      title: { type: 'string', description: 'Exact title (case-insensitive). Never a partial match.' },
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    // Owner-only belt-and-suspenders (destructive).
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      return { success: false, message: 'Only the business owner can delete tasks.' };
    }
    if (input.task_id) {
      const r = await ctx.db.query(
        `DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING id, title`,
        [input.task_id, ctx.user.id]
      );
      if (!r.rows.length) return { success: false, message: `No task with id ${input.task_id}.` };
      return { success: true, data: { deleted_id: r.rows[0].id }, message: `Deleted task #${r.rows[0].id} "${r.rows[0].title}".` };
    }
    const title = String(input.title || '').trim();
    if (!title) return { success: false, message: 'Provide task_id or an exact title.' };
    const found = await ctx.db.query(
      `SELECT id, title, "dueDate", done FROM tasks
        WHERE user_id = $1 AND dismissed_at IS NULL
          AND LOWER(title) = LOWER($2)
        ORDER BY id DESC LIMIT 6`,
      [ctx.user.id, title]
    );
    if (!found.rows.length) return { success: false, message: `No task titled exactly "${title}".` };
    if (found.rows.length > 1) {
      const list = found.rows.map(t => `#${t.id} "${t.title}"${t.dueDate ? ' due ' + t.dueDate : ''}${t.done ? ' [done]' : ''}`).join('; ');
      return { success: false, data: { candidates: found.rows }, message: `Multiple tasks match "${title}" — nothing deleted. Which one? ${list}` };
    }
    const r = await ctx.db.query(`DELETE FROM tasks WHERE id = $1 AND user_id = $2 RETURNING id`, [found.rows[0].id, ctx.user.id]);
    return { success: true, data: { deleted_id: found.rows[0].id }, message: `Deleted task #${found.rows[0].id} "${found.rows[0].title}".` };
  },
});

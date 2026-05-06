// lib/tools/update_task.js
//
// The tasks table uses a boolean `done` column rather than a status
// enum. The tool's `status` field accepts 'pending'/'done' for AI
// ergonomics; the executor maps that to the boolean.
const registry = require('../tool-registry');

registry.register({
  name: 'update_task',
  description: 'Update an existing task — change its status (mark done, mark pending), update its title, due date, category, or notes. Use this when the user wants to mark a task complete, reopen a task, or modify task details. The user typically refers to a task by its title.',
  vertical: 'core',
  category: 'update',
  schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Title or description identifying the task. Use fuzzy matching against the task list in context.' },
      status: { type: 'string', enum: ['pending', 'done'], description: 'Optional. New status.' },
      title: { type: 'string', description: 'Optional. New title.' },
      dueDate: { type: 'string', description: 'Optional. New due date in YYYY-MM-DD format.' },
      category: { type: 'string', description: 'Optional. New category.' },
      notes: { type: 'string', description: 'Optional. New notes.' }
    },
    required: ['task']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { task, status, title, dueDate, category, notes } = input;
    if (!task) {
      return { success: false, message: 'No task identifier provided.' };
    }
    // Fuzzy match by title against the user's tasks. Order by
    // "dueDate" since the schema has no created_at column.
    const matches = await ctx.db.query(
      `SELECT * FROM tasks WHERE user_id = $1 AND LOWER(title) LIKE $2 ORDER BY "dueDate" ASC LIMIT 5`,
      [ctx.user.id, `%${task.toLowerCase()}%`]
    );
    if (matches.rows.length === 0) {
      return { success: false, message: `No task found matching "${task}".` };
    }
    const target = matches.rows[0];
    // Build dynamic update set. Map AI's `status` enum to the DB's
    // `done` boolean. Quote the camelCase "dueDate" column.
    const updates = [];
    const params = [];
    let i = 1;
    if (status !== undefined) { updates.push(`done = $${i++}`); params.push(status === 'done'); }
    if (title !== undefined) { updates.push(`title = $${i++}`); params.push(title); }
    if (dueDate !== undefined) { updates.push(`"dueDate" = $${i++}`); params.push(dueDate); }
    if (category !== undefined) { updates.push(`category = $${i++}`); params.push(category); }
    if (notes !== undefined) { updates.push(`notes = $${i++}`); params.push(notes); }
    if (updates.length === 0) {
      return { success: false, message: `Found task "${target.title}" but no fields to update were specified.` };
    }
    params.push(target.id, ctx.user.id);
    const result = await ctx.db.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${i++} AND user_id = $${i++} RETURNING *`,
      params
    );
    // Build a friendly field list for the message — describe the
    // logical AI-side fields, not the column-level updates.
    const labels = [];
    if (status !== undefined) labels.push(`status: ${status}`);
    if (title !== undefined) labels.push('title');
    if (dueDate !== undefined) labels.push('dueDate');
    if (category !== undefined) labels.push('category');
    if (notes !== undefined) labels.push('notes');
    const more = matches.rows.length > 1 ? ` (matched ${matches.rows.length} tasks; updated "${target.title}")` : '';
    return {
      success: true,
      data: result.rows[0],
      message: `Updated task: ${target.title} → ${labels.join(', ')}${more}`
    };
  }
});

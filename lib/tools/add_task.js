// lib/tools/add_task.js
//
// The tasks table uses camelCase column "dueDate" (quoted) and a
// boolean `done` column rather than a status enum. Defaults for
// optional fields mirror the Session A schema relaxation: category
// defaults to 'other' and dueDate defaults to today + 7 days.
const registry = require('../tool-registry');

function defaultDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

registry.register({
  name: 'add_task',
  description: 'Create a new task. Tasks are todo items the user wants to track. Examples: "call the electrician", "review insurance renewal", "follow up with Maria about her lease".',
  vertical: 'core',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Task title.' },
      category: { type: 'string', enum: ['vendor', 'maintenance', 'lease', 'finance', 'other'], description: "Optional. Category of the task. Defaults to 'other' if not provided." },
      dueDate: { type: 'string', description: "Optional. Due date in YYYY-MM-DD format. If a date is mentioned in natural language ('tomorrow', 'next Friday'), interpret it. Defaults to 7 days from today if not provided." },
      notes: { type: 'string', description: 'Optional. Additional notes or details.' }
    },
    required: ['title']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const title = input.title;
    if (!title) {
      return { success: false, message: 'Missing required field: title.' };
    }
    const category = (input.category && String(input.category).trim()) || 'other';
    const dueDate = input.dueDate || defaultDueDate();
    const notes = input.notes || '';
    const result = await ctx.db.query(
      `INSERT INTO tasks (user_id, title, category, "dueDate", notes, done, suggested, "aiReason")
       VALUES ($1, $2, $3, $4, $5, false, false, '')
       RETURNING *`,
      [ctx.user.id, title, category, dueDate, notes]
    );
    return {
      success: true,
      data: result.rows[0],
      message: `Added task: ${title} (due ${dueDate})`
    };
  }
});

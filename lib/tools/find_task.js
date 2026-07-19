// lib/tools/find_task.js — AP3 read tool.
// Thin SELECT over the tasks table with the same filters the Tasks
// screen offers (all / pending / done / overdue, category, free text).

const registry = require('../tool-registry');

registry.register({
  name: 'find_task',
  description: 'Search the owner tasks list. Filter by status (pending / done / overdue), category, and/or a free-text query over title and notes. Returns up to 20 compact rows and notes how many more matched.',
  vertical: 'core',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional free text matched against title and notes.' },
      status: { type: 'string', enum: ['pending', 'done', 'overdue'] },
      category: { type: 'string' },
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const where = ['user_id = $1'];
    const params = [ctx.user.id];
    let i = 2;
    if (input.status === 'pending') where.push('done = false');
    else if (input.status === 'done') where.push('done = true');
    else if (input.status === 'overdue') {
      where.push('done = false');
      where.push(`"dueDate" <> '' AND "dueDate" < $${i++}`);
      params.push(new Date().toISOString().slice(0, 10));
    }
    if (input.category) {
      where.push(`LOWER(category) = $${i++}`);
      params.push(String(input.category).toLowerCase());
    }
    if (input.query) {
      where.push(`(LOWER(title) LIKE $${i} OR LOWER(COALESCE(notes, '')) LIKE $${i})`);
      params.push('%' + String(input.query).toLowerCase() + '%');
      i++;
    }
    const r = await ctx.db.query(
      `SELECT id, title, category, "dueDate", done, notes
         FROM tasks WHERE ${where.join(' AND ')}
        ORDER BY done ASC, "dueDate" ASC, id DESC
        LIMIT 21`,
      params
    );
    const capped = r.rows.length > 20;
    const rows = capped ? r.rows.slice(0, 20) : r.rows;
    if (!rows.length) return { success: true, data: { tasks: [] }, message: 'No matching tasks.' };
    const lines = rows.slice(0, 8).map(t => `#${t.id} ${t.done ? '[done] ' : ''}${t.title}${t.dueDate ? ' (due ' + t.dueDate + ')' : ''}`);
    return {
      success: true,
      data: { tasks: rows },
      message: `Found ${rows.length}${capped ? '+' : ''} task(s): ${lines.join('; ')}${capped ? ' — more matching not shown' : ''}`,
    };
  },
});

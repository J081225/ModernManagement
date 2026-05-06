// lib/tools/add_calendar_event.js
//
// Note on schema: the cal_events table has only (user_id, date, title)
// columns today. Optional fields the tool schema accepts (time, notes,
// category) are not yet persisted — they're declared for forward
// compatibility but ignored by the executor until the schema gains
// those columns. The executor stores only what the table supports.
const registry = require('../tool-registry');

registry.register({
  name: 'add_calendar_event',
  description: 'Add an event to the calendar. Use this when the user wants to schedule a meeting, appointment, or any time-bound event.',
  vertical: 'core',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title (e.g. "Board meeting", "Inspector visit").' },
      date: { type: 'string', description: 'Date in YYYY-MM-DD format. If the user mentions a relative date ("next Friday"), interpret it.' }
    },
    required: ['title', 'date']
  },
  navigationPolicy: 'home_only',
  navigateTo: { page: 'calendar', focus: { type: 'date', date: '$date' } },
  async execute(input, ctx) {
    const { title, date } = input;
    if (!title || !date) {
      return { success: false, message: 'Missing required fields: title and date.' };
    }
    const result = await ctx.db.query(
      `INSERT INTO cal_events (user_id, date, title)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [ctx.user.id, date, title]
    );
    const event = result.rows[0];
    return {
      success: true,
      data: event,
      message: `Added calendar event: ${title} on ${date}`,
      navigateHint: { page: 'calendar', focus: { type: 'date', date } }
    };
  }
});

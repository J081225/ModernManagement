// lib/tools/delete_calendar_event.js
const registry = require('../tool-registry');

registry.register({
  name: 'delete_calendar_event',
  description: 'Delete a calendar event. Use this when the user wants to cancel, remove, or delete an event. The user identifies the event by its title and optionally a date.',
  vertical: 'core',
  category: 'delete',
  schema: {
    type: 'object',
    properties: {
      event: { type: 'string', description: 'Title or partial title of the event to delete.' },
      date: { type: 'string', description: 'Optional. Date in YYYY-MM-DD format to disambiguate when multiple events have similar titles.' }
    },
    required: ['event']
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    const { event, date } = input;
    if (!event) {
      return { success: false, message: 'No event identifier provided.' };
    }
    // Fuzzy-match against current user's events. The cal_events
    // schema is (user_id, date, title) — scope by user_id.
    let query = `SELECT * FROM cal_events WHERE user_id = $1 AND LOWER(title) LIKE $2`;
    const params = [ctx.user.id, `%${event.toLowerCase()}%`];
    if (date) {
      query += ` AND date = $3`;
      params.push(date);
    }
    query += ` ORDER BY date ASC LIMIT 5`;
    const matches = await ctx.db.query(query, params);
    if (matches.rows.length === 0) {
      return { success: false, message: `No calendar event found matching "${event}"${date ? ` on ${date}` : ''}.` };
    }
    const target = matches.rows[0];
    await ctx.db.query(
      `DELETE FROM cal_events WHERE id = $1 AND user_id = $2`,
      [target.id, ctx.user.id]
    );
    const more = matches.rows.length > 1 ? ` (matched ${matches.rows.length} events; deleted the first)` : '';
    return {
      success: true,
      data: { id: target.id, title: target.title, date: target.date },
      message: `Deleted event: ${target.title} (${target.date})${more}`
    };
  }
});

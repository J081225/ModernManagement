// lib/tools/delete_calendar_event.js
const registry = require('../tool-registry');

registry.register({
  name: 'delete_calendar_event',
  description: 'Delete a calendar event. Prefer event_id (from screen context or a prior listing). Otherwise identify by EXACT title (case-insensitive) and optionally a date — if multiple events match, nothing is deleted and the candidates are returned so the owner can pick.',
  vertical: 'core',
  category: 'delete',
  schema: {
    type: 'object',
    properties: {
      event_id: { type: 'integer', description: 'Preferred. Exact cal_events id.' },
      event: { type: 'string', description: 'Exact event title (case-insensitive). Never a partial match.' },
      date: { type: 'string', description: 'Optional. Date in YYYY-MM-DD format to disambiguate.' }
    },
  },
  navigationPolicy: 'never',
  navigateTo: null,
  async execute(input, ctx) {
    // FD2 belt-and-suspenders: destructive fuzzy-match delete is
    // owner-only, drift-proof.
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      return { success: false, message: 'Only the business owner can delete calendar events.' };
    }
    const { event, date } = input;
    // AP3 precision rules: id first; otherwise EXACT title match only.
    // Multiple candidates → list them and delete nothing. The old
    // "deleted the first of up to five fuzzy matches" behavior is gone.
    if (input.event_id) {
      const r = await ctx.db.query(
        `DELETE FROM cal_events WHERE id = $1 AND user_id = $2 RETURNING id, title, date`,
        [input.event_id, ctx.user.id]
      );
      if (!r.rows.length) return { success: false, message: `No calendar event with id ${input.event_id}.` };
      return { success: true, data: { id: r.rows[0].id, title: r.rows[0].title, date: r.rows[0].date }, message: `Deleted event: ${r.rows[0].title} (${r.rows[0].date})` };
    }
    if (!event) {
      return { success: false, message: 'Provide event_id or an exact event title.' };
    }
    let query = `SELECT id, title, date, event_type FROM cal_events WHERE user_id = $1 AND LOWER(title) = LOWER($2)`;
    const params = [ctx.user.id, String(event).trim()];
    if (date) {
      query += ` AND date = $3`;
      params.push(date);
    }
    query += ` ORDER BY date ASC LIMIT 6`;
    const matches = await ctx.db.query(query, params);
    if (matches.rows.length === 0) {
      return { success: false, message: `No calendar event titled exactly "${event}"${date ? ` on ${date}` : ''}.` };
    }
    if (matches.rows.length > 1) {
      const list = matches.rows.map(m => `#${m.id} "${m.title}" on ${m.date}`).join('; ');
      return { success: false, data: { candidates: matches.rows }, message: `Multiple events match "${event}" — nothing deleted. Which one? ${list}` };
    }
    const target = matches.rows[0];
    await ctx.db.query(
      `DELETE FROM cal_events WHERE id = $1 AND user_id = $2`,
      [target.id, ctx.user.id]
    );
    return {
      success: true,
      data: { id: target.id, title: target.title, date: target.date },
      message: `Deleted event: ${target.title} (${target.date})`
    };
  }
});

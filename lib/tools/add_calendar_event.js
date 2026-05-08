// lib/tools/add_calendar_event.js
//
// Adds a generic calendar event. Used by both PM and PS verticals
// (vertical='core'), so the executor stays minimal and backward-compatible
// with the legacy schema.
//
// Schema reality (post-E2 / migration 034):
//   cal_events columns now include workspace_id, starts_at, ends_at,
//   is_all_day, event_type, appointment_id alongside the legacy
//   (user_id, date, title) trio. The legacy `date` TEXT column is still
//   the column the calendar UI reads today, so the executor keeps writing
//   it. New columns are populated with safe defaults so the unified
//   calendar (used by the appointment engine for conflict detection)
//   sees this row alongside appointment-backed events.
//
// Defaults written for new columns:
//   - workspace_id: ctx.workspace.id when present (the AI command bar
//     resolves this; null is acceptable for legacy callers).
//   - starts_at / ends_at: midnight-to-midnight on the supplied date.
//     is_all_day=TRUE so propose_appointment_times treats the day as
//     blocked (the legacy semantic — these are all-day reminders).
//   - event_type: 'general'.
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

    // E2: derive starts_at / ends_at as the date's midnight-to-midnight
    // window so the unified-calendar conflict detector sees this event.
    // If the supplied date is malformed, we still INSERT but leave the
    // new timestamp columns null — backward-compatible with pre-E2 rows.
    let starts_at = null;
    let ends_at = null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const d = new Date(`${date}T00:00:00.000Z`);
      if (!isNaN(d.getTime())) {
        starts_at = d.toISOString();
        ends_at = new Date(d.getTime() + 24 * 60 * 60 * 1000).toISOString();
      }
    }
    const workspace_id = (ctx.workspace && ctx.workspace.id) || null;

    const result = await ctx.db.query(
      `INSERT INTO cal_events
         (user_id, workspace_id, date, title, starts_at, ends_at, is_all_day, event_type)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'general')
       RETURNING *`,
      [ctx.user.id, workspace_id, date, title, starts_at, ends_at]
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

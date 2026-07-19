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
//   it. New columns are populated with real values so the unified
//   calendar (used by the appointment engine for conflict detection)
//   sees this row alongside appointment-backed events.
//
// event_type semantics:
//   - 'general'  — the default, for reminders and misc events.
//   - 'time_off' — the owner is unavailable. The engine already treats
//     all cal_events as busy (propose_appointment_times.js:44-67), so
//     time_off blocks are automatically respected — nothing extra to do
//     here beyond storing the type so the UI can render it distinctly.
//   - 'personal' — private reminder; same busy semantics as general.
//
// Partial-day blocks: pass start_time + end_time together (HH:mm 24h)
// for a 2-4pm block. Omit both for an all-day event. The times are
// parsed as wall-clock in the workspace's timezone via toZonedISO so
// "block 2pm" means 2pm local, not 2pm UTC.
const registry = require('../tool-registry');
const { wsTz, toZonedISO } = require('../time-helpers');

const ALLOWED_EVENT_TYPES = ['general', 'time_off', 'personal'];

registry.register({
  name: 'add_calendar_event',
  description: 'Add an event to the calendar. Can create general reminders, personal events, or "time_off" blocks that make the slot(s) unbookable by the appointment engine. Pass start_time and end_time together (HH:mm 24h) for a partial-day block like 2pm-4pm; omit both for an all-day event. For a multi-day block ("Monday through Wednesday"), pass date + end_date in ONE call.',
  vertical: 'core',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title (e.g. "Board meeting", "Inspector visit", "Time off").' },
      date: { type: 'string', description: 'Date in YYYY-MM-DD format. If the user mentions a relative date ("next Friday"), interpret it.' },
      event_type: {
        type: 'string',
        enum: ALLOWED_EVENT_TYPES,
        description: "Use 'time_off' when the owner wants time blocked off / unavailable — e.g. 'I need the 25th off'. Use 'personal' for a private reminder. Defaults to 'general'."
      },
      start_time: {
        type: 'string',
        description: "For partial-day blocks like 2pm-4pm pass 14:00. Omit (along with end_time) for an all-day event."
      },
      end_time: {
        type: 'string',
        description: "For partial-day blocks like 2pm-4pm pass 16:00. Omit (along with start_time) for an all-day event."
      },
      end_date: {
        type: 'string',
        description: 'Optional. Last date (YYYY-MM-DD) of a multi-day range — one event row is created per day, 31-day cap. "Block off next week" is one call with date + end_date.'
      }
    },
    required: ['title', 'date']
  },
  navigationPolicy: 'home_only',
  navigateTo: { page: 'calendar', focus: { type: 'date', date: '$date' } },
  async execute(input, ctx) {
    const { title, date } = input;
    const event_type = input.event_type || 'general';
    const start_time = input.start_time;
    const end_time = input.end_time;

    if (!title || !date) {
      return { success: false, message: 'Missing required fields: title and date.' };
    }
    if (!ALLOWED_EVENT_TYPES.includes(event_type)) {
      return { success: false, message: `event_type must be one of ${ALLOWED_EVENT_TYPES.join(', ')}.` };
    }
    // CP6 belt-and-suspenders: the customer-facing engine no longer
    // lists this tool at all, but even if an allowlist drifts, an
    // inbound customer conversation can never create calendar entries.
    if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
      return { success: false, message: 'Only the business owner can add calendar entries or block off time. Let the owner know if you need a time held.' };
    }
    if ((start_time && !end_time) || (!start_time && end_time)) {
      return { success: false, message: 'Pass both start_time and end_time for a partial-day block, or neither for an all-day event.' };
    }

    const tz = wsTz(ctx.workspace);
    let starts_at = null;
    let ends_at = null;
    let is_all_day = true;

    if (start_time && end_time) {
      const s = toZonedISO(`${date}T${start_time}:00`, tz);
      const e = toZonedISO(`${date}T${end_time}:00`, tz);
      if (!s || !e) {
        return { success: false, message: 'Invalid start_time / end_time (expected HH:mm 24-hour, e.g. 14:00).' };
      }
      if (new Date(e).getTime() <= new Date(s).getTime()) {
        return { success: false, message: 'end_time must be after start_time.' };
      }
      starts_at = s;
      ends_at = e;
      is_all_day = false;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // All-day fallback: midnight-to-midnight in the workspace tz so the
      // conflict detector sees a full-day block, not a 5am-5am UTC window.
      starts_at = toZonedISO(`${date}T00:00:00`, tz);
      if (starts_at) {
        ends_at = new Date(new Date(starts_at).getTime() + 24 * 60 * 60 * 1000).toISOString();
      }
    }
    const workspace_id = (ctx.workspace && ctx.workspace.id) || null;

    // AP3: multi-day range — one row per day, mirroring the UI's
    // submitBlockOff loop (31-day cap). Single-day calls behave exactly
    // as before.
    const days = [date];
    if (input.end_date && /^\d{4}-\d{2}-\d{2}$/.test(input.end_date)) {
      if (input.end_date < date) {
        return { success: false, message: 'end_date must be on or after date.' };
      }
      let cursor = date;
      while (cursor < input.end_date && days.length <= 31) {
        const [y, m, d] = cursor.split('-').map(Number);
        const next = new Date(Date.UTC(y, m - 1, d) + 86400000);
        cursor = next.getUTCFullYear() + '-' + String(next.getUTCMonth() + 1).padStart(2, '0') + '-' + String(next.getUTCDate()).padStart(2, '0');
        days.push(cursor);
      }
      if (days.length > 31) {
        return { success: false, message: 'That range is longer than 31 days — block it in smaller chunks.' };
      }
    }

    let event = null;
    for (const dayKey of days) {
      let dayStarts = starts_at;
      let dayEnds = ends_at;
      if (dayKey !== date) {
        if (!is_all_day) {
          dayStarts = toZonedISO(`${dayKey}T${start_time}:00`, tz);
          dayEnds = toZonedISO(`${dayKey}T${end_time}:00`, tz);
        } else {
          dayStarts = toZonedISO(`${dayKey}T00:00:00`, tz);
          dayEnds = dayStarts ? new Date(new Date(dayStarts).getTime() + 24 * 60 * 60 * 1000).toISOString() : null;
        }
      }
      const result = await ctx.db.query(
        `INSERT INTO cal_events
           (user_id, workspace_id, date, title, starts_at, ends_at, is_all_day, event_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [ctx.user.id, workspace_id, dayKey, title, dayStarts, dayEnds, is_all_day, event_type]
      );
      if (!event) event = result.rows[0];
    }

    // Format the success message in the workspace timezone so the AI
    // relays local wall-clock times, not the server-side UTC rendering.
    const dateLabel = starts_at
      ? new Date(starts_at).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' })
      : date;
    const verb = event_type === 'time_off' ? 'Blocked off' : 'Added';
    const suffix = event_type === 'time_off'
      ? ' — customers cannot be booked during this time.'
      : '';
    const rangeNote = days.length > 1 ? ` and ${days.length - 1} more day(s) through ${days[days.length - 1]}` : '';
    let msg;
    if (is_all_day) {
      msg = `${verb} ${dateLabel}${rangeNote} all day (${title})${suffix}`;
    } else {
      const t1 = new Date(starts_at).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
      const t2 = new Date(ends_at).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
      msg = `${verb} ${dateLabel}${rangeNote} from ${t1} to ${t2} each day (${title})${suffix}`;
    }

    return {
      success: true,
      data: event,
      message: msg,
      navigateHint: { page: 'calendar', focus: { type: 'date', date } }
    };
  }
});

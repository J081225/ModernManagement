// lib/tools/propose_appointment_times.js
//
// Reads the calendar (cal_events) and proposes 2-3 open slots per day
// for a given duration — a single target date or a start/end range
// (max 7 days). Does NOT create anything. The AI relays the
// suggestions; booking goes through book_appointment, which performs
// its own ATOMIC conflict check at write time (BK1).
//
// Window semantics (BK2): window_start/window_end bound the slot
// START; the business day bounds the END. window_end is EXCLUSIVE
// ("before 3 PM" never offers a 3:00 start) — EXCEPT the point query:
// window_start == window_end asks "is this exact start free?".

const registry = require('../tool-registry');
const { wsTz, toZonedISO } = require('../time-helpers');

const DEFAULT_DAY_START_HOUR = 9;
const DEFAULT_DAY_END_HOUR = 18;
const SLOT_GRANULARITY_MINUTES = 30;
const MAX_RANGE_DAYS = 7;

registry.register({
  name: 'propose_appointment_times',
  description: 'Propose 2-3 open time slots per day for an appointment of a given duration. Reads the calendar and avoids conflicts. Use target_date for one day, or start_date + end_date (max 7 days) for a multi-day ask — never answer a range with a single day. If the customer states a time window or preference (e.g. "between 5 and 7 PM", "after 4", "morning"), ALWAYS pass it via window_start/window_end — never call without the window when one was stated; window_end is exclusive for starts. To check ONE exact time, pass window_start == window_end. Does NOT book anything.',
  vertical: 'professional-services',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      target_date: { type: 'string', description: 'YYYY-MM-DD. A single day. Use start_date/end_date instead for a range.' },
      start_date: { type: 'string', description: 'YYYY-MM-DD. First day of a multi-day range (with end_date, max 7 days).' },
      end_date: { type: 'string', description: 'YYYY-MM-DD, inclusive. Requires start_date.' },
      duration_minutes: { type: 'integer' },
      max_slots: { type: 'integer', description: 'Per day. Default 3.' },
      window_start: { type: 'string', description: 'Optional. Earliest acceptable START time the customer stated, HH:MM 24-hour wall clock in the business timezone (e.g. "17:00" for "after 5 PM").' },
      window_end: { type: 'string', description: 'Optional. EXCLUSIVE upper bound for the START ("15:00" for "before 3 PM" — a 3:00 start is not offered). Equal to window_start = point query for that exact start.' },
    },
    required: ['duration_minutes'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const { duration_minutes } = input;
    const max_slots = input.max_slots || 3;
    if (!duration_minutes) {
      return { success: false, message: 'duration_minutes required.' };
    }

    // BK2c: one day (target_date) or an ordered range (start/end, cap 7).
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    let dates = [];
    let rangeNote = '';
    if (input.start_date || input.end_date) {
      if (!input.start_date || !input.end_date) {
        return { success: false, message: 'start_date and end_date must be given together.' };
      }
      if (!DATE_RE.test(input.start_date) || !DATE_RE.test(input.end_date)) {
        return { success: false, message: 'start_date/end_date must be YYYY-MM-DD.' };
      }
      if (input.end_date < input.start_date) {
        return { success: false, message: 'end_date must not be before start_date.' };
      }
      let d = new Date(input.start_date + 'T00:00:00Z');
      const last = new Date(input.end_date + 'T00:00:00Z');
      while (d <= last && dates.length < MAX_RANGE_DAYS) {
        dates.push(d.toISOString().slice(0, 10));
        d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
      }
      if (d <= last) rangeNote = ` (first ${MAX_RANGE_DAYS} days of the requested range)`;
    } else if (input.target_date) {
      if (!DATE_RE.test(input.target_date)) {
        return { success: false, message: `Could not parse target_date "${input.target_date}".` };
      }
      dates = [input.target_date];
    } else {
      return { success: false, message: 'target_date (or start_date + end_date) required.' };
    }

    const tz = wsTz(ctx.workspace);
    const HHMM = /^(\d{1,2}):(\d{2})$/;
    const toMin = (s) => { const m = HHMM.exec(String(s).trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    const fmtMin = (min) => {
      const h = Math.floor(min / 60), mm = String(min % 60).padStart(2, '0');
      return `${(h % 12) || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
    };
    const bizStartMin = DEFAULT_DAY_START_HOUR * 60;
    const bizEndMin = DEFAULT_DAY_END_HOUR * 60;
    let winStartMin = null, winEndMin = null;
    if (input.window_start != null && input.window_start !== '') {
      winStartMin = toMin(input.window_start);
      if (winStartMin === null) return { success: false, message: `window_start "${input.window_start}" is not HH:MM.` };
    }
    if (input.window_end != null && input.window_end !== '') {
      winEndMin = toMin(input.window_end);
      if (winEndMin === null) return { success: false, message: `window_end "${input.window_end}" is not HH:MM.` };
    }
    // BK2b: equal bounds = a POINT query ("is this exact start free?").
    // Only an INVERTED window is an error.
    if (winStartMin !== null && winEndMin !== null && winStartMin > winEndMin) {
      return { success: false, message: 'window_start must be earlier than window_end.' };
    }
    const isPoint = winStartMin !== null && winEndMin !== null && winStartMin === winEndMin;
    const hasWindow = winStartMin !== null || winEndMin !== null;
    const windowText = isPoint
      ? ` at ${fmtMin(winStartMin)}`
      : hasWindow
        ? ` between ${fmtMin(winStartMin === null ? bizStartMin : winStartMin)} and ${fmtMin(winEndMin === null ? bizEndMin : winEndMin)}`
        : '';

    // Earliest allowed START / upper bound for the START (exclusive
    // unless point). The window is date-independent, so an
    // outside-business-day window short-circuits before any scan.
    const startLowerMin = Math.max(bizStartMin, winStartMin === null ? bizStartMin : winStartMin);
    const startUpperMin = Math.min(bizEndMin, winEndMin === null ? bizEndMin : winEndMin);
    const outside = isPoint
      ? (winStartMin < bizStartMin || winStartMin >= bizEndMin)
      : (startLowerMin >= bizEndMin || startUpperMin <= bizStartMin);
    if (outside) {
      return {
        success: true,
        data: { slots: [], reason: 'window_outside_business_day' },
        message: `No slots${windowText} on ${dates[0]}${dates.length > 1 ? '–' + dates[dates.length - 1] : ''} — that window falls outside the business day (${fmtMin(bizStartMin)}–${fmtMin(bizEndMin)}).`,
      };
    }

    const slotMs = SLOT_GRANULARITY_MINUTES * 60 * 1000;
    const durationMs = duration_minutes * 60 * 1000;

    // BH0 (rung 1): closed weekdays. A closed day is NAMED, never a
    // silent gap — the caller hears "we're closed Mondays".
    const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const closedSet = new Set(ctx.workspace.closed_weekdays || []);
    const dowOf = (dateStr) => new Date(dateStr + 'T00:00:00Z').getUTCDay();

    // One day's scan: bounds -> events -> full-range collect -> spread.
    const scanDay = async (dateStr) => {
      const wallFromMin = (min) => `${dateStr}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
      const scanStartIso = toZonedISO(wallFromMin(startLowerMin), tz);
      const startUpperIso = toZonedISO(wallFromMin(startUpperMin), tz);
      const dayEndIso = toZonedISO(wallFromMin(bizEndMin), tz);
      if (!scanStartIso || !startUpperIso || !dayEndIso) return { parseFailed: true };
      const dayStart = new Date(scanStartIso);
      const startUpper = new Date(startUpperIso);
      const dayEnd = new Date(dayEndIso);

      // CP5: canceled appointments keep their cal_events row (rendered
      // grayed on the calendar) but must not block availability.
      const events = await ctx.db.query(
        `SELECT ce.starts_at, ce.ends_at, ce.is_all_day
           FROM cal_events ce
           LEFT JOIN appointments a ON a.id = ce.appointment_id
          WHERE ce.workspace_id = $1
            AND ce.starts_at < $2 AND ce.ends_at > $3
            AND (a.id IS NULL OR a.status IS DISTINCT FROM 'canceled')
          ORDER BY ce.starts_at ASC`,
        [ctx.workspace.id, dayEnd.toISOString(), dayStart.toISOString()]
      );
      if (events.rows.some((e) => e.is_all_day)) return { blocked: true, slots: [] };

      // DS1: scan the FULL range (no early break — afternoons must be
      // reachable). BK2d: the upper bound is EXCLUSIVE for starts,
      // except a point query, which tests exactly one start.
      const open = [];
      for (let cursor = dayStart.getTime();
           (isPoint ? cursor <= startUpper.getTime() : cursor < startUpper.getTime())
             && cursor + durationMs <= dayEnd.getTime();
           cursor += slotMs) {
        const conflict = events.rows.some((e) => {
          const eStart = new Date(e.starts_at).getTime();
          const eEnd = new Date(e.ends_at).getTime();
          return cursor < eEnd && cursor + durationMs > eStart;
        });
        if (!conflict) open.push({ starts_at: new Date(cursor).toISOString(), ends_at: new Date(cursor + durationMs).toISOString() });
      }

      // Endpoint-inclusive spread over the OPEN list: first, middles,
      // last — the latest open slot is always proposable.
      let picked = [];
      if (open.length === 0) picked = [];
      else if (open.length <= max_slots) picked = open;
      else if (max_slots === 1) picked = [open[0]];
      else {
        const idxs = new Set();
        for (let i = 0; i < max_slots; i++) {
          idxs.add(Math.round((i * (open.length - 1)) / (max_slots - 1)));
        }
        picked = [...idxs].sort((a, b) => a - b).map((i) => open[i]);
      }
      const niceList = picked
        .map((s) => new Date(s.starts_at).toLocaleString('en-US', {
          timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
        }))
        .join(', ');
      return { blocked: false, slots: picked, niceList };
    };

    // Single day: the pre-range return shapes, byte-compatible.
    if (dates.length === 1) {
      if (closedSet.has(dowOf(dates[0]))) {
        const dayName = WEEKDAYS[dowOf(dates[0])];
        return {
          success: true,
          data: { slots: [], reason: 'closed_that_day' },
          message: `No slots on ${dates[0]} — the business is closed on ${dayName}s.`,
        };
      }
      const day = await scanDay(dates[0]);
      if (day.parseFailed) return { success: false, message: `Could not parse target_date "${dates[0]}".` };
      if (day.blocked) return { success: true, data: { slots: [] }, message: `${dates[0]} is fully blocked.` };
      if (day.slots.length === 0) {
        return {
          success: true,
          data: { slots: [], reason: 'no_open_slots' },
          message: `No open ${duration_minutes}-minute slots${windowText} on ${dates[0]}.`,
        };
      }
      return {
        success: true,
        data: { slots: day.slots },
        message: `Open ${duration_minutes}-minute slots on ${dates[0]}${windowText}: ${day.niceList}.`,
      };
    }

    // BK2c: the range — per-day slots, every day named (a day with
    // nothing says so; one day is NEVER presented as the range).
    const days = [];
    const parts = [];
    for (const dateStr of dates) {
      if (closedSet.has(dowOf(dateStr))) {
        days.push({ date: dateStr, slots: [], closed: true });
        parts.push(`${dateStr} — closed (${WEEKDAYS[dowOf(dateStr)]})`);
        continue;
      }
      const day = await scanDay(dateStr);
      if (day.parseFailed) return { success: false, message: `Could not parse date "${dateStr}".` };
      days.push({ date: dateStr, slots: day.blocked ? [] : day.slots, blocked: !!day.blocked });
      parts.push(`${dateStr} — ${day.blocked ? 'fully blocked' : (day.slots.length ? day.niceList : 'none')}`);
    }
    const anySlots = days.some((d) => d.slots.length);
    return {
      success: true,
      data: { days, slots: days.flatMap((d) => d.slots), reason: anySlots ? undefined : 'no_open_slots' },
      message: `Open ${duration_minutes}-minute slots${windowText}, ${dates[0]} to ${dates[dates.length - 1]}${rangeNote}: ${parts.join('; ')}.`,
    };
  },
});

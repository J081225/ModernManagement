// lib/tools/propose_appointment_times.js
//
// Reads the calendar (cal_events) and proposes 2-3 open slots for a given
// duration on a target day. Does NOT create anything. The AI relays the
// suggestions to the customer and chooses one before calling
// book_appointment.

const registry = require('../tool-registry');
const { wsTz, toZonedISO } = require('../time-helpers');

const DEFAULT_DAY_START_HOUR = 9;
const DEFAULT_DAY_END_HOUR = 18;
const SLOT_GRANULARITY_MINUTES = 30;

registry.register({
  name: 'propose_appointment_times',
  description: 'Propose 2-3 open time slots on a target date for an appointment of a given duration. Reads the calendar and avoids slots that conflict with existing events. Use when a customer asks for availability or you need to suggest times. If the customer states a time window or preference (e.g. "between 5 and 7 PM", "after 4", "morning"), ALWAYS pass it via window_start/window_end — never call without the window when one was stated. Does NOT book anything.',
  vertical: 'professional-services',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      target_date: { type: 'string', description: 'YYYY-MM-DD.' },
      duration_minutes: { type: 'integer' },
      max_slots: { type: 'integer', description: 'Default 3.' },
      window_start: { type: 'string', description: 'Optional. Earliest acceptable START time the customer stated, HH:MM 24-hour wall clock in the business timezone (e.g. "17:00" for "after 5 PM").' },
      window_end: { type: 'string', description: 'Optional. Latest acceptable START time the customer stated, HH:MM 24-hour (e.g. "19:00" for "by 7 PM" — the appointment may end after this, but must fit the business day).' },
    },
    required: ['target_date', 'duration_minutes'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const { target_date, duration_minutes } = input;
    const max_slots = input.max_slots || 3;
    if (!target_date || !duration_minutes) {
      return { success: false, message: 'target_date and duration_minutes required.' };
    }

    // Build the day window as wall-clock times IN the workspace timezone,
    // not as naive strings on a UTC server. Otherwise slots come back as
    // 9 AM–6 PM UTC (i.e. 5 AM–2 PM Eastern), which is wrong.
    const tz = wsTz(ctx.workspace);

    // DS1: optional caller time window (HH:MM wall clock). The window
    // bounds the slot START; the business day bounds the slot END. Scan
    // range = intersection; an empty intersection is reported honestly
    // with a reason instead of silently falling back to the whole day.
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
    if (winStartMin !== null && winEndMin !== null && winStartMin >= winEndMin) {
      return { success: false, message: 'window_start must be earlier than window_end.' };
    }
    const hasWindow = winStartMin !== null || winEndMin !== null;
    const windowText = hasWindow
      ? ` between ${fmtMin(winStartMin === null ? bizStartMin : winStartMin)} and ${fmtMin(winEndMin === null ? bizEndMin : winEndMin)}`
      : '';
    // Earliest allowed START / latest allowed START.
    const startLowerMin = Math.max(bizStartMin, winStartMin === null ? bizStartMin : winStartMin);
    const startUpperMin = Math.min(bizEndMin, winEndMin === null ? bizEndMin : winEndMin);
    if (startLowerMin >= bizEndMin || startUpperMin <= bizStartMin) {
      return {
        success: true,
        data: { slots: [], reason: 'window_outside_business_day' },
        message: `No slots${windowText} on ${target_date} — that window falls outside the business day (${fmtMin(bizStartMin)}–${fmtMin(bizEndMin)}).`,
      };
    }

    const wallFromMin = (min) => `${target_date}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00`;
    const scanStartIso = toZonedISO(wallFromMin(startLowerMin), tz);
    const startUpperIso = toZonedISO(wallFromMin(startUpperMin), tz);
    const dayEndIso = toZonedISO(wallFromMin(bizEndMin), tz);
    if (!scanStartIso || !startUpperIso || !dayEndIso) {
      return { success: false, message: `Could not parse target_date "${target_date}".` };
    }
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

    if (events.rows.some((e) => e.is_all_day)) {
      return { success: true, data: { slots: [] }, message: `${target_date} is fully blocked.` };
    }

    // DS1: scan the FULL range — the old early break (stop after the
    // first few open slots) made afternoons structurally unreachable
    // (the demo-call bug). Collect every open slot, THEN spread-pick.
    const open = [];
    const slotMs = SLOT_GRANULARITY_MINUTES * 60 * 1000;
    const durationMs = duration_minutes * 60 * 1000;
    for (let cursor = dayStart.getTime();
         cursor <= startUpper.getTime() && cursor + durationMs <= dayEnd.getTime();
         cursor += slotMs) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(cursor + durationMs);
      const conflict = events.rows.some((e) => {
        const eStart = new Date(e.starts_at).getTime();
        const eEnd = new Date(e.ends_at).getTime();
        return cursor < eEnd && cursor + durationMs > eStart;
      });
      if (!conflict) open.push({ starts_at: slotStart.toISOString(), ends_at: slotEnd.toISOString() });
    }

    // Endpoint-inclusive spread: first, evenly-spaced middles, LAST —
    // so the latest open slot of the range is always proposable.
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

    if (picked.length === 0) {
      return {
        success: true,
        data: { slots: [], reason: 'no_open_slots' },
        message: `No open ${duration_minutes}-minute slots${windowText} on ${target_date}.`,
      };
    }

    // Format slot times in the workspace timezone so the AI reads and
    // relays correct local times.
    const niceList = picked
      .map((s) => new Date(s.starts_at).toLocaleString('en-US', {
        timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
      }))
      .join(', ');
    return {
      success: true,
      data: { slots: picked },
      message: `Open ${duration_minutes}-minute slots on ${target_date}${windowText}: ${niceList}.`,
    };
  },
});

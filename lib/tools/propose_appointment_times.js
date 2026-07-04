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
  description: 'Propose 2-3 open time slots on a target date for an appointment of a given duration. Reads the calendar and avoids slots that conflict with existing events. Use when a customer asks for availability or you need to suggest times. Does NOT book anything.',
  vertical: 'professional-services',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      target_date: { type: 'string', description: 'YYYY-MM-DD.' },
      duration_minutes: { type: 'integer' },
      max_slots: { type: 'integer', description: 'Default 3.' },
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
    const startWall = `${target_date}T${String(DEFAULT_DAY_START_HOUR).padStart(2, '0')}:00:00`;
    const endWall   = `${target_date}T${String(DEFAULT_DAY_END_HOUR).padStart(2, '0')}:00:00`;
    const dayStartIso = toZonedISO(startWall, tz);
    const dayEndIso   = toZonedISO(endWall, tz);
    if (!dayStartIso || !dayEndIso) {
      return { success: false, message: `Could not parse target_date "${target_date}".` };
    }
    const dayStart = new Date(dayStartIso);
    const dayEnd   = new Date(dayEndIso);

    const events = await ctx.db.query(
      `SELECT starts_at, ends_at, is_all_day FROM cal_events
        WHERE workspace_id = $1
          AND starts_at < $2 AND ends_at > $3
        ORDER BY starts_at ASC`,
      [ctx.workspace.id, dayEnd.toISOString(), dayStart.toISOString()]
    );

    if (events.rows.some((e) => e.is_all_day)) {
      return { success: true, data: { slots: [] }, message: `${target_date} is fully blocked.` };
    }

    const open = [];
    const slotMs = SLOT_GRANULARITY_MINUTES * 60 * 1000;
    const durationMs = duration_minutes * 60 * 1000;
    for (let cursor = dayStart.getTime(); cursor + durationMs <= dayEnd.getTime(); cursor += slotMs) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(cursor + durationMs);
      const conflict = events.rows.some((e) => {
        const eStart = new Date(e.starts_at).getTime();
        const eEnd = new Date(e.ends_at).getTime();
        return cursor < eEnd && cursor + durationMs > eStart;
      });
      if (!conflict) open.push({ starts_at: slotStart.toISOString(), ends_at: slotEnd.toISOString() });
      if (open.length >= max_slots * 3) break;
    }

    let picked = [];
    if (open.length === 0) picked = [];
    else if (open.length <= max_slots) picked = open;
    else {
      const step = Math.floor(open.length / max_slots) || 1;
      for (let i = 0; i < open.length && picked.length < max_slots; i += step) picked.push(open[i]);
    }

    if (picked.length === 0) {
      return { success: true, data: { slots: [] }, message: `No open ${duration_minutes}-minute slots on ${target_date}.` };
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
      message: `Open ${duration_minutes}-minute slots on ${target_date}: ${niceList}.`,
    };
  },
});

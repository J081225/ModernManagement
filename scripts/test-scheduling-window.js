// scripts/test-scheduling-window.js — DS1 gate (scheduling window fix).
//
// Behavioral rows run the REAL propose_appointment_times.execute
// against a fake ctx (in-memory calendar, America/New_York tz).
// Pins: window respected; whole-day/evening reachability (the
// max_slots*3 early break is gone); empty-intersection honesty;
// the mismatch-acknowledgment prompt line; backward compat for
// no-window calls; the description instructs passing the window.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const registry = require(path.join(__dirname, '..', 'lib', 'tool-registry'));
require(path.join(__dirname, '..', 'lib', 'tools', 'propose_appointment_times'));
const tool = registry.getTool('propose_appointment_times');

const TZ = 'America/New_York';
const DATE = '2026-09-01';
function ctxWith(events, wsExtra) {
  return {
    db: { query: async () => ({ rows: events }) },
    workspace: { id: 21, timezone: TZ, ...(wsExtra || {}) },
  };
}
function localHM(iso) {
  const d = new Date(iso);
  const h = Number(d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));
  const m = Number(d.toLocaleString('en-US', { timeZone: TZ, minute: 'numeric' }));
  return h * 60 + m;
}

(async () => {
  // DS1 — window respected: "between 5 and 7 PM", 45-min service,
  // empty calendar → every returned start is 17:00–19:00 local (and
  // the only one that also fits the 6 PM business close is 5:00 PM).
  {
    const r = await tool.execute({ target_date: DATE, duration_minutes: 45, window_start: '17:00', window_end: '19:00' }, ctxWith([]));
    const starts = (r.data && r.data.slots || []).map((s) => localHM(s.starts_at));
    check('DS1: 5-7 PM window yields ONLY window starts that fit the day (45min -> exactly 5:00 PM)',
      r.success === true && starts.length === 1 && starts[0] === 17 * 60,
      JSON.stringify({ starts, message: r.message }));
  }

  // DS2 — evening reachability, no window: empty calendar, 30-min
  // service → spread spans the WHOLE day: 9:00 AM, 1:30 PM, 5:30 PM.
  // (Pre-fix output was 9:00/10:30/12:00 — the demo-call bug.)
  {
    const r = await tool.execute({ target_date: DATE, duration_minutes: 30 }, ctxWith([]));
    const starts = (r.data.slots || []).map((s) => localHM(s.starts_at));
    check('DS2: no-window spread reaches the evening (9:00 AM, 1:30 PM, 5:30 PM on an empty day)',
      r.success === true && JSON.stringify(starts) === JSON.stringify([540, 810, 1050]),
      JSON.stringify({ starts, message: r.message }));
  }

  // DS3 — empty intersection honesty: 7-9 PM is fully outside the
  // 9 AM-6 PM business day → success, zero slots, a clear reason.
  {
    const r = await tool.execute({ target_date: DATE, duration_minutes: 30, window_start: '19:00', window_end: '21:00' }, ctxWith([]));
    check('DS3: window outside the business day -> slots [] + reason window_outside_business_day + honest message',
      r.success === true && Array.isArray(r.data.slots) && r.data.slots.length === 0
      && r.data.reason === 'window_outside_business_day'
      && /outside the business day/.test(r.message),
      JSON.stringify({ data: r.data, message: r.message }));
  }

  // DS4 — the engine prompt carries the mismatch-acknowledgment line.
  {
    const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    check('DS4: prompt tells the model to pass stated windows AND acknowledge mismatches plainly',
      engine.includes('pass it to propose_appointment_times as window_start/window_end')
      && engine.includes('never present non-matching times as if they answer the request'));
  }

  // DS5 — backward compat: no-window call still succeeds, respects a
  // conflict, offers at most max_slots, first slot at open (9:00 AM),
  // and no slot overlaps the busy block.
  {
    const busyStart = new Date(`${DATE}T13:00:00-04:00`).toISOString(); // 9:00-13:00 ET busy
    const events = [{ starts_at: new Date(`${DATE}T09:00:00-04:00`).toISOString(), ends_at: busyStart, is_all_day: false }];
    const r = await tool.execute({ target_date: DATE, duration_minutes: 30 }, ctxWith(events));
    const starts = (r.data.slots || []).map((s) => localHM(s.starts_at));
    check('DS5: no-window + morning busy block -> success, <=3 slots, all at/after 1:00 PM',
      r.success === true && starts.length > 0 && starts.length <= 3 && starts.every((m) => m >= 13 * 60),
      JSON.stringify({ starts }));
  }

  // DS6 — schema + description: window params exist and the
  // description mandates passing a stated window; the early break is
  // gone from the source.
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'propose_appointment_times.js'), 'utf8');
    check('DS6: schema has window_start/window_end, description mandates them, max_slots*3 break removed',
      !!tool.schema.properties.window_start && !!tool.schema.properties.window_end
      && /ALWAYS pass it via window_start\/window_end/.test(tool.description)
      && !src.includes('max_slots * 3'));
  }

  // DS7 — degenerate window rejected honestly.
  {
    const r = await tool.execute({ target_date: DATE, duration_minutes: 30, window_start: '18:00', window_end: '10:00' }, ctxWith([]));
    check('DS7: inverted window -> clean failure, no slots invented',
      r.success === false && /earlier than/.test(r.message), JSON.stringify(r));
  }

  // DS8 (BK2b) — POINT query: window_start == window_end asks "is this
  // exact start free?" — one slot back, exactly that start.
  {
    const r = await tool.execute({ target_date: DATE, duration_minutes: 30, window_start: '12:00', window_end: '12:00' }, ctxWith([]));
    const starts = (r.data.slots || []).map((s) => localHM(s.starts_at));
    check('DS8: point query 12:00 == 12:00 -> success, exactly one slot at 12:00 (no inverted-window error)',
      r.success === true && JSON.stringify(starts) === JSON.stringify([720]),
      JSON.stringify({ starts, message: r.message }));
  }

  // DS9 (BK2d) — window_end is EXCLUSIVE for starts: "before 3 PM"
  // never offers a 3:00 start (the live-call defect).
  {
    const r = await tool.execute({ target_date: DATE, duration_minutes: 30, window_start: '09:00', window_end: '15:00' }, ctxWith([]));
    const starts = (r.data.slots || []).map((s) => localHM(s.starts_at));
    check('DS9: window 9:00-15:00 -> every start < 15:00 and the last open start (2:30 PM) is offered; 3:00 PM absent',
      r.success === true && starts.length > 0 && starts.every((m) => m < 15 * 60) && starts[starts.length - 1] === 14 * 60 + 30,
      JSON.stringify({ starts }));
  }

  // DS10 (BK2c) — RANGE: per-day slots for every day, none skipped;
  // an over-cap range clamps to 7 days and says so.
  {
    const r = await tool.execute({ start_date: '2026-09-01', end_date: '2026-09-03', duration_minutes: 30 }, ctxWith([]));
    const okDays = r.success === true && r.data.days && r.data.days.length === 3
      && r.data.days.every((d) => d.slots.length > 0)
      && ['2026-09-01', '2026-09-02', '2026-09-03'].every((d) => r.message.includes(d));
    const big = await tool.execute({ start_date: '2026-09-01', end_date: '2026-09-30', duration_minutes: 30 }, ctxWith([]));
    const clamped = big.success === true && big.data.days.length === 7 && /first 7 days/.test(big.message);
    check('DS10: 3-day range returns per-day slots with every day named; 30-day ask clamps to 7 and says so',
      okDays && clamped, JSON.stringify({ okDays, clamped, msg: r.message.slice(0, 120) }));
  }

  // DS11 (BH0) — closed target day: named refusal, reason field, no scan.
  {
    const r = await tool.execute({ target_date: '2026-08-31', duration_minutes: 30 }, ctxWith([], { closed_weekdays: [0, 1] }));
    check('DS11: closed Monday -> slots [], reason closed_that_day, message NAMES Mondays',
      r.success === true && r.data.slots.length === 0 && r.data.reason === 'closed_that_day'
      && /closed on Mondays/.test(r.message), JSON.stringify(r));
  }

  // DS12 (BH0) — range marks closed days, never silently skips; open
  // days in the same range still get slots.
  {
    const r = await tool.execute({ start_date: '2026-08-30', end_date: '2026-09-01', duration_minutes: 30 }, ctxWith([], { closed_weekdays: [0, 1] }));
    check('DS12: Sun-Tue range -> Sun+Mon marked "closed (day)", Tuesday still has slots',
      r.success === true && r.data.days.length === 3
      && r.data.days[0].closed === true && r.data.days[1].closed === true
      && r.data.days[2].slots.length > 0
      && r.message.includes('2026-08-30 — closed (Sunday)') && r.message.includes('2026-08-31 — closed (Monday)'),
      JSON.stringify({ msg: r.message.slice(0, 160) }));
  }

  // DS13 (BH0) — default empty array: a Monday at a workspace with NO
  // closed days behaves exactly as before (no behavior change).
  {
    const r = await tool.execute({ target_date: '2026-08-31', duration_minutes: 30 }, ctxWith([], { closed_weekdays: [] }));
    const rAbsent = await tool.execute({ target_date: '2026-08-31', duration_minutes: 30 }, ctxWith([]));
    check('DS13: empty/absent closed_weekdays -> Monday scans normally (3 slots, spread intact)',
      r.success === true && r.data.slots.length === 3
      && rAbsent.success === true && rAbsent.data.slots.length === 3,
      JSON.stringify({ withEmpty: r.data.slots.length, absent: rAbsent.data.slots.length }));
  }

  console.log(`${pass}/${pass + fail} — scheduling-window gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('gate crashed:', err.stack || err.message); process.exit(1); });

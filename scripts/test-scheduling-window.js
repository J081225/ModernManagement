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
function ctxWith(events) {
  return {
    db: { query: async () => ({ rows: events }) },
    workspace: { id: 21, timezone: TZ },
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

  console.log(`${pass}/${pass + fail} — scheduling-window gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('gate crashed:', err.stack || err.message); process.exit(1); });

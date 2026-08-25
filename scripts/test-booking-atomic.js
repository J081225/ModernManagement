// scripts/test-booking-atomic.js — BK1 gate (atomic conflict check).
//
// Drives the REAL book_appointment.execute against a fake pg pool that
// faithfully models what the atomicity rests on: a per-key advisory
// lock that serializes transactions (acquired in-tx, released at
// COMMIT/ROLLBACK) and write-buffering that publishes only on COMMIT.
// The race row launches two concurrent bookings of ONE slot: the lock
// forces one to see the other's committed block row — exactly one
// wins, the loser gets the clear 'slot_taken' shape.

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const registry = require(path.join(__dirname, '..', 'lib', 'tool-registry'));
require(path.join(__dirname, '..', 'lib', 'tools', 'book_appointment'));
const tool = registry.getTool('book_appointment');

// ---- the faithful fake ----
function makeFakePg() {
  const shared = { appointments: [], cal_events: [], nextId: 1 };
  const locks = new Map(); // key -> tail promise (queue)
  function makeClient() {
    let buffered = [];
    let releaseLock = null;
    const client = {
      async query(sql, params) {
        if (sql === 'BEGIN') { buffered = []; return { rows: [] }; }
        if (sql === 'COMMIT') {
          for (const w of buffered) w();
          buffered = [];
          if (releaseLock) { releaseLock(); releaseLock = null; }
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          buffered = [];
          if (releaseLock) { releaseLock(); releaseLock = null; }
          return { rows: [] };
        }
        if (/pg_advisory_xact_lock/.test(sql)) {
          const key = params.join(':');
          const prev = locks.get(key) || Promise.resolve();
          let resolveNext;
          const mine = new Promise((r) => { resolveNext = r; });
          locks.set(key, prev.then(() => mine));
          await prev;               // wait for every earlier holder
          releaseLock = resolveNext; // held until COMMIT/ROLLBACK
          return { rows: [] };
        }
        if (/FROM cal_events ce/.test(sql)) {
          const [ws, end, start] = params;
          const rows = shared.cal_events.filter((e) =>
            e.workspace_id === ws && e.starts_at < end && e.ends_at > start && e.status !== 'canceled');
          return { rows };
        }
        if (/INSERT INTO appointments/.test(sql)) {
          const id = shared.nextId++;
          const row = { id, workspace_id: params[0], starts_at: params[5], ends_at: params[7], status: params[8] };
          buffered.push(() => shared.appointments.push(row));
          return { rows: [row] };
        }
        if (/INSERT INTO cal_events/.test(sql)) {
          const id = shared.nextId++;
          const row = { id, workspace_id: params[1], starts_at: params[4], ends_at: params[5], status: null };
          buffered.push(() => shared.cal_events.push(row));
          return { rows: [{ id }] };
        }
        return { rows: [] }; // UPDATE cal_event_id etc. — buffered noop
      },
      release() {},
    };
    return client;
  }
  return {
    shared,
    query: async (sql) => {
      if (/FROM contacts/.test(sql)) return { rows: [{ id: 7 }] };
      return { rows: [] };
    },
    connect: async () => makeClient(),
  };
}
function makeCtx(db) {
  return {
    db,
    workspace: { id: 21, owner_user_id: 18, timezone: 'America/New_York', appointment_auto_confirm: true, vertical: 'professional-services' },
    user: { id: 18 },
    env: {},
    logger: { error: () => {}, log: () => {} },
    customer_phone: '+15550001111',
    origin: { channel: 'ai_inbound', channel_detail: 'voice', appointment_thread_id: null },
  };
}
const INPUT = { customer_name: 'Test Caller', title: 'Classic Cut', starts_at: '2026-09-02T12:00:00-04:00', duration_minutes: 30 };

(async () => {
  // BA1 — clean book: success, both rows committed.
  {
    const db = makeFakePg();
    const r = await tool.execute({ ...INPUT }, makeCtx(db));
    check('BA1: conflict-free booking succeeds; appointment + cal_events block row both committed',
      r.success === true && db.shared.appointments.length === 1 && db.shared.cal_events.length === 1,
      JSON.stringify({ r: r.message, appts: db.shared.appointments.length, events: db.shared.cal_events.length }));
  }

  // BA2 — pre-existing conflict: clear slot_taken, nothing written.
  {
    const db = makeFakePg();
    db.shared.cal_events.push({ id: 99, workspace_id: 21,
      starts_at: new Date('2026-09-02T12:15:00-04:00').toISOString(),
      ends_at: new Date('2026-09-02T12:45:00-04:00').toISOString(), status: null });
    const r = await tool.execute({ ...INPUT }, makeCtx(db));
    check('BA2: overlapping block -> success:false, reason slot_taken, conflict time named, ZERO writes',
      r.success === false && r.reason === 'slot_taken' && /just taken/.test(r.message)
      && db.shared.appointments.length === 0 && db.shared.cal_events.length === 1,
      JSON.stringify(r));
  }

  // BA3 — THE RACE: two concurrent bookings of one slot. The advisory
  // lock serializes them; exactly one wins.
  {
    const db = makeFakePg();
    const [r1, r2] = await Promise.all([
      tool.execute({ ...INPUT }, makeCtx(db)),
      tool.execute({ ...INPUT, customer_name: 'Second Caller' }, makeCtx(db)),
    ]);
    const wins = [r1, r2].filter((r) => r.success === true);
    const losses = [r1, r2].filter((r) => r.success === false && r.reason === 'slot_taken');
    check('BA3: concurrent double-book of one slot -> EXACTLY one wins, one clean slot_taken, one row pair in the store',
      wins.length === 1 && losses.length === 1
      && db.shared.appointments.length === 1 && db.shared.cal_events.length === 1,
      JSON.stringify({ r1: { s: r1.success, reason: r1.reason }, r2: { s: r2.success, reason: r2.reason }, appts: db.shared.appointments.length }));
  }

  // BA4 — structural source pin: BEGIN -> advisory lock -> conflict
  // check -> both INSERTs -> COMMIT, all on the SAME client; no
  // cal_events write remains outside the transaction.
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'book_appointment.js'), 'utf8');
    const iBegin = src.indexOf("client.query('BEGIN')");
    const iLock = src.indexOf('pg_advisory_xact_lock');
    const iCheck = src.indexOf('FROM cal_events ce');
    const iAppt = src.indexOf('INSERT INTO appointments');
    const iCal = src.indexOf('INSERT INTO cal_events');
    const iCommit = src.indexOf("client.query('COMMIT')");
    const ordered = iBegin > 0 && iBegin < iLock && iLock < iCheck && iCheck < iAppt && iAppt < iCal && iCal < iCommit;
    const noOutsideCal = !/ctx\.db\.query\(\s*`INSERT INTO cal_events/.test(src);
    check('BA4: BEGIN < lock < conflict-check < appointments-INSERT < cal_events-INSERT < COMMIT, one client; no out-of-tx block write',
      ordered && noOutsideCal, JSON.stringify({ iBegin, iLock, iCheck, iAppt, iCal, iCommit, noOutsideCal }));
  }

  // BA5 (BK2a) — the prompt: offered-slot selection books DIRECTLY
  // (exactly one tool call, no narrated recheck); propose-first stays
  // for times the AI never offered.
  {
    const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    check('BA5: prompt has the direct-book rule for offered slots, scopes propose-first to UN-offered times, and covers ranges + point checks',
      eng.includes('call book_appointment DIRECTLY — no availability re-check, no narrated verification')
      && eng.includes('before agreeing to a time you have NOT offered in this conversation')
      && eng.includes('for a time you have not offered this conversation, check propose_appointment_times first')
      && eng.includes('pass start_date and end_date to propose_appointment_times (up to 7 days)')
      && eng.includes('NEVER answer with one day as if it covered the range'));
  }

  // BA6 (R5a) — Owner-review + CUSTOMER origin: the tool hands back
  // the ruled caller-facing line, no process words; owner-origin keeps
  // the owner shape.
  {
    const db = makeFakePg();
    const ctx = makeCtx(db);
    ctx.workspace = { ...ctx.workspace, appointment_auto_confirm: false };
    const r = await tool.execute({ ...INPUT }, ctx);
    const db2 = makeFakePg();
    const ctx2 = makeCtx(db2);
    ctx2.workspace = { ...ctx2.workspace, appointment_auto_confirm: false };
    ctx2.origin = null; // owner-initiated (command bar)
    const r2 = await tool.execute({ ...INPUT }, ctx2);
    check('BA6: review-on customer booking says the ruled caller line (no pending/queue/approval-state words); owner booking keeps "Requested… Awaiting your confirmation."',
      r.success === true && /I have you booked for Classic Cut at 12:00 PM on /.test(r.message)
      && r.message.includes("it just needs the owner's approval, and you'll get a text confirmation as soon as it's confirmed")
      && !/pending|queue|waiting on approval/i.test(r.message)
      && r2.success === true && /Requested: Classic Cut/.test(r2.message) && /Awaiting your confirmation/.test(r2.message),
      JSON.stringify({ r: r.message, r2: r2.message }));
  }

  // BA7 (R2) — open_question files a suggested owner follow-up task
  // naming customer + gap.
  {
    const db = makeFakePg();
    const captured = [];
    const baseQuery = db.query;
    db.query = async (sql, params) => {
      if (/INSERT INTO tasks/.test(sql)) { captured.push({ sql, params }); return { rows: [] }; }
      return baseQuery(sql, params);
    };
    const r = await tool.execute({ ...INPUT, open_question: 'fade length preference unknown' }, makeCtx(db));
    check('BA7: open_question -> ONE suggested task naming the customer and the gap (booking stands)',
      r.success === true && captured.length === 1
      && /suggested/.test(captured[0].sql)
      && /Follow up with Test Caller/.test(captured[0].params[1])
      && /fade length preference unknown/.test(captured[0].params[3]),
      JSON.stringify({ tasks: captured.length }));
  }

  // BA8 (R5b/R5c) — the approve/decline seam: guarded transition, both
  // ruled outcome texts, consent + demo gates on the send.
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const guarded = srv.includes("if (!['confirmed', 'canceled'].includes(target) || current.status !== 'requested')");
    const approvedText = srv.includes('appointment for ${timePart} on ${datePart} is confirmed. Reply STOP to opt out.');
    const declinedText = srv.includes("didn't work out for your ${current.title} appointment. Call or text us anytime");
    const consentGate = /smsConsent\.isOptedOut\(pool, workspaceId, custPhone\)/.test(srv);
    const demoGate = srv.includes('outcome text skipped — demo workspace never texts');
    const pendingGate = /smsConsent\.isOptedOut\(pool, workspaceId, pending\.customer_phone\)/.test(srv);
    const uiSeam = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8').includes("calAppointmentDecision(' + Number(appt.id) + ', \\'confirmed\\')");
    check('BA8: PATCH allows ONLY requested->confirmed|canceled; both ruled outcome texts; STOP gate on BOTH notify paths; demo hard-block; Confirm/Decline UI exists',
      guarded && approvedText && declinedText && consentGate && demoGate && pendingGate && uiSeam,
      JSON.stringify({ guarded, approvedText, declinedText, consentGate, demoGate, pendingGate, uiSeam }));
  }

  // BA10 (BH0) — closed-day writes are refused AT THE TOOL: no prompt
  // phrasing can book onto a closed day, and nothing is written.
  {
    const db = makeFakePg();
    const ctx = makeCtx(db);
    ctx.workspace = { ...ctx.workspace, closed_weekdays: [3] }; // INPUT is a Wednesday
    const r = await tool.execute({ ...INPUT }, ctx);
    check('BA10: booking a closed Wednesday -> success:false, reason closed_that_day, day NAMED, ZERO writes',
      r.success === false && r.reason === 'closed_that_day'
      && /closed on Wednesdays/.test(r.message)
      && db.shared.appointments.length === 0 && db.shared.cal_events.length === 0,
      JSON.stringify(r));
  }

  // BA9 (R4) — live data: ws21 autonomous; new-workspace default TRUE.
  {
    require('dotenv').config();
    if (!process.env.DATABASE_URL) {
      check('BA9: ws21 autonomous + column default true (DB read)', false, 'DATABASE_URL not set');
    } else {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      try {
        const ws = await pool.query('SELECT appointment_auto_confirm FROM workspaces WHERE id = 21');
        const def = await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name='workspaces' AND column_name='appointment_auto_confirm'");
        check('BA9: ws21 autonomous + new-workspace default TRUE (DB read-back)',
          ws.rows[0].appointment_auto_confirm === true && def.rows[0].column_default === 'true',
          JSON.stringify({ ws21: ws.rows[0], def: def.rows[0] }));
      } finally { await pool.end(); }
    }
  }

  console.log(`${pass}/${pass + fail} — booking-atomic gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('gate crashed:', err.stack || err.message); process.exit(1); });

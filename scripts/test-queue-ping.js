// scripts/test-queue-ping.js — AD9, rebuild of the lost `ping` gate,
// SLIM by design. The sendOwnerAlert ROUTING (phone->email fallback,
// notifications-off honored, emergency always-send) is ALREADY proven
// by test-security-notices (CS8-CS11) and test-contact-verify (V1/V2)
// — this gate does NOT duplicate it. It proves only the uncovered
// QUEUE->ping WIRING: a customer-originated queued action pings the
// owner (respectEnabled:true, honoring the toggle), an owner-
// originated divert never pings, and the badge counts pending rows.
const path = require('path');
const fs = require('fs');
require(path.join(__dirname, '..', 'lib', 'tools')); // register the tool defs
const { executeAIResult } = require(path.join(__dirname, '..', 'lib', 'appointment-engine'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Owner row the ping's sendOwnerAlert reads. Verified phone + toggle
// configurable.
function makeDb(owner) {
  const db = {
    pending: [],
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO pending_actions')) {
        db.pending.push({
          workspace_id: params[0], user_id: params[1], tool_name: params[2],
          status: 'pending', customer_phone: params[5], customer_email: params[6], channel: params[7],
        });
        return { rows: [] };
      }
      // sendOwnerAlert's user read (post-AD5 column set)
      if (s.startsWith('SELECT id, alert_phone, notification_email, email, notifications_enabled')) {
        return { rows: [owner] };
      }
      // the queued-acknowledgment outbound persist (customer reply)
      if (s.startsWith('INSERT INTO messages')) return { rows: [{ id: 1 }] };
      if (s.startsWith('SELECT id, name FROM contacts')) return { rows: [] };
      // updateThreadContext tail (if reached)
      if (s.startsWith('UPDATE appointment_threads')) return { rows: [] };
      // any other read the execute path might do — none expected on the queue branch
      throw new Error('unexpected SQL: ' + s.slice(0, 70));
    },
  };
  return db;
}

function makeTwilio(opts = {}) {
  const sent = [];
  return { sent, messages: { create: async (m) => { if (opts.fail) throw new Error('twilio down'); sent.push(m); return {}; } } };
}
const noEmail = { send: async () => { throw new Error('no email path in this fixture'); } };
const quiet = { error: () => {}, log: () => {} };

// A workspace that APPROVES bookings -> book_appointment queues.
const WS = { id: 5, owner_user_id: 3, vertical: 'professional-services', plan: 'premium', autonomy_bookings: 'approve' };
const OWNER_ON = { id: 3, alert_phone: '+14435559999', notification_email: 'o@x.test', email: 'o@x.test', notifications_enabled: true, alert_phone_verified_at: 'T', notification_email_verified_at: 'T' };
const OWNER_OFF = { ...OWNER_ON, notifications_enabled: false };

const aiResult = {
  content: [{ type: 'tool_use', name: 'book_appointment', input: { service: 'cut', time: '2026-08-10T10:00:00-04:00' } }],
};
function runArgs(db, twilio) {
  return {
    aiResponse: aiResult, workspace: WS, contact: null, thread: { id: 77 }, channel: 'sms', body: 'book me',
    customer_phone: '+14435550100', customer_email: null,
    db, twilio, sendgrid: noEmail, env: { TWILIO_PHONE_NUMBER: '+15550000000' }, logger: quiet,
  };
}

(async () => {
  // The owner ping is the send addressed to the owner's alert_phone;
  // the other twilio send is the customer's queued-acknowledgment reply.
  const ownerPings = (twilio) => twilio.sent.filter((m) => m.to === OWNER_ON.alert_phone && /waiting on/.test(m.body));

  // ---- PING1: a customer-originated queue INSERTs the row AND pings ----
  {
    const db = makeDb(OWNER_ON);
    const twilio = makeTwilio();
    const r = await executeAIResult(runArgs(db, twilio));
    const queued = db.pending[0];
    check('PING1: an approval-gated customer action queues (pending row, customer origin) AND pings the owner exactly once',
      db.pending.length === 1 && queued.status === 'pending' && queued.customer_phone === '+14435550100'
        && ownerPings(twilio).length === 1
        && r.used_tools.some((t) => t.queued === true),
      JSON.stringify({ pending: db.pending.length, ownerPings: ownerPings(twilio).length, allSends: twilio.sent.length }));
  }

  // ---- PING2: respectEnabled:true — notifications OFF suppresses the ping, not the queue ----
  {
    const db = makeDb(OWNER_OFF);
    const twilio = makeTwilio();
    await executeAIResult(runArgs(db, twilio));
    check('PING2: with notifications_enabled=false the queue row is STILL written but NO owner ping fires — the wiring passes respectEnabled:true (not the emergency false)',
      db.pending.length === 1 && ownerPings(twilio).length === 0,
      JSON.stringify({ pending: db.pending.length, ownerPings: ownerPings(twilio).length }));
  }

  // ---- PING3: a ping failure leaves the queue row intact (best-effort) ----
  {
    const db = makeDb(OWNER_ON);
    const twilio = makeTwilio({ fail: true }); // sms throws; no email path
    let threw = false, r;
    try { r = await executeAIResult(runArgs(db, twilio)); } catch (e) { threw = true; }
    check('PING3: an approval-ping failure never throws and leaves the queue row safe on disk',
      threw === false && db.pending.length === 1 && r.used_tools.some((t) => t.queued === true));
  }

  // ---- PING4: source-pin — the approval ping lives ONLY in the
  // customer engine, never in server.js's owner paths ----
  {
    const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    // The approval-ping smsBody is the wiring's fingerprint. It appears
    // in the engine's customer queue branch and NOWHERE in server.js —
    // so the /api/command owner divert (which inserts pending_actions
    // in server.js) cannot ping. The engine comment states the rule;
    // this proves the code matches it.
    const inEngine = engineSrc.includes('is waiting on ${noun} approval');
    const notInServer = !serverSrc.includes('waiting on') || !/waiting on[^\n]*approval/.test(serverSrc);
    const engineRespectsToggle = /smsBody: `A customer is waiting[\s\S]{0,220}respectEnabled: true/.test(engineSrc);
    check('PING4: the approval ping exists only in the customer engine (respectEnabled:true), never in server.js — owner-originated /api/command diverts cannot ping',
      inEngine && notInServer && engineRespectsToggle, JSON.stringify({ inEngine, notInServer, engineRespectsToggle }));
  }

  // ---- PING5: source-pin — the badge counts pending rows ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const idx = src.indexOf("app.get('/api/pending-actions/count'");
    const block = src.slice(idx, idx + 400);
    check('PING5: GET /api/pending-actions/count counts status = pending rows scoped to the workspace',
      idx !== -1 && /COUNT\(\*\)::int AS pending FROM pending_actions/.test(block)
        && /status = 'pending'/.test(block) && block.includes('workspace_id = $1'),
      block.replace(/\s+/g, ' ').slice(0, 160));
  }

  // ---- PING6: the customer is told it went to the owner ----
  {
    const db = makeDb(OWNER_ON);
    const r = await executeAIResult(runArgs(db, makeTwilio()));
    check('PING6: the customer reply says it was sent to the owner to confirm',
      /sent that to the owner to confirm/.test(r.outbound_text), r.outbound_text);
  }

  console.log(`${pass}/${pass + fail} — queue-ping gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

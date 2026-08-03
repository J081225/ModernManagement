// scripts/test-driver.js — AD9, rebuild of the lost `driver` gate
// (IB4). Two behaviors, both against the real injectable engine code:
//   1. findOrCreateThread — reopen (closed threads skipped) + STICKY
//      ai_paused inheritance across reopens.
//   2. the pause gate in processInboundMessage — the ONE choke point:
//      a paused thread silences the AI on async channels but a live
//      voice call is still answered (voice-exempt), and pausing the
//      voice never blinds the eyes (context still written).
const path = require('path');
const engine = require(path.join(__dirname, '..', 'lib', 'appointment-engine'));
const { findOrCreateThread, processInboundMessage } = engine;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const WS = { id: 5, vertical: 'professional-services', appointment_auto_respond: true, plan: 'premium' };
const quiet = { error: () => {}, log: () => {} };

// Fixture DB for the thread layer. `threads` is the appointment_threads
// table; captures INSERTs and context UPDATEs.
function makeDb(threads, opts = {}) {
  return {
    inserted: [],
    contextWrites: [],
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      // resolveCallerContact — no contacts in these fixtures
      if (s.startsWith('SELECT id, name FROM contacts')) return { rows: [] };
      // findOrCreateThread: the OPEN-thread lookup
      if (s.startsWith('SELECT * FROM appointment_threads') && s.includes("state NOT IN ('closed', 'complete')")) {
        const key = params[1];
        const open = threads.filter((t) => t[params.__col || 'customer_phone'] === key || t.customer_phone === key || t.customer_email === key)
          .filter((t) => t.state !== 'closed' && t.state !== 'complete')
          .sort((a, b) => b.id - a.id);
        return { rows: open.length ? [open[0]] : [] };
      }
      // findOrCreateThread: the inheritance lookup (most recent ANY state)
      if (s.startsWith('SELECT ai_paused, paused_at, paused_by FROM appointment_threads')) {
        if (opts.inheritThrows) throw new Error('inherit lookup down (fixture)');
        const key = params[1];
        const all = threads.filter((t) => t.customer_phone === key || t.customer_email === key)
          .sort((a, b) => b.id - a.id);
        return { rows: all.length ? [{ ai_paused: all[0].ai_paused, paused_at: all[0].paused_at, paused_by: all[0].paused_by }] : [] };
      }
      if (s.startsWith('INSERT INTO appointment_threads')) {
        const row = {
          id: 900 + threads.length + this.inserted.length + 1,
          workspace_id: params[0], contact_id: params[1], inbound_channel: params[2],
          customer_phone: params[3], customer_email: params[4], state: 'gathering',
          ai_paused: params[5], paused_at: params[6], paused_by: params[7],
        };
        this.inserted.push(row);
        return { rows: [row] };
      }
      // updateThreadContext (paused-thread eyes-open write)
      if (s.startsWith('UPDATE appointment_threads SET context_summary') || s.includes('context_summary =')) {
        this.contextWrites.push(params);
        return { rows: [] };
      }
      // any other context/idle update the paused path may issue
      if (s.startsWith('UPDATE appointment_threads')) {
        this.contextWrites.push(params);
        return { rows: [] };
      }
      throw new Error('unexpected SQL: ' + s.slice(0, 70));
    },
  };
}

(async () => {
  // ---- DRV1: an OPEN thread is reused ----
  {
    const db = makeDb([{ id: 10, customer_phone: '+14435550100', state: 'gathering', ai_paused: false }]);
    const t = await findOrCreateThread({ workspace: WS, contact: null, customer_phone: '+14435550100', channel: 'sms', db });
    check('DRV1: an existing OPEN thread is returned as-is (no new insert)',
      t.id === 10 && db.inserted.length === 0);
  }

  // ---- DRV2: a CLOSED thread is skipped -> fresh thread (reopen) ----
  {
    const db = makeDb([{ id: 11, customer_phone: '+14435550200', state: 'closed', ai_paused: false }]);
    const t = await findOrCreateThread({ workspace: WS, contact: null, customer_phone: '+14435550200', channel: 'sms', db });
    check('DRV2: a closed thread is skipped — a fresh thread is created (the reopen behavior)',
      t.id !== 11 && db.inserted.length === 1 && t.state === 'gathering');
  }

  // ---- DRV3: ai_paused inherits STICKY across a reopen ----
  {
    const db = makeDb([{ id: 12, customer_phone: '+14435550300', state: 'closed', ai_paused: true, paused_at: 'T', paused_by: 'owner' }]);
    const t = await findOrCreateThread({ workspace: WS, contact: null, customer_phone: '+14435550300', channel: 'sms', db });
    check('DRV3: a new thread inherits ai_paused=true from the most recent (closed) prior — the driver stays with the owner across reopens',
      db.inserted.length === 1 && t.ai_paused === true && t.paused_by === 'owner',
      JSON.stringify({ ai_paused: t.ai_paused, by: t.paused_by }));
  }

  // ---- DRV4: a non-paused prior yields a fresh FALSE ----
  {
    const db = makeDb([{ id: 13, customer_phone: '+14435550400', state: 'closed', ai_paused: false }]);
    const t = await findOrCreateThread({ workspace: WS, contact: null, customer_phone: '+14435550400', channel: 'sms', db });
    check('DRV4: a prior thread with ai_paused=false -> the new thread is un-paused (inheritance is only for true)',
      t.ai_paused === false);
  }

  // ---- DRV5: an inheritance lookup failure defaults to un-paused ----
  {
    const db = makeDb([{ id: 14, customer_phone: '+14435550500', state: 'closed', ai_paused: true }], { inheritThrows: true });
    const t = await findOrCreateThread({ workspace: WS, contact: null, customer_phone: '+14435550500', channel: 'sms', db });
    check('DRV5: an inheritance-lookup failure is best-effort -> fresh false, thread still created',
      t.ai_paused === false && db.inserted.length === 1);
  }

  // ---- DRV6: the pause gate — silent on sms, but the eyes stay open ----
  {
    const db = makeDb([{ id: 20, customer_phone: '+14435550600', state: 'gathering', ai_paused: true }]);
    const r = await processInboundMessage({
      workspace: WS, contact: null, customer_phone: '+14435550600', channel: 'sms', body: 'you there?',
      db, twilio: null, sendgrid: null, env: {}, logger: quiet,
    });
    check('DRV6: a paused thread on SMS -> handled:true/ai_paused/paused:true, AND the context is still written (pausing the voice never blinds the eyes)',
      r.handled === true && r.reason === 'ai_paused' && r.paused === true && db.contextWrites.length >= 1,
      JSON.stringify({ r, writes: db.contextWrites.length }));
  }

  // ---- DRV7: the pause gate is VOICE-EXEMPT ----
  {
    // On a live voice call the paused thread does NOT stop at the gate;
    // it proceeds toward the model. With no ANTHROPIC_API_KEY the engine
    // falls through at that later point — proving it went PAST the pause
    // gate rather than returning ai_paused.
    const db = makeDb([{ id: 21, customer_phone: '+14435550700', state: 'gathering', ai_paused: true }]);
    const r = await processInboundMessage({
      workspace: WS, contact: null, customer_phone: '+14435550700', channel: 'voice', body: 'hello?',
      db, twilio: null, sendgrid: null, env: {}, logger: quiet,
    });
    check('DRV7: a paused thread on a live VOICE call is NOT silenced — it proceeds past the gate (reason != ai_paused)',
      r.reason !== 'ai_paused' && r.paused !== true, JSON.stringify(r));
  }

  // ---- DRV8: the gate sits behind the global switches ----
  {
    const off = await processInboundMessage({
      workspace: { ...WS, appointment_auto_respond: false }, customer_phone: '+1', channel: 'sms', body: 'hi',
      db: makeDb([]), env: {}, logger: quiet,
    });
    const notPs = await processInboundMessage({
      workspace: { ...WS, vertical: 'property-management' }, customer_phone: '+1', channel: 'sms', body: 'hi',
      db: makeDb([]), env: {}, logger: quiet,
    });
    check('DRV8: global auto_respond off and non-PS vertical short-circuit BEFORE the per-thread driver (precedence)',
      off.reason === 'auto_respond_disabled' && notPs.reason === 'not_professional_services');
  }

  console.log(`${pass}/${pass + fail} — driver gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

// scripts/test-sms-consent.js — A2P/TCPA opt-out law.
//
// STOP/START/HELP are handled at OUR layer before the AI, recorded per
// workspace+number, and the SEND PATH suppresses opted-out numbers.
// Strict liability — this suite guards a law.
const path = require('path');
const fs = require('fs');
const consent = require(path.join(__dirname, '..', 'lib', 'sms-consent'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

function makeDb() {
  const store = new Map();
  return {
    store,
    query: async (sql, params) => {
      if (/INSERT INTO sms_opt_outs/.test(sql)) {
        const isOut = /DO UPDATE SET opted_out = true/.test(sql);
        store.set(params[0] + '|' + params[1], { opted_out: isOut });
        return { rows: [] };
      }
      if (/SELECT opted_out FROM sms_opt_outs/.test(sql)) {
        const row = store.get(params[0] + '|' + params[1]);
        return { rows: row ? [{ opted_out: row.opted_out }] : [] };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  // ---- OC1: keyword classification (lone-word; conversation is NOT opt-out) ----
  {
    const stops = ['STOP', 'stop', 'Stop.', 'STOPALL', 'unsubscribe', 'CANCEL', 'End', 'quit']
      .every((w) => consent.classifyOptKeyword(w) === 'stop');
    const starts = ['START', 'unstop', 'Start!'].every((w) => consent.classifyOptKeyword(w) === 'start');
    const helps = ['HELP', 'info', 'Help?'].every((w) => consent.classifyOptKeyword(w) === 'help');
    // conversation, NOT opt-out — the appointment-cancel trap
    const convo = ['Cancel my 2pm', 'please stop by at 3', 'yes that works', '', '   ', 'Reschedule to Friday']
      .every((w) => consent.classifyOptKeyword(w) === null);
    check('OC1: STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT→stop, START/UNSTOP→start, HELP/INFO→help — but "Cancel my 2pm" and other multi-word messages are NULL (conversation, not opt-out)',
      stops && starts && helps && convo, JSON.stringify({ stops, starts, helps, convo }));
  }

  // ---- OC2: opt-out recorded + isOptedOut true; START opts back in; per-workspace ----
  {
    const db = makeDb();
    await consent.recordOptOut(db, 17, '+16465550100', 'STOP');
    const outAfterStop = await consent.isOptedOut(db, 17, '+16465550100');
    // a different workspace is NOT affected (per-business opt-out)
    const otherWs = await consent.isOptedOut(db, 18, '+16465550100');
    await consent.recordOptIn(db, 17, '+16465550100', 'START');
    const outAfterStart = await consent.isOptedOut(db, 17, '+16465550100');
    check('OC2: recordOptOut → isOptedOut true; a different workspace is unaffected (per-business); recordOptIn (START) → isOptedOut false',
      outAfterStop === true && otherWs === false && outAfterStart === false,
      JSON.stringify({ outAfterStop, otherWs, outAfterStart }));
  }

  // ---- OC3: the inbound handler short-circuits BEFORE the AI engine ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const h = srv.slice(srv.indexOf("app.post('/api/sms/incoming'"), srv.indexOf("app.post('/api/sms/send'"));
    const classifyIdx = h.indexOf('smsConsent.classifyOptKeyword(body)');
    const engineIdx = h.indexOf('appointmentEngine.processInboundMessage');
    const recordsAndReturns = /if \(optKind\)/.test(h)
      && h.includes('smsConsent.recordOptOut(pool, route.workspace_id')
      && h.includes('return; // short-circuit');
    check('OC3: /api/sms/incoming classifies the keyword and short-circuits (records opt-out/in, replies, returns) BEFORE processInboundMessage — the AI never sees STOP/HELP',
      classifyIdx !== -1 && engineIdx !== -1 && classifyIdx < engineIdx && recordsAndReturns,
      JSON.stringify({ classifyBeforeEngine: classifyIdx < engineIdx, recordsAndReturns }));
  }

  // ---- OC4: the SEND PATH suppresses opted-out numbers (structural) ----
  {
    const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    const pr = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payment-requests.js'), 'utf8');
    const engGate = eng.includes("require('./sms-consent').isOptedOut(db, workspace.id, customer_phone)")
      && /&& !_optedOut\) \{/.test(eng);
    const prGate = pr.includes("require('./sms-consent').isOptedOut(pool, workspace.id, customerPhone)")
      && /&& !_custOptedOut\) \{/.test(pr);
    check('OC4: the customer send paths (appointment-engine reply + payment-link SMS) check isOptedOut and skip the send for an opted-out number — suppression is at OUR send layer',
      engGate && prGate, JSON.stringify({ engGate, prGate }));
  }

  console.log(`${pass}/${pass + fail} — sms-consent gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

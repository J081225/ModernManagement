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
  const events = [];
  return {
    store,
    events,
    query: async (sql, params) => {
      // CONSENT-EVENTS: capture evidence appends (the CTE statement
      // matches BOTH tables — that one-statement shape IS the
      // atomicity guarantee, asserted in CE1).
      if (/INSERT INTO sms_consent_events/.test(sql)) {
        events.push({
          ws: params[0], phone: params[1], keyword: params[2],
          direction: (sql.match(/'(opt_out|opt_in|help)'/) || [])[1],
          sid: params[3] || null,
          atomicWithState: /INSERT INTO sms_opt_outs/.test(sql),
        });
      }
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
    // LP2a strengthened the send conditions: opt-out AND the demo
    // hard-block both gate the actual .create call.
    const engGate = eng.includes("require('./sms-consent').isOptedOut(db, workspace.id, customer_phone)")
      && /&& !_optedOut && !workspace\.is_demo\) \{/.test(eng);
    const prGate = pr.includes("require('./sms-consent').isOptedOut(pool, workspace.id, customerPhone)")
      && /&& !_custOptedOut && !workspace\.is_demo\) \{/.test(pr);
    check('OC4: the customer send paths (appointment-engine reply + payment-link SMS) gate the send on isOptedOut AND the is_demo hard-block — suppression is at OUR send layer',
      engGate && prGate, JSON.stringify({ engGate, prGate }));
  }

  // ---- OC5: send_broadcast is service-only (promo guard) + opt-out-aware ----
  {
    const promo = ['20% off all services this week!', 'Flash sale — book now', 'Special offer for you', 'Subscribe now to save $10']
      .every((m) => consent.looksPromotional(m) === true);
    const service = ['The salon will be closed Monday for repairs.', 'Your appointment tomorrow is confirmed.', 'We are running 15 minutes behind today.']
      .every((m) => consent.looksPromotional(m) === false);
    const bc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'send_broadcast.js'), 'utf8');
    const promoGuard = bc.includes('looksPromotional(body)') && /return \{\s*success: false,[\s\S]{0,200}separate messaging campaign/.test(bc);
    const optOutSkip = bc.includes("await isOptedOut(ctx.db, ctx.workspace.id, r.phone)") && bc.includes('optedOutSkipped++');
    check('OC5: send_broadcast refuses promotional content (service notices only — marketing = separate campaign) and skips opted-out numbers; looksPromotional flags offers/sales but not closures/confirmations',
      promo && service && promoGuard && optOutSkip, JSON.stringify({ promo, service, promoGuard, optOutSkip }));
  }

  // ---- OC6: REAL, gating opt-in consent on the contact-intake form ----
  // Upgraded (2026-08-16, Danny @ Twilio): the passive disclosure LINE is now
  // an unchecked-by-default checkbox carrying Danny's verbatim template that
  // BLOCKS saving a new contact with a phone until consent is confirmed.
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    // A real checkbox (not just text).
    const hasCheckbox = /type="checkbox"[^>]*id="cPhoneConsentBox"/.test(app);
    // Danny's template wording: SMS consent + STOP + HELP.
    const dannyWording = /agreed to receive SMS[\s\S]{0,220}reply STOP[\s\S]{0,80}Reply HELP/i.test(app);
    // it sits with the phone field in the contact modal
    const nearPhone = /id="cPhone"[\s\S]{0,300}id="cPhoneConsent"/.test(app);
    // and it ACTUALLY gates: submitContactModal blocks on the unchecked box.
    const gates = /cPhoneConsentBox[\s\S]{0,200}checked/.test(app)
      && /Please confirm the customer consented/i.test(app);
    check('OC6: the contact-intake form carries a REAL gating consent checkbox (Danny template, unchecked by default; blocks saving a new contact with a phone until consent is confirmed)',
      hasCheckbox && dannyWording && nearPhone && gates,
      JSON.stringify({ hasCheckbox, dannyWording, nearPhone, gates }));
  }

  // ---- CE1-CE4 (CONSENT-EVENTS): the append-only evidence layer ----
  {
    const db = makeDb();
    await consent.recordOptOut(db, 17, '+16465550100', 'STOPALL', 'SM_test_1');
    await consent.recordOptIn(db, 17, '+16465550100', 'UNSTOP', 'SM_test_2');
    await consent.recordHelpEvent(db, 17, '+16465550100', 'INFO', 'SM_test_3');
    const [e1, e2, e3] = db.events;
    check('CE1: STOP appends exactly one event — verbatim keyword, opt_out, MessageSid — in the SAME statement as the state upsert',
      db.events.length === 3 && e1.keyword === 'STOPALL' && e1.direction === 'opt_out'
      && e1.sid === 'SM_test_1' && e1.atomicWithState === true,
      JSON.stringify(e1));
    check('CE2: START appends one opt_in event, verbatim UNSTOP, atomic with state',
      e2.keyword === 'UNSTOP' && e2.direction === 'opt_in' && e2.sid === 'SM_test_2' && e2.atomicWithState === true,
      JSON.stringify(e2));
    check('CE3: HELP appends one help event (no state upsert — evidence only)',
      e3.keyword === 'INFO' && e3.direction === 'help' && e3.sid === 'SM_test_3' && e3.atomicWithState === false,
      JSON.stringify(e3));
    // State and latest event always agree: after stop→start the state
    // is opted-in and the latest consent-state event is opt_in.
    const state = db.store.get('17|+16465550100');
    const latestStateEvent = db.events.filter((e) => e.direction !== 'help').pop();
    check('CE4: state and latest event agree (opted_out=false <-> latest event opt_in)',
      state.opted_out === false && latestStateEvent.direction === 'opt_in',
      JSON.stringify({ state, latestStateEvent }));
  }

  // ---- CE5: INSERT-only by structure — no UPDATE/DELETE path exists ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sms-consent.js'), 'utf8');
    let allLib = '';
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'lib'))) {
      if (f.endsWith('.js')) allLib += fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    }
    const noMutation = !/UPDATE\s+sms_consent_events|DELETE\s+FROM\s+sms_consent_events|TRUNCATE\s+sms_consent_events/i.test(srv + allLib);
    check('CE5: no UPDATE/DELETE/TRUNCATE against sms_consent_events anywhere in server.js or lib/** (append-only law)',
      noMutation && lib.includes('sms_consent_events'));
  }

  // ---- CE6: all three inbound call sites pass the MessageSid ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('CE6: STOP/START/HELP call sites each pass req.body.MessageSid; HELP records via recordHelpEvent',
      srv.includes('smsConsent.recordOptOut(pool, route.workspace_id, from, kw, req.body.MessageSid)')
      && srv.includes('smsConsent.recordOptIn(pool, route.workspace_id, from, kw, req.body.MessageSid)')
      && srv.includes('smsConsent.recordHelpEvent(pool, route.workspace_id, from, kw, req.body.MessageSid)'));
  }

  console.log(`${pass}/${pass + fail} — sms-consent gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

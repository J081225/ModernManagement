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

  console.log(`${pass}/${pass + fail} — sms-consent gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

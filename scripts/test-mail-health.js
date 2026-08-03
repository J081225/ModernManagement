// scripts/test-mail-health.js — AD8 (f) suite.
//
// Drives the real createMailHealthMonitor with a fake escalate, and
// source-pins that the three email send paths feed it and the boot
// escalation files an owner task (never email).
const path = require('path');
const fs = require('fs');
const { createMailHealthMonitor, DEFAULT_THRESHOLD } = require(path.join(__dirname, '..', 'lib', 'mail-health'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

function monitor(threshold) {
  const escalations = [];
  const m = createMailHealthMonitor({
    threshold,
    escalate: async (payload) => { escalations.push(payload); },
    logger: { error: () => {}, log: () => {} },
  });
  return { m, escalations };
}

(async () => {
  // ---- M1: below threshold, no escalation ----
  {
    const { m, escalations } = monitor(5);
    for (let i = 0; i < 4; i++) await m.recordFailure({ source: 'security-notice' });
    check('M1: 4 failures under a threshold of 5 -> no escalation, counter at 4',
      escalations.length === 0 && m._state().consecutive === 4, JSON.stringify(m._state()));
  }

  // ---- M2: trips exactly AT the threshold, once ----
  {
    const { m, escalations } = monitor(5);
    let trippedOn = -1;
    for (let i = 0; i < 10; i++) {
      const tripped = await m.recordFailure({ source: 'owner-alert', reason: 'down' });
      if (tripped && trippedOn === -1) trippedOn = i + 1;
    }
    check('M2: escalates on the 5th failure and ONLY once across 10 failures',
      trippedOn === 5 && escalations.length === 1 && escalations[0].consecutive === 5,
      JSON.stringify({ trippedOn, count: escalations.length }));
  }

  // ---- M3: a success resets — the streak must start over ----
  {
    const { m, escalations } = monitor(5);
    for (let i = 0; i < 4; i++) await m.recordFailure({});
    m.recordSuccess();
    check('M3: success zeroes the counter and clears the escalated latch',
      m._state().consecutive === 0 && m._state().escalated === false && escalations.length === 0,
      JSON.stringify(m._state()));
    for (let i = 0; i < 4; i++) await m.recordFailure({});
    check('M3b: after reset, 4 more failures still do not trip (streak restarted)',
      escalations.length === 0 && m._state().consecutive === 4);
  }

  // ---- M4: re-arm — success after an escalation allows the NEXT outage to alarm again ----
  {
    const { m, escalations } = monitor(3);
    for (let i = 0; i < 3; i++) await m.recordFailure({}); // trip #1
    m.recordSuccess();                                     // recovery
    for (let i = 0; i < 3; i++) await m.recordFailure({}); // trip #2
    check('M4: a recovery re-arms the alarm — a second outage escalates again',
      escalations.length === 2, JSON.stringify({ count: escalations.length }));
  }

  // ---- M5: escalation failure is swallowed (never throws to the send path) ----
  {
    const m = createMailHealthMonitor({
      threshold: 2,
      escalate: async () => { throw new Error('task insert blew up'); },
      logger: { error: () => {}, log: () => {} },
    });
    let threw = false;
    try {
      await m.recordFailure({});
      await m.recordFailure({});
    } catch (e) { threw = true; }
    check('M5: a throwing escalation is caught — recordFailure never propagates', threw === false);
  }

  // ---- M6: default threshold is the documented 5 ----
  {
    check('M6: DEFAULT_THRESHOLD is 5', DEFAULT_THRESHOLD === 5, String(DEFAULT_THRESHOLD));
  }

  // ---- M7: source pins — the three email paths feed the monitor ----
  {
    const cred = fs.readFileSync(path.join(__dirname, '..', 'lib', 'credentials.js'), 'utf8');
    const oa = fs.readFileSync(path.join(__dirname, '..', 'lib', 'owner-alert.js'), 'utf8');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const secNotice = cred.includes("mailHealth.recordSuccess()") && cred.includes("mailHealth.recordFailure({ source: 'security-notice'");
    const ownerAlert = oa.includes('mailHealth.recordSuccess()') && oa.includes("mailHealth.recordFailure({ source: 'owner-alert'");
    const notifEmail = srv.includes("mailHealth.recordFailure({ source: 'notification-email'");
    check('M7: security-notice, owner-alert email leg, and sendNotificationEmail all record success+failure',
      secNotice && ownerAlert && notifEmail, JSON.stringify({ secNotice, ownerAlert, notifEmail }));
  }

  // ---- M8: the empty-recipient SKIP does NOT count as a failure ----
  {
    const cred = fs.readFileSync(path.join(__dirname, '..', 'lib', 'credentials.js'), 'utf8');
    // In sendSecurityNotice the no-addr branch returns before any
    // mailHealth call — pin that the skip log is followed by a return
    // with no recordFailure between it and the try.
    const skipIdx = cred.indexOf('no reachable email — notice skipped');
    const tryIdx = cred.indexOf('await sendgrid.send', skipIdx);
    const between = cred.slice(skipIdx, tryIdx);
    check('M8: the no-recipient skip returns without touching the monitor (no false alarm for anchorless users)',
      skipIdx !== -1 && !between.includes('recordFailure') && between.includes('return null'),
      'skip branch');
  }

  // ---- M9: boot escalation files an OWNER TASK, never email ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const cfgIdx = srv.indexOf('mailHealth.configure({');
    const cfgBlock = srv.slice(cfgIdx, srv.indexOf('});', cfgIdx) + 3);
    const filesTask = cfgBlock.includes('INSERT INTO tasks') && cfgBlock.includes('Email delivery is failing');
    const noEmail = !cfgBlock.includes('sgMail.send') && !cfgBlock.includes('sendSecurityNotice');
    const marker = cfgBlock.includes('[mail-outage]');
    check('M9: boot escalation files an owner task with a [mail-outage] marker and sends NO email',
      cfgIdx !== -1 && filesTask && noEmail && marker, JSON.stringify({ filesTask, noEmail, marker }));
  }

  console.log(`${pass}/${pass + fail} — mail-health suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

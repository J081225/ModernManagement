// scripts/test-prov-attach.js — PROV-ATTACH gate.
//
// Behavioral rows drive the REAL provisionWorkspaceNumber with fake
// pool + deps. Pins: provisioning attaches the purchased number to the
// Messaging Service (env-driven SID); attach failure is LOUD (Sentry +
// operator task) but never rolls back (ok:true, no release); the SID
// is never hardcoded; exactly one attach call site, after the flip —
// so existing attachments (ws17), the demo number, and the toll-free
// are structurally untouchable.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const worker = require('../lib/provisioning-worker');
const realProv = require('../lib/twilio-provisioning');

const PN = 'PN' + 'a'.repeat(32);
const ENV = { PUBLIC_BASE_URL: 'https://modernmanagementapp.com', TWILIO_MESSAGING_SERVICE_SID: 'MGtest0000000000000000000000000000' };

function makePool(state) {
  return {
    query: async (sql, params) => {
      if (/SET twilio_attempts = twilio_attempts \+ 1/.test(sql)) {
        return { rows: [{ id: params[0], twilio_attempts: 1, area_code_preference: '212', area_code_backup_preference: null, vertical: 'professional-services' }] };
      }
      if (/SET twilio_phone_number/.test(sql)) return { rows: [{ id: params[2] }] };
      if (/FROM users WHERE username = 'admin'/.test(sql)) return { rows: [{ id: 1 }] };
      if (/INSERT INTO tasks/.test(sql)) { state.tasks.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
}
function makeDeps(attachImpl, state) {
  return {
    searchAvailableNumbers: async () => [{ phone_number: '+12125550100' }],
    searchAnyAvailableNumber: async () => [{ phone_number: '+12125550100' }],
    purchaseNumber: async () => ({ phone_sid: PN, phone_number: '+12125550100', capabilities: {} }),
    configureNumberWebhooks: async () => ({}),
    releaseNumber: async (sid) => { state.released.push(sid); },
    attachToMessagingService: async (...a) => { state.attachCalls.push(a); return attachImpl(...a); },
  };
}
const quietLog = (state) => ({ log: (m) => state.logs.push(m), error: (m, ...r) => state.errors.push(m + ' ' + r.join(' ')) });

(async () => {
  // PA1 — happy path: attach called once with the purchased PN sid + env.
  {
    const state = { tasks: [], released: [], attachCalls: [], logs: [], errors: [] };
    const r = await worker.provisionWorkspaceNumber(makePool(state), 99,
      { deps: makeDeps(async () => ({}), state), env: ENV, logger: quietLog(state) });
    check('PA1: successful provisioning attaches the number (once, with the purchased sid and env)',
      r.ok === true && state.attachCalls.length === 1
      && state.attachCalls[0][0] === PN && state.attachCalls[0][1] === ENV,
      JSON.stringify({ r, calls: state.attachCalls.length }));
  }

  // PA2 — attach failure: LOUD (error log + Sentry + operator task),
  // but ok:true and the number is NOT released (no rollback).
  {
    const state = { tasks: [], released: [], attachCalls: [], logs: [], errors: [] };
    const captured = [];
    const r = await worker.provisionWorkspaceNumber(makePool(state), 99, {
      deps: makeDeps(async () => { throw new Error('twilio 20404'); }, state),
      env: ENV, logger: quietLog(state),
      sentry: { captureException: (e) => captured.push(e.message) },
    });
    const taskOk = state.tasks.length === 1 && /Attach a provisioned number/.test(state.tasks[0][1])
      && /\+12125550100/.test(state.tasks[0][3]) && /Voice works/.test(state.tasks[0][3]);
    check('PA2: attach failure -> ok:true, no release, ATTACH FAILED error log, Sentry capture, operator task',
      r.ok === true && state.released.length === 0
      && state.errors.some((e) => e.includes('MESSAGING-SERVICE ATTACH FAILED'))
      && captured.length === 1 && taskOk,
      JSON.stringify({ ok: r.ok, released: state.released, errors: state.errors.length, captured, tasks: state.tasks.length }));
  }

  // PA3 — the real attach fn refuses to run without the env var
  // (throws before any network call) and rejects non-PN sids.
  {
    let msg1 = '', msg2 = '';
    try { await realProv.attachToMessagingService(PN, {}); } catch (e) { msg1 = e.message; }
    try { await realProv.attachToMessagingService('nonsense', ENV); } catch (e) { msg2 = e.message; }
    check('PA3: missing TWILIO_MESSAGING_SERVICE_SID -> loud throw; non-PN sid refused',
      /TWILIO_MESSAGING_SERVICE_SID not set/.test(msg1) && /must be a PN sid/.test(msg2),
      JSON.stringify({ msg1, msg2 }));
  }

  // PA4 — the service SID is env-driven, never hardcoded.
  {
    const a = fs.readFileSync(path.join(__dirname, '..', 'lib', 'twilio-provisioning.js'), 'utf8');
    const b = fs.readFileSync(path.join(__dirname, '..', 'lib', 'provisioning-worker.js'), 'utf8');
    check('PA4: no MG sid literal in provisioning code (env var only)',
      !a.includes('MG5422') && !b.includes('MG5422')
      && a.includes('env.TWILIO_MESSAGING_SERVICE_SID'));
  }

  // PA5 — exactly ONE attach call site, positioned AFTER the success
  // flip, and no code detaches numbers from the service anywhere:
  // existing attachments (ws17) and the excluded numbers (demo 332,
  // toll-free 855) are structurally untouchable.
  {
    const b = fs.readFileSync(path.join(__dirname, '..', 'lib', 'provisioning-worker.js'), 'utf8');
    const a = fs.readFileSync(path.join(__dirname, '..', 'lib', 'twilio-provisioning.js'), 'utf8');
    const callSites = b.split('deps.attachToMessagingService(').length - 1;
    const flipIdx = b.indexOf('SET twilio_phone_number');
    const attachIdx = b.indexOf('deps.attachToMessagingService(');
    check('PA5: one attach call site, after the flip; no detach API anywhere',
      callSites === 1 && flipIdx > 0 && attachIdx > flipIdx
      && !/phoneNumbers\([^)]*\)\s*\.remove/.test(a) && !/\.remove\(/.test(b),
      JSON.stringify({ callSites, flipIdx, attachIdx }));
  }

  console.log(`${pass}/${pass + fail} — prov-attach gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('gate crashed:', err.stack || err.message); process.exit(1); });

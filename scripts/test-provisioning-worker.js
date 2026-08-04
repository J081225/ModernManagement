// scripts/test-provisioning-worker.js — SP4a suite.
//
// Drives the REAL lib/provisioning-worker with a fixture DB (answering
// its exact SQL shapes, clock injected) and fixture Twilio deps. The
// seam itself is source-pinned (the orchestrator's transaction is not
// bootable in a test). Every ruled row: the account commits with
// 'provisioning', the worker provisions, the backoff schedule is
// honored, 'failed' lands at attempt 6, and the sweep catches orphans.
const path = require('path');
const fs = require('fs');
const worker = require(path.join(__dirname, '..', 'lib', 'provisioning-worker'));
const { assertPhoneStatusLegal } = require(path.join(__dirname, '..', 'lib', 'workspace-readiness'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const T0 = 1_800_000_000_000;

function makeDb(rows, opts = {}) {
  const now = () => (opts.nowMs === undefined ? T0 : opts.nowMs);
  return {
    rows,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('UPDATE workspaces SET twilio_attempts = twilio_attempts + 1')) {
        const w = rows.get(params[0]);
        if (!w || w.twilio_status !== 'provisioning') return { rows: [] };
        if (!(w.twilio_next_attempt_at == null || w.twilio_next_attempt_at <= now())) return { rows: [] };
        w.twilio_attempts += 1;
        w.twilio_next_attempt_at = now() + params[1] * 1000;
        return { rows: [{ id: params[0], twilio_attempts: w.twilio_attempts, area_code_preference: w.area_code_preference || null, area_code_backup_preference: w.area_code_backup_preference || null }] };
      }
      if (s.startsWith('UPDATE workspaces SET twilio_phone_number')) {
        const w = rows.get(params[2]);
        if (!w || w.twilio_status !== 'provisioning') return { rows: [] };
        w.twilio_phone_number = params[0];
        w.twilio_phone_sid = params[1];
        w.twilio_status = 'active';
        w.twilio_last_error = null;
        w.twilio_next_attempt_at = null;
        return { rows: [{ id: params[2] }] };
      }
      if (s.startsWith("UPDATE workspaces SET twilio_status = 'failed'")) {
        const w = rows.get(params[0]);
        if (w && w.twilio_status === 'provisioning') {
          w.twilio_status = 'failed'; w.twilio_last_error = params[1]; w.twilio_next_attempt_at = null;
        }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE workspaces SET twilio_last_error')) {
        const w = rows.get(params[0]);
        if (w && w.twilio_status === 'provisioning') {
          w.twilio_last_error = params[1];
          w.twilio_next_attempt_at = now() + params[2] * 1000;
        }
        return { rows: [] };
      }
      if (s.startsWith('SELECT id FROM workspaces WHERE twilio_status =')) {
        const out = [];
        for (const [id, w] of rows) {
          if (w.twilio_status === 'provisioning' && w.twilio_attempts < params[0]
            && (w.twilio_next_attempt_at == null || w.twilio_next_attempt_at <= now())) out.push({ id });
        }
        return { rows: out.sort((a, b) => a.id - b.id) };
      }
      throw new Error('unexpected SQL: ' + s.slice(0, 70));
    },
  };
}

// Fixture Twilio deps: per-call scripts + recorders.
function makeDeps(script = {}) {
  const calls = { searches: [], purchases: [], configures: [], releases: [] };
  return {
    calls,
    searchAvailableNumbers: async (areaCode) => {
      calls.searches.push(areaCode);
      if (script.searchThrows) throw new Error(script.searchThrows);
      const found = (script.available || {})[areaCode] || [];
      return found;
    },
    searchAnyAvailableNumber: async () => {
      calls.searches.push('ANY');
      if (script.anyThrows) throw new Error(script.anyThrows);
      return script.any || [];
    },
    purchaseNumber: async (num) => {
      calls.purchases.push(num);
      if (script.purchaseThrows) throw new Error(script.purchaseThrows);
      return { phone_number: num, phone_sid: 'PN_' + num.slice(-4) };
    },
    configureNumberWebhooks: async (sid, baseUrl) => {
      calls.configures.push({ sid, baseUrl });
      if (script.configureThrows) throw new Error(script.configureThrows);
      return {};
    },
    releaseNumber: async (sid) => { calls.releases.push(sid); return {}; },
  };
}

const ENV = { PUBLIC_BASE_URL: 'https://x.test' };
const quiet = { error: () => {}, log: () => {} };
const wsRow = (over = {}) => ({
  twilio_status: 'provisioning', twilio_attempts: 0, twilio_next_attempt_at: null,
  twilio_phone_number: null, area_code_preference: '443', area_code_backup_preference: '410', ...over,
});

(async () => {
  // ---- PW1: seam source-pins — the account commits with 'provisioning' ----
  {
    const orch = fs.readFileSync(path.join(__dirname, '..', 'lib', 'signup-orchestrator.js'), 'utf8');
    const insertProvisioning = /INSERT INTO workspaces \([\s\S]{0,400}twilio_status[\s\S]{0,300}'provisioning'/.test(orch);
    const backupPersisted = orch.includes('area_code_backup_preference');
    const noTwilioImport = !orch.includes("require('./twilio-provisioning')");
    const noPurchase = !orch.includes('purchaseNumber(') && !orch.includes('purchasedSidForCleanup');
    const kickAfterCommit = orch.indexOf("client.query('COMMIT')") < orch.indexOf('provisioningWorker.provisionWorkspaceNumber(pool, workspaceId)');
    const welcomeNull = orch.includes('twilioPhone: null');
    check('PW1: seam pins — workspace born \'provisioning\' with both area codes; NO twilio import/purchase/cleanup in the orchestrator; kick fires post-COMMIT; welcome email sends null phone',
      insertProvisioning && backupPersisted && noTwilioImport && noPurchase && kickAfterCommit && welcomeNull,
      JSON.stringify({ insertProvisioning, backupPersisted, noTwilioImport, noPurchase, kickAfterCommit, welcomeNull }));
  }

  // ---- PW2: happy path — claim, rung 1, purchase, configure, atomic flip ----
  {
    const rows = new Map([[7, wsRow()]]);
    const deps = makeDeps({ available: { 443: [{ phone_number: '+14435550100' }] } });
    const r = await worker.provisionWorkspaceNumber(makeDb(rows), 7, { deps, env: ENV, logger: quiet });
    const w = rows.get(7);
    check('PW2: worker provisions — active with the number, sid, cleared error/gate; attempt 1; webhooks configured with the canonical base; invariant holds',
      r.ok === true && r.attempt === 1 && w.twilio_status === 'active' && w.twilio_phone_number === '+14435550100'
        && w.twilio_next_attempt_at === null && w.twilio_last_error === null
        && deps.calls.configures.length === 1 && deps.calls.configures[0].baseUrl === 'https://x.test'
        && assertPhoneStatusLegal({ twilio_status: w.twilio_status, twilio_phone_number: w.twilio_phone_number }),
      JSON.stringify({ r, w }));
  }

  // ---- PW3: the 4-rung chain, in order, with the env rung soft-failing ----
  {
    const rows = new Map([[7, wsRow()]]);
    const deps = makeDeps({ available: {}, any: [{ phone_number: '+15555550100' }] });
    // env rung errors -> continue to any-US
    deps.searchAvailableNumbers = (function (orig) {
      return async (areaCode) => {
        deps.calls.searches.push(areaCode);
        if (areaCode === '999') throw new Error('bad fallback area code');
        return [];
      };
    })();
    const r = await worker.provisionWorkspaceNumber(makeDb(rows), 7, { deps, env: { ...ENV, TWILIO_FALLBACK_AREA_CODE: '999' }, logger: quiet });
    check('PW3: rung order primary(443) -> backup(410) -> env(999, error swallowed) -> any-US; provisions from rung 4',
      JSON.stringify(deps.calls.searches) === JSON.stringify(['443', '410', '999', 'ANY'])
        && r.ok === true && rows.get(7).twilio_phone_number === '+15555550100',
      JSON.stringify(deps.calls.searches));
  }

  // ---- PW4: all rungs dry -> failure recorded, backoff[0]=30s, still provisioning ----
  {
    const rows = new Map([[7, wsRow()]]);
    const deps = makeDeps({ available: {}, any: [] });
    const r = await worker.provisionWorkspaceNumber(makeDb(rows), 7, { deps, env: ENV, logger: quiet });
    const w = rows.get(7);
    check('PW4: exhausted rungs -> attempt 1 failed, last_error set, next gate = +30s, status STILL provisioning (the account survives)',
      r.ok === false && r.terminal === false && w.twilio_status === 'provisioning'
        && /No Twilio numbers available/.test(w.twilio_last_error)
        && w.twilio_next_attempt_at === T0 + 30 * 1000,
      JSON.stringify({ r, gate: w.twilio_next_attempt_at - T0 }));
  }

  // ---- PW5: the ruled backoff schedule across failures 1..5 ----
  {
    const expected = [30, 90, 300, 720, 1500];
    const got = [1, 2, 3, 4, 5].map((n) => worker.backoffSeconds(n));
    const rows = new Map([[7, wsRow({ twilio_attempts: 2 })]]); // next claim = attempt 3
    const deps = makeDeps({ available: {}, any: [] });
    await worker.provisionWorkspaceNumber(makeDb(rows), 7, { deps, env: ENV, logger: quiet });
    check('PW5: backoff schedule honored — [30,90,300,720,1500]s after failures 1..5; a 3rd-attempt failure schedules +300s',
      JSON.stringify(got) === JSON.stringify(expected)
        && rows.get(7).twilio_next_attempt_at === T0 + 300 * 1000,
      JSON.stringify({ got, gate: rows.get(7).twilio_next_attempt_at - T0 }));
  }

  // ---- PW6: 'failed' at attempt 6, gate cleared, loud log ----
  {
    const rows = new Map([[7, wsRow({ twilio_attempts: 5 })]]);
    const logs = [];
    const deps = makeDeps({ available: {}, any: [] });
    const r = await worker.provisionWorkspaceNumber(makeDb(rows), 7, { deps, env: ENV, logger: { error: (...a) => logs.push(a.join(' ')), log: () => {} } });
    const w = rows.get(7);
    check("PW6: the 6th failure is terminal — status 'failed', gate NULL, last_error kept, [provisioning] FAILED logged loudly",
      r.terminal === true && w.twilio_status === 'failed' && w.twilio_next_attempt_at === null
        && /No Twilio numbers available/.test(w.twilio_last_error)
        && logs.some((l) => /\[provisioning\] ws=7 FAILED after 6 attempts/.test(l)),
      JSON.stringify({ r, status: w.twilio_status, logs }));
  }

  // ---- PW7: the claim gate — not due / wrong status -> zero Twilio calls ----
  {
    const rows = new Map([
      [7, wsRow({ twilio_next_attempt_at: T0 + 60_000 })], // future gate
      [8, wsRow({ twilio_status: 'active', twilio_phone_number: '+1' })],
    ]);
    const deps = makeDeps({});
    const r1 = await worker.provisionWorkspaceNumber(makeDb(rows), 7, { deps, env: ENV, logger: quiet });
    const r2 = await worker.provisionWorkspaceNumber(makeDb(rows), 8, { deps, env: ENV, logger: quiet });
    check('PW7: a future gate and a non-provisioning status both refuse the claim — no search, no purchase (kick/sweep concurrency safety)',
      r1.attempted === false && r2.attempted === false
        && deps.calls.searches.length === 0 && deps.calls.purchases.length === 0);
  }

  // ---- PW8: the sweep catches orphans and only orphans ----
  {
    const rows = new Map([
      [1, wsRow()],                                                  // due -> attempted
      [2, wsRow({ twilio_next_attempt_at: T0 + 999_999 })],          // future gate -> skipped
      [3, wsRow({ twilio_status: 'active', twilio_phone_number: '+1' })], // done -> skipped
      [4, wsRow({ twilio_status: 'failed' })],                       // terminal -> skipped
      [5, wsRow({ twilio_attempts: 6 })],                            // at cap -> skipped
    ]);
    const deps = makeDeps({ available: { 443: [{ phone_number: '+14435550200' }] } });
    const res = await worker.runProvisioningSweep(makeDb(rows), { deps, env: ENV, logger: quiet });
    check('PW8: sweep work-set = provisioning AND under-cap AND due — exactly one eligible, attempted, now active; future/active/failed/at-cap untouched',
      res.eligible === 1 && res.attempted === 1
        && rows.get(1).twilio_status === 'active'
        && rows.get(2).twilio_status === 'provisioning' && rows.get(4).twilio_status === 'failed',
      JSON.stringify(res));
  }

  // ---- PW9: configure-fails-after-purchase -> the number is RELEASED ----
  {
    const rows = new Map([[7, wsRow()]]);
    const deps = makeDeps({ available: { 443: [{ phone_number: '+14435550300' }] }, configureThrows: 'webhook config down' });
    const r = await worker.provisionWorkspaceNumber(makeDb(rows), 7, { deps, env: ENV, logger: quiet });
    const w = rows.get(7);
    check('PW9: a failure after purchase releases the bought number (never rent two), records the error, stays provisioning',
      r.ok === false && deps.calls.releases.length === 1 && deps.calls.releases[0] === 'PN_0300'
        && w.twilio_status === 'provisioning' && /webhook config down/.test(w.twilio_last_error),
      JSON.stringify({ releases: deps.calls.releases, w }));
  }

  // ---- PW10: server wiring pins — 1-minute sweep + boot run ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('PW10: server.js wires the sweep every 60s plus a boot run, beside the other interval workers',
      srv.includes("require('./lib/provisioning-worker')")
        && /setInterval\(\(\) => \{\s*provisioningWorker\.runProvisioningSweep\(pool\)/.test(srv)
        && srv.includes('}, 60 * 1000); // every minute'),
      'wiring');
  }

  // ================= SP4b: holds, recovery, honest states =================

  // ---- PW11: the failure transition files exactly ONE owner task ----
  {
    const rows = new Map([[7, wsRow({ twilio_attempts: 5, owner_user_id: 3 })]]);
    const tasks = [];
    const db = makeDb(rows);
    const baseQuery = db.query.bind(db);
    db.query = async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO tasks')) { tasks.push({ user_id: params[0], title: params[1], notes: params[3] }); return { rows: [] }; }
      if (s.startsWith("UPDATE workspaces SET twilio_status = 'failed'")) {
        const w = rows.get(params[0]);
        if (!w || w.twilio_status !== 'provisioning') return { rows: [] };
        w.twilio_status = 'failed'; w.twilio_last_error = params[1]; w.twilio_next_attempt_at = null;
        return { rows: [{ owner_user_id: w.owner_user_id }] };
      }
      return baseQuery(sql, params);
    };
    const deps = makeDeps({ available: {}, any: [] });
    await worker.provisionWorkspaceNumber(db, 7, { deps, env: ENV, logger: quiet });
    // A second sweep pass must NOT file another (status is no longer provisioning).
    await worker.provisionWorkspaceNumber(db, 7, { deps, env: ENV, logger: quiet });
    check('PW11: the failed transition files ONE owner task to the workspace owner (account-is-fine wording); a later pass files no duplicate',
      tasks.length === 1 && tasks[0].user_id === 3
        && /phone number needs attention/i.test(tasks[0].title)
        && /account is fully working otherwise/i.test(tasks[0].notes),
      JSON.stringify(tasks));
  }

  // ---- PW12: the re-arm is guarded and puts the row back in the queue ----
  {
    const rows = new Map([
      [7, wsRow({ twilio_status: 'failed', twilio_attempts: 6, twilio_last_error: 'boom' })],
      [8, wsRow({ twilio_status: 'active', twilio_phone_number: '+1', twilio_attempts: 1 })],
      [9, wsRow({ twilio_status: 'provisioning', twilio_attempts: 2 })],
    ]);
    const db = makeDb(rows);
    db.query = (function (base) {
      return async (sql, params = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s.startsWith("UPDATE workspaces SET twilio_status = 'provisioning', twilio_attempts = 0")) {
          const w = rows.get(params[0]);
          if (!w || w.twilio_status !== 'failed') return { rows: [] };
          w.twilio_status = 'provisioning'; w.twilio_attempts = 0; w.twilio_last_error = null; w.twilio_next_attempt_at = null;
          return { rows: [{ id: params[0] }] };
        }
        return base(sql, params);
      };
    })(db.query.bind(db));
    const failed = await worker.rearmProvisioning(db, 7);
    const active = await worker.rearmProvisioning(db, 8);
    const inflight = await worker.rearmProvisioning(db, 9);
    check('PW12: re-arm restores a FAILED row to provisioning with attempts zeroed and error/gate cleared; an active or already-provisioning row is a guarded no-op',
      failed.rearmed === true && rows.get(7).twilio_status === 'provisioning'
        && rows.get(7).twilio_attempts === 0 && rows.get(7).twilio_last_error === null
        && active.rearmed === false && rows.get(8).twilio_status === 'active' && rows.get(8).twilio_attempts === 1
        && inflight.rearmed === false && rows.get(9).twilio_attempts === 2,
      JSON.stringify({ failed, active, inflight }));
  }

  // ---- PW13: a re-armed workspace provisions on the very next attempt ----
  {
    const rows = new Map([[7, wsRow({ twilio_status: 'provisioning', twilio_attempts: 0 })]]);
    const deps = makeDeps({ available: { 443: [{ phone_number: '+14435550999' }] } });
    const r = await worker.provisionWorkspaceNumber(makeDb(rows), 7, { deps, env: ENV, logger: quiet });
    check('PW13: after a re-arm the next attempt is attempt 1 again and can succeed — recovery is real, not cosmetic',
      r.ok === true && r.attempt === 1 && rows.get(7).twilio_status === 'active');
  }

  // ---- PW14: the retry endpoint + status surfacing, source-pinned ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const success = fs.readFileSync(path.join(__dirname, '..', 'views', 'signup-success.html'), 'utf8');
    const endpoint = srv.includes("app.post('/api/workspace/provisioning/retry'")
      && srv.includes('rearmProvisioning(pool, workspaceId)')
      && /Nothing to retry/.test(srv);
    // the require must precede the route that uses it (a real bug caught in review)
    const requireFirst = srv.indexOf("const provisioningWorker = require('./lib/provisioning-worker')")
      < srv.indexOf("app.post('/api/workspace/provisioning/retry'");
    const statusSurfaced = srv.includes('w.twilio_status, u.username') && srv.includes('business_phone_status');
    const screenBranches = success.includes("ws.twilio_status === 'failed'")
      && /account is ready and you can sign in now/.test(success);
    const cardBranches = app.includes("st === 'failed' ? 'Setup failed' : 'Being set up'")
      && app.includes('retryProvisioning');
    check('PW14: the retry endpoint exists (guarded, kicks) with its require ordered before it; twilio_status is surfaced on BOTH the signup-status and settings responses; the success screen and the AD2 card each branch failed-vs-provisioning',
      endpoint && requireFirst && statusSurfaced && screenBranches && cardBranches,
      JSON.stringify({ endpoint, requireFirst, statusSurfaced, screenBranches, cardBranches }));
  }

  // ---- PW15: the customer-send holds, at every ruled site ----
  {
    const pr = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payment-requests.js'), 'utf8');
    const rc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'receipts.js'), 'utf8');
    const ae = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const { customerSmsFrom } = require(path.join(__dirname, '..', 'lib', 'workspace-readiness'));
    // the helper itself: number present -> that number; absent -> null
    const helperOk = customerSmsFrom({ twilio_phone_number: '+14435550100' }) === '+14435550100'
      && customerSmsFrom({ twilio_phone_number: null }) === null
      && customerSmsFrom({ twilio_phone_number: '   ' }) === null
      && customerSmsFrom({}) === null && customerSmsFrom(null) === null;
    const holds = /HOLDING the link SMS/.test(pr) && /sms_held/.test(pr)
      && /HOLDING the receipt SMS/.test(rc)
      && /CANNOT reply/.test(ae)
      && /CANNOT notify customer/.test(srv);
    check('PW15: customerSmsFrom returns the workspace number or null (blank-safe), and all four sites hold with a loud log instead of sending from the platform number',
      helperOk && holds, JSON.stringify({ helperOk, holds }));
  }

  console.log(`${pass}/${pass + fail} — provisioning-worker suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

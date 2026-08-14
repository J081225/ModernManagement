// scripts/test-expiry-sweep.js — AD9, rebuild of the lost `expiry`
// gate (FD3-CP4). runPendingActionExpirySweep is module-scoped AND
// self-runs on require (setInterval + immediate call), so server.js
// can't be imported in a test. Slim gate: REPLAY the sweep's SQL
// semantics against fixtures (TTL split + idempotence + notify/task
// only for customer rows), and SOURCE-PIN that server.js implements
// exactly that with the documented constants and 30-min schedule.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const APPROVAL_TTL_HOURS = 4;   // pinned against server.js in EX6
const OWNER_PENDING_TTL_DAYS = 7;
const HOUR = 3600e3, DAY = 24 * HOUR;

// Replay of the two UPDATEs + the customer-loop side effects. `now` is
// injected; rows carry created_at ages. Returns what flipped and the
// side effects fired.
function sweep(rows, now) {
  const notified = [], ownerTasks = [];
  // 1) customer-originated: phone OR email present, older than 4h.
  for (const r of rows) {
    const customerOriginated = r.customer_phone != null || r.customer_email != null;
    if (r.status === 'pending' && customerOriginated && (now - r.created_at) > APPROVAL_TTL_HOURS * HOUR) {
      r.status = 'expired'; r.resolved_at = now;
      notified.push(r.id);           // notifyPendingActionCustomer
      ownerTasks.push(r.id);         // the owner "Expired: ..." task
    }
  }
  // 2) owner-originated: both null, older than 7d — QUIETLY (no notify/task).
  for (const r of rows) {
    const ownerOriginated = r.customer_phone == null && r.customer_email == null;
    if (r.status === 'pending' && ownerOriginated && (now - r.created_at) > OWNER_PENDING_TTL_DAYS * DAY) {
      r.status = 'expired'; r.resolved_at = now;
    }
  }
  return { notified, ownerTasks };
}

(async () => {
  const NOW = 10 * DAY; // arbitrary fixed clock

  // ---- EX1: a customer row past 4h expires, notifies, and files an owner task ----
  {
    const rows = [{ id: 1, status: 'pending', customer_phone: '+1443', created_at: NOW - 5 * HOUR }];
    const fx = sweep(rows, NOW);
    check('EX1: a customer-originated pending past 4h -> expired, customer notified, owner task filed',
      rows[0].status === 'expired' && fx.notified.includes(1) && fx.ownerTasks.includes(1));
  }

  // ---- EX2: a fresh customer row (under 4h) is untouched ----
  {
    const rows = [{ id: 2, status: 'pending', customer_email: 'c@x.test', created_at: NOW - 2 * HOUR }];
    const fx = sweep(rows, NOW);
    check('EX2: a customer pending only 2h old stays pending, no notify, no task',
      rows[0].status === 'pending' && fx.notified.length === 0 && fx.ownerTasks.length === 0);
  }

  // ---- EX3: an owner-originated row expires QUIETLY at 7d — no notify/task ----
  {
    const rows = [{ id: 3, status: 'pending', customer_phone: null, customer_email: null, created_at: NOW - 8 * DAY }];
    const fx = sweep(rows, NOW);
    check('EX3: an owner-originated pending past 7d -> expired QUIETLY (no customer notify, no owner task)',
      rows[0].status === 'expired' && fx.notified.length === 0 && fx.ownerTasks.length === 0);
  }

  // ---- EX4: an owner row younger than 7d survives; a customer row is NOT held to the 7d rule ----
  {
    const rows = [
      { id: 4, status: 'pending', customer_phone: null, customer_email: null, created_at: NOW - 3 * DAY }, // owner, 3d
      { id: 5, status: 'pending', customer_phone: '+1', created_at: NOW - 5 * HOUR }, // customer, 5h
    ];
    sweep(rows, NOW);
    check('EX4: the two TTLs are independent — owner@3d survives (pending), customer@5h expires',
      rows[0].status === 'pending' && rows[1].status === 'expired');
  }

  // ---- EX5: idempotence — a second sweep flips nothing already expired ----
  {
    const rows = [{ id: 6, status: 'pending', customer_phone: '+1', created_at: NOW - 5 * HOUR }];
    const first = sweep(rows, NOW);
    const second = sweep(rows, NOW + HOUR);
    check('EX5: the status=pending guard makes it idempotent — the 2nd sweep notifies/tasks nothing (each row flips once)',
      first.notified.length === 1 && second.notified.length === 0 && second.ownerTasks.length === 0,
      JSON.stringify({ first: first.notified.length, second: second.notified.length }));
  }

  // ---- EX6: source-pins — the real sweep's constants, predicates, side effects, schedule ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fnIdx = src.indexOf('async function runPendingActionExpirySweep');
    const fn = src.slice(fnIdx, src.indexOf('\nsetInterval(runPendingActionExpirySweep', fnIdx));
    const constsOk = src.includes('const APPROVAL_TTL_HOURS = 4;') && src.includes('const OWNER_PENDING_TTL_DAYS = 7;');
    // customer UPDATE: phone OR email, 4h, RETURNING (drives notify+task)
    const custUpdate = /status = 'pending'[\s\S]{0,120}customer_phone IS NOT NULL OR customer_email IS NOT NULL[\s\S]{0,120}APPROVAL_TTL_HOURS[\s\S]{0,40}RETURNING/.test(fn);
    // owner UPDATE: both null, 7d, no RETURNING (quiet)
    const ownerUpdate = /customer_phone IS NULL AND customer_email IS NULL[\s\S]{0,120}OWNER_PENDING_TTL_DAYS/.test(fn);
    const notifiesCustomer = fn.includes('notifyPendingActionCustomer');
    const filesTask = fn.includes('INSERT INTO tasks') && fn.includes("'Expired: '");
    const schedule = src.includes('setInterval(runPendingActionExpirySweep, 30 * 60 * 1000)');
    check('EX6: server.js pins — TTL constants 4h/7d; customer UPDATE (phone|email, RETURNING) notifies + tasks; owner UPDATE (both null, quiet); 30-min schedule',
      fnIdx !== -1 && constsOk && custUpdate && ownerUpdate && notifiesCustomer && filesTask && schedule,
      JSON.stringify({ constsOk, custUpdate, ownerUpdate, notifiesCustomer, filesTask, schedule }));
  }

  // ---- EX7: source-pin — the piggybacked sweeps ride the same timer ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function runPendingActionExpirySweep'), src.indexOf('\nsetInterval(runPendingActionExpirySweep'));
    check('EX7: the credential-pending, contact-verification, and stale-suggestion sweeps piggyback this one timer (no new intervals)',
      fn.includes('sweepExpiredPendingEmails') && fn.includes('sweepExpiredContactVerifications')
        && /UPDATE tasks SET dismissed_at = NOW\(\)[\s\S]{0,120}suggested = true/.test(fn));
  }

  // ---- EX8: the stale-suggestion sweep ages rows by a tasks column the
  // schema actually DEFINES — regression pin for the createdAt phantom.
  // FD3-CP7 compared tasks."createdAt" while the tasks table had no such
  // column (in any case), so the sweep threw on every run for ~26 days
  // and no suggestion aged out. Tie the sweep's age column to the DDL
  // (CREATE + idempotent ALTER) so query and schema can never drift. ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function runPendingActionExpirySweep'), src.indexOf('\nsetInterval(runPendingActionExpirySweep'));
    // pull the column the stale-suggestion UPDATE compares to NOW()-INTERVAL
    const m = fn.match(/dismissed_at = NOW\(\)[\s\S]{0,200}?AND\s+"?(\w+)"?\s*<\s*NOW\(\)\s*-\s*INTERVAL '7 days'/);
    const ageCol = m && m[1];
    // the tasks CREATE block (bounded slice) must list that column...
    const createBlock = src.slice(src.indexOf('CREATE TABLE IF NOT EXISTS tasks'), src.indexOf('CREATE TABLE IF NOT EXISTS tasks') + 600);
    const inCreate = !!ageCol && new RegExp('"' + ageCol + '"\\s+TIMESTAMPTZ').test(createBlock);
    // ...AND an idempotent ALTER must add it for pre-existing databases
    const inAlter = !!ageCol && new RegExp('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "' + ageCol + '"').test(src);
    check('EX8: the stale-suggestion sweep ages by tasks."' + ageCol + '", and the tasks schema DEFINES it (CREATE + idempotent ALTER) — no phantom-column regression',
      !!ageCol && inCreate && inAlter, JSON.stringify({ ageCol, inCreate, inAlter }));
  }

  console.log(`${pass}/${pass + fail} — expiry-sweep gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

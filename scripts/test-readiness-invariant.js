// scripts/test-readiness-invariant.js — SP3 suite.
//
// The ruled invariant, proven: (twilio_status='active') iff a number
// is attached — unwritable both ways — with connect_status untouched
// and its readers pinned. The executable half drives the REAL
// workspace-readiness lib; the SQL half is replayed + source-pinned
// against migration 061 (the suite never touches a live DB).
const path = require('path');
const fs = require('fs');
const { TWILIO_STATUSES, phoneAxis, workspaceReadiness, assertPhoneStatusLegal } =
  require(path.join(__dirname, '..', 'lib', 'workspace-readiness'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Replay of the 061 CHECKs, byte-faithful to the SQL semantics.
function checksAccept(row) {
  const phoneNotEmpty = row.twilio_phone_number === null || row.twilio_phone_number !== '';
  const statusValid = TWILIO_STATUSES.includes(row.twilio_status);
  const activeIffPhone = (row.twilio_status === 'active') === (row.twilio_phone_number !== null);
  return phoneNotEmpty && statusValid && activeIffPhone;
}

(async () => {
  // ---- RI1: the CHECK rejects BOTH illegal combinations ----
  {
    check('RI1: active-with-NULL-number rejected; number-with-non-active rejected; both legal pairs accepted; provisioning+NULL is LEGAL (SP4\'s pending state)',
      checksAccept({ twilio_status: 'active', twilio_phone_number: '+14435550100' }) === true
        && checksAccept({ twilio_status: 'active', twilio_phone_number: null }) === false
        && checksAccept({ twilio_status: 'not_started', twilio_phone_number: '+14435550100' }) === false
        && checksAccept({ twilio_status: 'provisioning', twilio_phone_number: null }) === true
        && checksAccept({ twilio_status: 'failed', twilio_phone_number: null }) === true
        && checksAccept({ twilio_status: 'zombie', twilio_phone_number: null }) === false
        && checksAccept({ twilio_status: 'active', twilio_phone_number: '' }) === false);
  }

  // ---- RI2: the code-side guard agrees with the DB in both directions ----
  {
    let ok = true;
    try { assertPhoneStatusLegal({ twilio_status: 'active', twilio_phone_number: '+1' }); } catch (e) { ok = false; }
    try { assertPhoneStatusLegal({ twilio_status: 'provisioning', twilio_phone_number: null }); } catch (e) { ok = false; }
    let threw1 = false, threw2 = false, threw3 = false;
    try { assertPhoneStatusLegal({ twilio_status: 'active', twilio_phone_number: null }); } catch (e) { threw1 = true; }
    try { assertPhoneStatusLegal({ twilio_status: 'failed', twilio_phone_number: '+1' }); } catch (e) { threw2 = true; }
    try { assertPhoneStatusLegal({ twilio_status: 'bogus', twilio_phone_number: null }); } catch (e) { threw3 = true; }
    check('RI2: assertPhoneStatusLegal accepts legal pairs and throws on active-sans-number, number-sans-active, and unknown statuses',
      ok && threw1 && threw2 && threw3);
  }

  // ---- RI3: backfill correctness, replayed + ordered before the constraints ----
  {
    // Replay the backfill predicate against the two live-row shapes.
    const backfills = (row) =>
      row.twilio_phone_number !== null && row.twilio_phone_number !== '' && row.twilio_status === 'not_started';
    const withPhone = { twilio_phone_number: '+18555350785', twilio_status: 'not_started' };
    const without = { twilio_phone_number: null, twilio_status: 'not_started' };
    if (backfills(withPhone)) withPhone.twilio_status = 'active';
    if (backfills(without)) without.twilio_status = 'active';
    const rowsLegal = checksAccept(withPhone) && checksAccept(without);
    // Source order: columns -> backfill -> constraints.
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '061_twilio_status.sql'), 'utf8');
    const iCols = mig.indexOf('ADD COLUMN IF NOT EXISTS twilio_status');
    const iBackfill = mig.indexOf("UPDATE workspaces SET twilio_status = 'active'");
    const iCheck = mig.indexOf('workspaces_twilio_active_iff_phone');
    check('RI3: backfill maps has-number->active / no-number->not_started (both then satisfy the CHECK), and runs AFTER the columns, BEFORE the constraints',
      withPhone.twilio_status === 'active' && without.twilio_status === 'not_started' && rowsLegal
        && iCols !== -1 && iCols < iBackfill && iBackfill < iCheck,
      JSON.stringify({ withPhone, without, order: iCols < iBackfill && iBackfill < iCheck }));
  }

  // ---- RI4: the ruled formula appears verbatim in the migration ----
  {
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '061_twilio_status.sql'), 'utf8');
    check('RI4: migration 061 carries the ruled CHECK verbatim, the allowed-values CHECK, the empty-string guard, and only additive ADD COLUMN IF NOT EXISTS',
      mig.includes("CHECK ((twilio_status = 'active') = (twilio_phone_number IS NOT NULL))")
        && mig.includes("CHECK (twilio_status IN ('not_started', 'provisioning', 'active', 'failed'))")
        && mig.includes("CHECK (twilio_phone_number IS NULL OR twilio_phone_number <> '')")
        && (mig.match(/ADD COLUMN IF NOT EXISTS/g) || []).length === 3
        && !/DROP |DELETE FROM workspaces|ALTER COLUMN/.test(mig));
  }

  // ---- RI5: the orchestrator write is ATOMIC — status and number in one statement ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'signup-orchestrator.js'), 'utf8');
    const i = src.indexOf('SET twilio_phone_number   = $1');
    const stmt = src.slice(i, src.indexOf('WHERE id = $3', i));
    check("RI5: the orchestrator's provision UPDATE sets the number, twilio_status='active', and clears last_error in ONE statement (no divergence window)",
      i !== -1 && stmt.includes("twilio_status         = 'active'") && stmt.includes('twilio_last_error     = NULL')
        && src.split('twilio_status         =').length - 1 === 1, // the only writer today
      'atomic statement');
  }

  // ---- RI6: connect_status readers pinned UNTOUCHED (the ruling's other half) ----
  {
    const pr = fs.readFileSync(path.join(__dirname, '..', 'lib', 'payment-requests.js'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const cl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'connect-lifecycle.js'), 'utf8');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const gate = pr.includes("if (workspace.connect_status !== 'ready' || !workspace.stripe_connect_account_id)");
    const ui = app.includes("window._planSummary.connect_status === 'ready'");
    const derive = cl.includes("if (charges_enabled === true) return 'ready';");
    // no writer of connect_status consults twilio anything
    const writers = (srv.match(/connect_status\s+= '/g) || []).length + (cl.match(/connect_status\s+=\s+\$/g) || []).length;
    const noCoupling = !/connect_status[\s\S]{0,200}twilio_phone_number/.test(cl);
    check('RI6: the payment gate, the UI card read, and deriveConnectStatus are byte-untouched; connect_status writers remain 2 and never consult a Twilio column',
      gate && ui && derive && writers === 2 && noCoupling,
      JSON.stringify({ gate, ui, derive, writers, noCoupling }));
  }

  // ---- RI7: the derived view keeps the axes independent ----
  {
    const r1 = workspaceReadiness({ connect_status: 'ready', twilio_status: 'provisioning', twilio_phone_number: null });
    const r2 = workspaceReadiness({ connect_status: 'not_started', twilio_status: 'active', twilio_phone_number: '+1' });
    const r3 = workspaceReadiness({ connect_status: 'ready', twilio_status: 'active', twilio_phone_number: '+1' });
    check('RI7: cards-ready + phone-provisioning coexist (the state the naive invariant would have destroyed); each axis reads independently; both-ready -> overall ready',
      r1.cards_ready === true && r1.phone === 'provisioning' && r1.phone_active === false && r1.overall === 'pending'
        && r2.cards_ready === false && r2.phone_active === true
        && r3.overall === 'ready',
      JSON.stringify({ r1, r2 }));
  }

  // ---- RI8: the derived view never renders active without a number ----
  {
    const lying = workspaceReadiness({ connect_status: 'ready', twilio_status: 'active', twilio_phone_number: null });
    const pre061 = workspaceReadiness({ connect_status: 'ready', twilio_phone_number: '+1' }); // no twilio_status selected
    check('RI8: a lying/stale row can never render phone-active without a number (the number is ground truth); a pre-061 row derives correctly from the number',
      lying.phone_active === false && lying.phone === 'failed'
        && pre061.phone_active === true,
      JSON.stringify({ lying: lying.phone, pre061: pre061.phone }));
  }

  console.log(`${pass}/${pass + fail} — readiness-invariant suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

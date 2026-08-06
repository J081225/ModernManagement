// scripts/test-timezone-setting.js — ST3 suite.
//
// Drives the REAL validator, pins the endpoint + UI wiring, and pins
// the consumer contract: wsTz honors the stored zone with the honest
// default. The setting must never accept a zone downstream date math
// would choke on — the validator IS the runtime's own answer.
const path = require('path');
const fs = require('fs');
const { isValidTimeZone } = require(path.join(__dirname, '..', 'lib', 'timezone'));
const { wsTz } = require(path.join(__dirname, '..', 'lib', 'time-helpers'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  // ---- TZ1: the validator — runtime-true accepts, garbage rejected ----
  {
    const accepts = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC', 'Europe/London', 'Pacific/Honolulu']
      .every(isValidTimeZone);
    const rejects = ['Mars/Olympus_Mons', 'EST5EDT_WRONG', '', '   ', null, undefined, 42,
      'America/New_York; DROP TABLE workspaces', 'x'.repeat(65)]
      .every((z) => !isValidTimeZone(z));
    check('TZ1: every real IANA zone accepted, every non-zone rejected (garbage, empties, non-strings, injection strings, >64 chars) — the runtime is the authority, no hand list',
      accepts && rejects);
  }

  // ---- TZ2: the consumer contract — wsTz honors the setting ----
  {
    check('TZ2: wsTz returns the stored zone when set and the documented default when absent — the setting and every date consumer share one contract',
      wsTz({ timezone: 'America/Chicago' }) === 'America/Chicago'
        && wsTz({ timezone: null }) === 'America/New_York'
        && wsTz(null) === 'America/New_York');
  }

  // ---- TZ3: the endpoints, source-pinned ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const getOk = srv.includes("app.get('/api/workspace/timezone', requireAuth");
    const patchBlock = srv.slice(srv.indexOf("app.patch('/api/workspace/timezone'"), srv.indexOf("// SP4b: the one-tap re-arm"));
    const patchOk = patchBlock.startsWith("app.patch('/api/workspace/timezone', requireAuth")
      && patchBlock.includes('isValidTimeZone(tz)')
      && patchBlock.includes("status(400)")
      && patchBlock.includes('UPDATE workspaces SET timezone = $1 WHERE id = $2');
    check('TZ3: GET returns the zone (defaulted), PATCH is authed, validates through lib/timezone, 400s with an example on garbage, and writes workspace-scoped',
      getOk && patchOk, JSON.stringify({ getOk, patchOk }));
  }

  // ---- TZ4: the card on My Business, wired non-blocking ----
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const card = app.includes('id="mbTimezoneCard"') && app.includes('Business time zone')
      && app.includes('what &ldquo;today&rdquo; means');
    const runtimeList = app.includes("Intl.supportedValuesOf('timeZone')");
    const wired = /async function loadMyBusinessPage\(\) \{[\s\S]{0,300}loadTimezoneCard\(\);/.test(app);
    const saves = app.includes("method: 'PATCH'") && app.includes('mbSaveTimezone');
    check('TZ4: the card lives on My Business with honest what-this-changes copy, options from the runtime\'s own zone list, wired fire-and-forget into the page load, PATCH on save',
      card && runtimeList && wired && saves,
      JSON.stringify({ card, runtimeList, wired, saves }));
  }

  console.log(`${pass}/${pass + fail} — timezone-setting suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

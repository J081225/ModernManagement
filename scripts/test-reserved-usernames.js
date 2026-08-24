// scripts/test-reserved-usernames.js — VE1 reserved-names gate.
//
// Pins: (a) the ruled list is complete and exported from ONE module;
// (b) isReservedUsername matches with the same normalization signup
// applies; (c) BOTH signup sites enforce it with responses byte-
// identical to the "taken" shape (no separate text that advertises the
// reserved list); (d) the gate is new-signups-only — the module is
// pure and the check appears nowhere outside the two signup routes.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reserved-usernames.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const { RESERVED_USERNAMES, isReservedUsername } = require('../lib/reserved-usernames');

// RN1 — the ruled list, verbatim and complete.
const RULED = [
  'admin', 'administrator', 'noreply', 'no_reply', 'support', 'help',
  'billing', 'info', 'sales', 'mail', 'email', 'postmaster', 'abuse',
  'security', 'legal', 'root', 'system', 'contact', 'team', 'hello',
  'office', 'accounts', 'notifications', 'alerts', 'api',
  'mailer_daemon', 'mailer', 'hostmaster', 'webmaster', 'marketing',
  'press', 'privacy', 'staff', 'owner', 'moderator',
  'modernmanagement', 'modernmgmt', 'mm', 'r2labs', 'r2_labs',
];
const missing = RULED.filter((n) => !RESERVED_USERNAMES.has(n));
const extra = [...RESERVED_USERNAMES].filter((n) => !RULED.includes(n));
check('RN1: exported set is EXACTLY the ruled 40-name list',
  missing.length === 0 && extra.length === 0 && RESERVED_USERNAMES.size === 40,
  JSON.stringify({ missing, extra, size: RESERVED_USERNAMES.size }));

// RN2 — matcher behavior: signup's own normalization (trim + lowercase),
// and normal names pass.
check('RN2: reserved names match through trim/case; normal names pass',
  isReservedUsername('admin') === true &&
  isReservedUsername('NoReply') === true &&
  isReservedUsername('  Support  ') === true &&
  isReservedUsername('billing') === true &&
  isReservedUsername('northside') === false &&
  isReservedUsername('jayhorton87') === false &&
  isReservedUsername('') === false &&
  isReservedUsername(null) === false);

// RN3 — availability site: reserved branch exists inside the
// check-username route and returns the BARE taken shape (available:false,
// no reason field — invalid_format is the only reason-bearing branch).
const availStart = serverSrc.indexOf("app.get('/api/signup/check-username'");
const availEnd = serverSrc.indexOf("app.get('/api/signup/check-email'");
const availSlice = availStart >= 0 && availEnd > availStart ? serverSrc.slice(availStart, availEnd) : '';
check('RN3: availability pre-check refuses reserved with bare { available: false }',
  /if \(isReservedUsername\(username\)\) \{\s*\n\s*return res\.json\(\{ available: false \}\);/.test(availSlice),
  'reserved branch missing or shape differs from taken');
check('RN3b: no reserved-specific reason/text in the availability route',
  availSlice.length > 0 && !/reason:\s*'reserved'|reserved list|unavailable/i.test(availSlice.replace(/\/\/[^\n]*/g, '')),
  'route code (comments stripped) leaks a reserved-specific marker');

// RN4 — submit site: reserved branch returns the IDENTICAL 409 + text
// as the taken branch, and sits before the DB uniqueness re-check.
const TAKEN = "res.status(409).json({ error: 'That username is already taken' })";
const reservedAt = serverSrc.indexOf("if (isReservedUsername(username)) {\n    return " + TAKEN);
const uniqueneRecheckAt = serverSrc.indexOf('// Final uniqueness re-check');
check('RN4: submit path refuses reserved with the exact taken 409 text, before the DB re-check',
  reservedAt > 0 && uniqueneRecheckAt > reservedAt,
  JSON.stringify({ reservedAt, uniqueneRecheckAt }));
check('RN4b: the taken text appears for BOTH branches (reserved + collision)',
  serverSrc.split(TAKEN).length - 1 === 2,
  'expected exactly 2 occurrences, found ' + (serverSrc.split(TAKEN).length - 1));

// RN5 — new-signups-only: the lib is pure (no DB/pool access), and
// isReservedUsername is called ONLY at the two signup sites (require
// line aside). Existing rows can never be touched by this gate.
check('RN5: lib module is pure — no pool/query/UPDATE/DELETE',
  !/pool|\.query\(|UPDATE|DELETE/i.test(libSrc));
const callSites = serverSrc.split('isReservedUsername(username)').length - 1;
check('RN5b: exactly two enforcement call sites in server.js',
  callSites === 2 && (serverSrc.split('isReservedUsername').length - 1) === 3,
  JSON.stringify({ callSites, totalMentions: serverSrc.split('isReservedUsername').length - 1 }));

console.log(`${pass}/${pass + fail} — reserved-usernames gate ${fail ? 'FAILED' : 'PASSED'}`);
process.exit(fail ? 1 : 0);

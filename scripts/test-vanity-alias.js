// scripts/test-vanity-alias.js — VE2 vanity-mint gate.
//
// Pins: (a) BOTH mint sites (signup orchestrator + boot backfill)
// produce <username>@modernmanagementapp.com; (b) the three backfilled
// rows hold their exact ruled values (live DB read); (c) the router's
// tier-1 lookup matches the new addresses in the actual database;
// (d) NO code path can produce an @inbound. address anymore;
// (e) payment_forward_token machinery is untouched.

const fs = require('fs');
const path = require('path');
require('dotenv').config();

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const orchSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'signup-orchestrator.js'), 'utf8');

(async () => {
  // VA1 — signup mint is username-based, root domain.
  check('VA1: signup orchestrator mints <username>@modernmanagementapp.com from the validated draft',
    orchSrc.includes("String(draft.username).trim().toLowerCase() + '@modernmanagementapp.com'"));

  // VA2 — boot backfill mints the same format (and selects username).
  const backfillIdx = serverSrc.indexOf('noAliasUsers');
  const backfillSlice = serverSrc.slice(backfillIdx, backfillIdx + 700);
  check('VA2: boot backfill mints ${username}@modernmanagementapp.com (selects username, same normalization)',
    backfillIdx !== -1
    && serverSrc.includes("SELECT id, username FROM users WHERE inbound_email_alias IS NULL OR inbound_email_alias=''")
    && backfillSlice.includes('${String(u.username).trim().toLowerCase()}@modernmanagementapp.com'));

  // VA4 — the dead subdomain is unmintable: zero @inbound. literals in
  // runtime code (server.js + lib/**). Test fixtures are not code paths.
  const libFiles = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) libFiles.push(p);
    }
  })(path.join(__dirname, '..', 'lib'));
  const offenders = [];
  if (serverSrc.includes('@inbound.')) offenders.push('server.js');
  for (const f of libFiles) {
    if (fs.readFileSync(f, 'utf8').includes('@inbound.')) offenders.push(path.relative(path.join(__dirname, '..'), f));
  }
  check('VA4: no runtime code path can produce an @inbound. address (server.js + lib/** clean)',
    offenders.length === 0, JSON.stringify(offenders));

  // VA6 — payment_forward_token machinery untouched: generator still
  // exists and the token mint sites still use it.
  check('VA6: payment_forward_token machinery untouched (generator + both token mints intact)',
    serverSrc.includes('function generateForwardToken()')
    && serverSrc.includes('const token = generateForwardToken();')
    && orchSrc.includes('const forwardToken = generateForwardToken();'));

  // VA3 + VA5 — live DB: exact backfilled values, and the router's
  // tier-1 predicate (LOWER(inbound_email_alias)=$1) matches them.
  if (!process.env.DATABASE_URL) {
    check('VA3: backfilled rows hold exact ruled values (DB read)', false, 'DATABASE_URL not set');
    check('VA5: router tier-1 predicate matches the new addresses in the DB', false, 'DATABASE_URL not set');
  } else {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try {
      const { rows } = await pool.query(
        'SELECT id, inbound_email_alias FROM users WHERE id IN (1, 14, 18) ORDER BY id'
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.inbound_email_alias]));
      check('VA3: backfilled rows hold exact ruled values (DB read)',
        byId[1] === 'admin@modernmanagementapp.com'
        && byId[14] === 'jayhorton87@modernmanagementapp.com'
        && byId[18] === 'northside_demo@modernmanagementapp.com',
        JSON.stringify(byId));
      // Same predicate lookupUserByEmailAlias uses (tier 1), same
      // normalization (wire address lowercased) — mixed-case probe.
      const probe = 'Jayhorton87@ModernManagementApp.com'.toLowerCase();
      const { rows: hit } = await pool.query(
        'SELECT id FROM users WHERE LOWER(inbound_email_alias)=$1 LIMIT 1', [probe]
      );
      check('VA5: router tier-1 predicate matches the new addresses in the DB',
        hit.length === 1 && hit[0].id === 14, JSON.stringify(hit));
    } finally {
      await pool.end();
    }
  }

  console.log(`${pass}/${pass + fail} — vanity-alias gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('gate crashed:', err.message); process.exit(1); });

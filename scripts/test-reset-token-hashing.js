// scripts/test-reset-token-hashing.js — AD8 (d) suite.
//
// Proves the reset-token hashing end to end WITHOUT a live server: it
// replays the exact insert/lookup the server does (hash on write, hash
// on read, raw token in the URL), and source-pins that every
// password_reset_tokens lookup in server.js keys on a hashed value and
// the migration clears plaintext rows.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { hashToken } = require(path.join(__dirname, '..', 'lib', 'credentials'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// A fixture table that stores exactly what it's given (like Postgres),
// so "was the row plaintext or hash?" is observable.
function makeTokenTable() {
  const rows = [];
  return {
    rows,
    query: async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO password_reset_tokens')) {
        rows.push({ token: params[0], user_id: params[1], used_at: null, expires_at: new Date(Date.now() + 3600e3).toISOString() });
        return { rows: [] };
      }
      if (s.startsWith('SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token =')) {
        const r = rows.find((x) => x.token === params[0]);
        return { rows: r ? [r] : [] };
      }
      throw new Error('unexpected SQL: ' + s.slice(0, 60));
    },
  };
}

(async () => {
  // ---- D1: mint -> the URL carries the RAW token; the row stores the HASH ----
  {
    const db = makeTokenTable();
    const token = crypto.randomBytes(32).toString('hex');       // as server mints
    await db.query('INSERT INTO password_reset_tokens (token, user_id) VALUES ($1, $2)', [hashToken(token), 7]);
    const url = '/reset-password?token=' + encodeURIComponent(token); // as server builds
    const stored = db.rows[0].token;
    check('D1: URL carries the raw 64-hex token; the stored row is its sha256, never the raw value',
      url.includes(token) && /^[a-f0-9]{64}$/.test(token)
        && stored === hashToken(token) && stored !== token,
      JSON.stringify({ rawInUrl: url.includes(token), storedIsHash: stored === hashToken(token) }));
  }

  // ---- D2: the mailed token verifies (hash-on-read finds the row) ----
  {
    const db = makeTokenTable();
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO password_reset_tokens (token, user_id) VALUES ($1, $2)', [hashToken(token), 7]);
    // check-token / reset both look up by hashToken(input)
    const found = await db.query('SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token = $1', [hashToken(token)]);
    check('D2: presenting the raw token from the email finds its row via hash-on-read',
      found.rows.length === 1 && found.rows[0].user_id === 7, JSON.stringify(found.rows));
  }

  // ---- D3: a stolen DB row (the hash) is NOT a usable token ----
  {
    const db = makeTokenTable();
    const token = crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO password_reset_tokens (token, user_id) VALUES ($1, $2)', [hashToken(token), 7]);
    const leaked = db.rows[0].token; // what a DB read yields
    // an attacker submitting the leaked value gets it hashed AGAIN -> no match
    const attempt = await db.query('SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token = $1', [hashToken(leaked)]);
    check('D3: submitting the at-rest value (the hash) hashes again and matches nothing',
      attempt.rows.length === 0, JSON.stringify(attempt.rows));
  }

  // ---- D4: wrong token never collides ----
  {
    const db = makeTokenTable();
    const good = crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO password_reset_tokens (token, user_id) VALUES ($1, $2)', [hashToken(good), 7]);
    const other = await db.query('SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token = $1', [hashToken(crypto.randomBytes(32).toString('hex'))]);
    check('D4: a different token hashes to a different key — no match', other.rows.length === 0);
  }

  // ---- D5: source pins — every server lookup hashes; migration clears plaintext ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    // The INSERT and all three token-keyed lookups must pass a hashed value.
    const insertHashed = src.includes('INSERT INTO password_reset_tokens (token, user_id) VALUES ($1, $2)')
      && src.includes('[credentials.hashToken(token), user.id]');
    // No lookup may pass a bare [token]/[token] param to a password_reset_tokens query.
    // Grab each password_reset_tokens statement's following param line.
    const rawParamLeak = /password_reset_tokens[\s\S]{0,120}?WHERE token = \$1[\s\S]{0,60}?\[token\]/.test(src);
    const usesTokenHashVar = src.includes('const tokenHash = credentials.hashToken(token);')
      && src.includes('[tokenHash]');
    const checkHashed = src.includes('[credentials.hashToken(token)] // AD8 (d): look up by hash');
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '060_hash_reset_tokens.sql'), 'utf8');
    const migClears = /DELETE FROM password_reset_tokens;/.test(mig);
    check('D5: server INSERT + check-token + reset(FOR UPDATE + used_at) all key on the hash; no raw-[token] lookup remains; migration DELETEs plaintext rows',
      insertHashed && checkHashed && usesTokenHashVar && !rawParamLeak && migClears,
      JSON.stringify({ insertHashed, checkHashed, usesTokenHashVar, rawParamLeak, migClears }));
  }

  // ---- D6: the URL/email builder is UNCHANGED (raw token, same path) ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    check('D6: the reset URL still encodes the RAW token — the email UX is untouched',
      src.includes("baseUrl + '/reset-password?token=' + encodeURIComponent(token)"),
      'reset URL builder');
  }

  console.log(`${pass}/${pass + fail} — reset-token-hashing suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

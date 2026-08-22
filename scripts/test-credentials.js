// scripts/test-credentials.js — AD3 c4 suite.
//
// Drives lib/credentials (the real extracted logic) with fixture DBs,
// plus source pins on server.js where the law lives in the adapter
// (notice sends non-blocking, reset flow untouched). No behavior is
// asserted that isn't executed or pinned.
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const cred = require(path.join(__dirname, '..', 'lib', 'credentials'));

const ROUNDS = 4; // fast fixtures; the server passes BCRYPT_ROUNDS=10
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Fixture DB over a users Map + sessions array, answering the exact
// SQL shapes the lib issues (throws on anything unexpected).
function makeDb(users, sessions) {
  return {
    query: async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT id, username, password_hash, email FROM users WHERE id =')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ id: params[0], username: u.username, password_hash: u.password_hash, email: u.email }] : [] };
      }
      if (s.startsWith('SELECT pending_email FROM users WHERE id =')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ pending_email: u.pending_email || null }] : [] };
      }
      if (s.startsWith('UPDATE users SET password_hash = $1, pending_email = NULL')) {
        const u = users.get(params[1]);
        if (u) { u.password_hash = params[0]; u.pending_email = null; u.pending_email_token_hash = null; u.pending_email_expires = null; }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE users SET pending_email = $1, pending_email_token_hash = $2')) {
        const u = users.get(params[3]);
        if (u) { u.pending_email = params[0]; u.pending_email_token_hash = params[1]; u.pending_email_expires = params[2]; }
        return { rows: [] };
      }
      if (s.startsWith('SELECT id, email, pending_email, pending_email_expires FROM users WHERE pending_email_token_hash =')) {
        for (const [id, u] of users) {
          if (u.pending_email_token_hash === params[0]) {
            return { rows: [{ id, email: u.email, pending_email: u.pending_email, pending_email_expires: u.pending_email_expires }] };
          }
        }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE users SET email = pending_email')) {
        const u = users.get(params[0]);
        if (u) { u.email = u.pending_email; u.pending_email = null; u.pending_email_token_hash = null; u.pending_email_expires = null; }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE users SET pending_email_token_hash = $1, pending_email_expires = $2')) {
        const u = users.get(params[2]);
        if (u) { u.pending_email_token_hash = params[0]; u.pending_email_expires = params[1]; }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE users SET pending_email = NULL')) {
        const u = users.get(params[0]);
        if (u) { u.pending_email = null; u.pending_email_token_hash = null; u.pending_email_expires = null; }
        return { rows: [] };
      }
      if (s.startsWith('SELECT username, email, pending_email, pending_email_expires FROM users WHERE id =')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ username: u.username, email: u.email, pending_email: u.pending_email || null, pending_email_expires: u.pending_email_expires || null }] : [] };
      }
      if (s.startsWith('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)')) {
        for (const [id, u] of users) {
          if (id !== params[1] && String(u.username).toLowerCase() === String(params[0]).toLowerCase()) {
            return { rows: [{ '?column?': 1 }] };
          }
        }
        return { rows: [] };
      }
      if (s.startsWith('UPDATE users SET username = $1')) {
        const u = users.get(params[1]);
        if (u) u.username = params[0];
        return { rows: [] };
      }
      if (s.startsWith('DELETE FROM user_sessions')) {
        const before = sessions.length;
        const kept = sessions.filter((row) => !(row.userId === params[0] && row.sid !== params[1]));
        const removed = before - kept.length;
        sessions.length = 0;
        sessions.push(...kept);
        return { rows: [], rowCount: removed };
      }
      // The mid-pending reset proof drives the reset flow's EXACT
      // lookup (asserted byte-identical against server.js source in
      // CR11): it reads users.email only.
      if (s.startsWith('SELECT id, username, email FROM users WHERE LOWER(email) = $1')) {
        for (const [id, u] of users) {
          if (String(u.email || '').toLowerCase() === params[0]) {
            return { rows: [{ id, username: u.username, email: u.email }] };
          }
        }
        return { rows: [] };
      }
      throw new Error('unexpected SQL: ' + s.slice(0, 70));
    },
  };
}

// 2026-08-22: LIMIT 1 -> ORDER BY id — a shared email resets EVERY
// matching account (the LIMIT 1 silently reset the wrong one; see D7 in
// test-reset-token-hashing). The guard's intent is unchanged: the reset
// lookup must reference NO pending-email columns.
const RESET_LOOKUP_SQL = 'SELECT id, username, email FROM users WHERE LOWER(email) = $1 ORDER BY id';

(async () => {
  const HASH = await bcrypt.hash('correct-horse-9', ROUNDS);
  const mkUser = (over = {}) => ({
    username: 'jay', password_hash: HASH, email: 'old@a.test',
    notifications_enabled: true, pending_email: null,
    pending_email_token_hash: null, pending_email_expires: null, ...over,
  });

  // ---- CR1: wrong password generic; 6th attempt -> SAME words via 429 ----
  {
    const users = new Map([[7, mkUser()]]);
    const db = makeDb(users, []);
    const attempts = new Map();
    const t0 = 1_000_000;
    const bodies = [];
    for (let i = 0; i < 6; i++) {
      const r = await cred.changePassword(db, 7, {
        current_password: 'wrong-guess', new_password: 'brand-new-pw-1', confirm_password: 'brand-new-pw-1',
      }, attempts, t0 + i * 1000, { rounds: ROUNDS });
      bodies.push(r);
    }
    const firstFive = bodies.slice(0, 5).every((r) => r.status === 400 && r.body.error === cred.GENERIC_REAUTH);
    const sixth = bodies[5];
    check('CR1: wrong password -> generic; 6th in window -> 429 with the SAME sentence',
      firstFive && sixth.status === 429 && sixth.body.error === cred.GENERIC_REAUTH,
      JSON.stringify(sixth));
    const later = await cred.changePassword(db, 7, {
      current_password: 'correct-horse-9', new_password: 'brand-new-pw-1', confirm_password: 'brand-new-pw-1',
    }, attempts, t0 + 16 * 60 * 1000, { rounds: ROUNDS });
    check('CR1b: window slides — attempt at +16min goes through', later.status === 200 && later.changed === true, JSON.stringify(later));
  }

  // ---- CR2 (LAW 3): notifications_enabled=false never mutes the alarm ----
  {
    const users = new Map([[7, mkUser({ notifications_enabled: false })]]);
    const r = await cred.changePassword(makeDb(users, []), 7, {
      current_password: 'correct-horse-9', new_password: 'brand-new-pw-1', confirm_password: 'brand-new-pw-1',
    }, new Map(), 1_000_000, { rounds: ROUNDS });
    const libOk = r.changed === true && r.notifyEmail === 'old@a.test';
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const epStart = src.indexOf("app.post('/api/credentials/change-password'");
    const epEnd = src.indexOf('app.post', epStart + 10);
    // Strip comment lines first — the comment NAMES the law it
    // ignores; the pin is that no CODE consults the flag.
    const endpointCode = src.slice(epStart, epEnd)
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    const neverConsults = !endpointCode.includes('notifications_enabled');
    check('CR2: LAW 3 — notice email returned with notifications off; endpoint never consults the flag',
      libOk && epStart !== -1 && neverConsults, JSON.stringify({ libOk, neverConsults }));
  }

  // ---- CR3: new == current refused; floor enforced ----
  {
    const users = new Map([[7, mkUser()]]);
    const db = makeDb(users, []);
    const same = await cred.changePassword(db, 7, {
      current_password: 'correct-horse-9', new_password: 'correct-horse-9', confirm_password: 'correct-horse-9',
    }, new Map(), 1_000_000, { rounds: ROUNDS });
    const short = await cred.changePassword(db, 7, {
      current_password: 'correct-horse-9', new_password: 'short7c', confirm_password: 'short7c',
    }, new Map(), 1_000_000, { rounds: ROUNDS });
    check('CR3: new == current refused honestly; 7-char floor rejection',
      same.status === 400 && /nothing to change/.test(same.body.error)
        && short.status === 400 && short.body.field === 'new_password', JSON.stringify({ same: same.body, short: short.body }));
  }

  // ---- CR4: other sessions end, current survives ----
  {
    const sessions = [
      { sid: 'sid-current', userId: 7 },
      { sid: 'sid-laptop', userId: 7 },
      { sid: 'sid-phone', userId: 7 },
      { sid: 'sid-other-user', userId: 8 },
    ];
    const n = await cred.endOtherSessions(makeDb(new Map(), sessions), 7, 'sid-current');
    check('CR4: 2 other sessions ended; current and other-user sessions survive',
      n === 2 && sessions.some((s) => s.sid === 'sid-current')
        && sessions.some((s) => s.sid === 'sid-other-user') && sessions.length === 2,
      JSON.stringify({ n, sessions }));
  }

  // ---- CR5: request parks pending; token stored HASHED; email untouched ----
  let savedToken = null;
  {
    const users = new Map([[7, mkUser()]]);
    const db = makeDb(users, []);
    const r = await cred.requestEmailChange(db, 7, {
      new_email: '  NEW@B.Test ', current_password: 'correct-horse-9',
    }, new Map(), 1_000_000);
    savedToken = r.token;
    const u = users.get(7);
    check('CR5: pending parked lowercased; users.email untouched; row stores sha256, not the mailed token',
      r.status === 200 && u.pending_email === 'new@b.test' && u.email === 'old@a.test'
        && u.pending_email_token_hash !== r.token
        && u.pending_email_token_hash === cred.hashToken(r.token)
        && r.body.pending_email_masked === 'n***@b***.test',
      JSON.stringify({ body: r.body, u }));
  }

  // ---- CR6 (LAW 2 teeth): MID-PENDING, the reset flow keys on the OLD address ----
  {
    const users = new Map([[7, mkUser({
      pending_email: 'new@b.test',
      pending_email_token_hash: cred.hashToken('a'.repeat(64)),
      pending_email_expires: new Date(2_000_000).toISOString(),
    })]]);
    const db = makeDb(users, []);
    const byOld = await db.query(RESET_LOOKUP_SQL, ['old@a.test']);
    const byNew = await db.query(RESET_LOOKUP_SQL, ['new@b.test']);
    check('CR6: mid-pending reset lookup finds the OLD address, nothing at the NEW',
      byOld.rows.length === 1 && byOld.rows[0].id === 7 && byNew.rows.length === 0,
      JSON.stringify({ byOld: byOld.rows, byNew: byNew.rows }));
  }

  // ---- CR7: verify swaps + single-use; expiry honored ----
  {
    const users = new Map([[7, mkUser()]]);
    const db = makeDb(users, []);
    const req1 = await cred.requestEmailChange(db, 7, {
      new_email: 'new@b.test', current_password: 'correct-horse-9',
    }, new Map(), 1_000_000);
    const v1 = await cred.verifyEmailChange(db, req1.token, 1_000_000 + 10 * 60 * 1000);
    const u = users.get(7);
    const v2 = await cred.verifyEmailChange(db, req1.token, 1_000_000 + 11 * 60 * 1000);
    check('CR7: valid verify swaps email + clears pending; SECOND use of the same token fails, email unchanged',
      v1.ok === true && u.email === 'new@b.test' && u.pending_email === null
        && v2.ok === false && u.email === 'new@b.test',
      JSON.stringify({ v1, v2, u }));
    const req2 = await cred.requestEmailChange(db, 7, {
      new_email: 'third@c.test', current_password: 'correct-horse-9',
    }, new Map(), 5_000_000);
    const vLate = await cred.verifyEmailChange(db, req2.token, 5_000_000 + 61 * 60 * 1000);
    check('CR7b: clock-advanced past the hour -> expired, email unchanged',
      vLate.ok === false && vLate.reason === 'expired' && users.get(7).email === 'new@b.test',
      JSON.stringify(vLate));
  }

  // ---- CR8: cancel needs the password; with it, pending clears ----
  {
    const users = new Map([[7, mkUser({ pending_email: 'new@b.test', pending_email_token_hash: 'x', pending_email_expires: new Date(9_999_999).toISOString() })]]);
    const db = makeDb(users, []);
    const bad = await cred.cancelEmailChange(db, 7, { current_password: 'thief-guess' }, new Map(), 1_000_000);
    const stillPending = users.get(7).pending_email === 'new@b.test';
    const good = await cred.cancelEmailChange(db, 7, { current_password: 'correct-horse-9' }, new Map(), 1_000_000);
    check('CR8: cancel without the password refused (generic) and pending intact; with it, cleared',
      bad.status === 400 && bad.body.error === cred.GENERIC_REAUTH && stillPending
        && good.status === 200 && users.get(7).pending_email === null,
      JSON.stringify({ bad: bad.body, pending: users.get(7).pending_email }));
  }

  // ---- CR9: password change mid-pending CANCELS the pending ----
  {
    const users = new Map([[7, mkUser({ pending_email: 'new@b.test', pending_email_token_hash: 'x', pending_email_expires: new Date(9_999_999).toISOString() })]]);
    const r = await cred.changePassword(makeDb(users, []), 7, {
      current_password: 'correct-horse-9', new_password: 'brand-new-pw-1', confirm_password: 'brand-new-pw-1',
    }, new Map(), 1_000_000, { rounds: ROUNDS });
    check('CR9: password change cancels the pending and says so',
      r.changed === true && r.pendingCancelled === true && r.body.pending_email_cancelled === true
        && users.get(7).pending_email === null,
      JSON.stringify({ body: r.body, pending: users.get(7).pending_email }));
  }

  // ---- CR10: resend limit — 4th in the hour trips ----
  {
    const map = new Map();
    const t0 = 1_000_000;
    const g1 = cred.windowGate(map, 7, t0, 3, 60 * 60 * 1000);
    const g2 = cred.windowGate(map, 7, t0 + 1000, 3, 60 * 60 * 1000);
    const g3 = cred.windowGate(map, 7, t0 + 2000, 3, 60 * 60 * 1000);
    const g4 = cred.windowGate(map, 7, t0 + 3000, 3, 60 * 60 * 1000);
    const g5 = cred.windowGate(map, 7, t0 + 61 * 60 * 1000, 3, 60 * 60 * 1000);
    check('CR10: resend gate — 3 allowed, 4th trips, next hour allowed again',
      g1.allowed && g2.allowed && g3.allowed && !g4.allowed && g5.allowed,
      JSON.stringify({ g4, g5 }));
  }

  // ---- CR11: reset flow untouched — source pins ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const lookupPresent = src.includes(RESET_LOOKUP_SQL);
    const resetBlocks = [];
    for (const marker of ["app.post('/api/auth/request-password-reset'", "app.post('/api/auth/reset-password'", '/api/auth/check-reset-token']) {
      const i = src.indexOf(marker);
      if (i !== -1) resetBlocks.push(src.slice(i, src.indexOf('app.', i + 10)));
    }
    const untouched = resetBlocks.length >= 2 && resetBlocks.every((b) => !b.includes('pending_email'));
    check('CR11: reset lookup SQL byte-identical in server.js; reset endpoints reference no pending columns',
      lookupPresent && untouched, JSON.stringify({ lookupPresent, blocks: resetBlocks.length }));
  }

  // ---- CR12: username — case-flipped collision refused; valid change lands ----
  {
    const users = new Map([
      [7, mkUser()],
      [8, mkUser({ username: 'taken_name', email: 'b@b.test' })],
    ]);
    const db = makeDb(users, []);
    const flip = await cred.changeUsername(db, 7, {
      new_username: 'taken_name', current_password: 'correct-horse-9',
    }, new Map(), 1_000_000);
    // case-flipped collision: fixture stores a legacy mixed-case name
    users.set(9, mkUser({ username: 'Legacy_Case', email: 'c@c.test' }));
    const flip2 = await cred.changeUsername(db, 7, {
      new_username: 'legacy_case', current_password: 'correct-horse-9',
    }, new Map(), 1_000_000);
    const good = await cred.changeUsername(db, 7, {
      new_username: 'fresh_name', current_password: 'correct-horse-9',
    }, new Map(), 1_000_000);
    check('CR12: exact and case-flipped collisions both refused honestly; valid change lands + notice email returned',
      flip.status === 400 && /taken/.test(flip.body.error)
        && flip2.status === 400 && /taken/.test(flip2.body.error)
        && good.status === 200 && users.get(7).username === 'fresh_name' && good.notifyEmail === 'old@a.test',
      JSON.stringify({ flip: flip.body, flip2: flip2.body, good: good.body }));
  }

  // ---- CR13: masking rule pinned ----
  {
    check('CR13: masking — j***@g***.com shape, defined once',
      cred.maskEmail('jay@gmail.com') === 'j***@g***.com'
        && cred.maskEmail('nina@dept.example.co') === 'n***@d***.co'
        && cred.maskEmail('') === '',
      cred.maskEmail('jay@gmail.com'));
  }

  // ---- CR14: mail failure non-blocking — by construction, pinned ----
  {
    // The lib completes the change with no mail in sight (CR2/CR9
    // executed that); the adapter's sends must each sit inside their
    // own try/catch that logs err.message. Pin the structure: in the
    // credentials endpoint region every sgMail.send is inside a try
    // block followed by a catch that console.errors.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const region = src.slice(src.indexOf("app.post('/api/credentials/change-password'"), src.indexOf("const _testAlertLast"));
    const sends = region.split('sgMail.send').length - 1;
    const guarded = region.split(/try \{\s*\r?\n\s*await sgMail\.send/).length - 1;
    check('CR14: every credentials-region sgMail.send (' + sends + ') is try/catch-guarded — change never blocks on mail',
      sends >= 5 && sends === guarded, JSON.stringify({ sends, guarded }));
  }

  // ---- CR15: no secrets in logs — lib + endpoint console lines ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'credentials.js'), 'utf8');
    const region = src.slice(src.indexOf("app.post('/api/credentials/change-password'"), src.indexOf("const _testAlertLast"));
    const offenders = [];
    for (const text of [region, lib]) {
      for (const line of text.split(/\r?\n/)) {
        if (!/console\.(log|error|warn)/.test(line)) continue;
        if (/result\.token|\btoken\s*[,)+]|current_password|new_password|password_hash|req\.body/.test(line)) offenders.push(line.trim());
      }
    }
    check('CR15: zero console lines interpolate a token, password, or body', offenders.length === 0, JSON.stringify(offenders));
  }

  console.log(`${pass}/${pass + fail} — credentials suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

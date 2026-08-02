// scripts/test-kill-switch.js — AD7 c3 suite.
//
// Drives lib/credentials.burnCredentialArtifacts with one fixture DB
// holding every artifact class, plus source pins on the two triggers
// and the trigger-list completeness (a new bcrypt.hash site trips a
// row instead of appearing silently unwired).
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const cred = require(path.join(__dirname, '..', 'lib', 'credentials'));

const ROUNDS = 4;
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Fixture: users map + per-table arrays. opts.failOn makes one burn's
// SQL throw, proving independence.
function makeDb(state, opts = {}) {
  return {
    query: async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      const failIf = (key) => { if (opts.failOn === key) throw new Error(key + ' exploded (fixture)'); };
      if (s.startsWith('DELETE FROM user_sessions')) {
        failIf('sessions');
        const exceptSid = s.includes('sid <>') ? params[1] : null;
        const before = state.sessions.length;
        state.sessions = state.sessions.filter((row) =>
          !(row.userId === params[0] && (exceptSid === null || row.sid !== exceptSid)));
        return { rowCount: before - state.sessions.length };
      }
      if (s.startsWith('DELETE FROM password_reset_tokens')) {
        failIf('reset_tokens');
        const before = state.resetTokens.length;
        state.resetTokens = state.resetTokens.filter((r) => r.user_id !== params[0]);
        return { rowCount: before - state.resetTokens.length };
      }
      if (s.startsWith('UPDATE users SET pending_email = NULL')) {
        failIf('pending_email');
        const u = state.users.get(params[0]);
        if (!u || !u.pending_email) return { rowCount: 0 };
        u.pending_email = null; u.pending_email_token_hash = null; u.pending_email_expires = null;
        return { rowCount: 1 };
      }
      if (s.startsWith('DELETE FROM contact_verifications')) {
        failIf('contact_verifications');
        const before = state.verifs.length;
        state.verifs = state.verifs.filter((r) => r.user_id !== params[0]);
        return { rowCount: before - state.verifs.length };
      }
      if (s.startsWith('DELETE FROM push_subscriptions')) {
        failIf('push_subscriptions');
        const before = state.pushSubs.length;
        state.pushSubs = state.pushSubs.filter((r) => r.user_id !== params[0]);
        return { rowCount: before - state.pushSubs.length };
      }
      if (s.startsWith('SELECT id, username, password_hash, email FROM users')) {
        const u = state.users.get(params[0]);
        return { rows: u ? [{ id: params[0], username: u.username || 'u', password_hash: u.password_hash || '', email: u.email || '' }] : [] };
      }
      if (s.startsWith('SELECT pending_email FROM users')) {
        const u = state.users.get(params[0]);
        return { rows: u ? [{ pending_email: u.pending_email || null }] : [] };
      }
      if (s.startsWith('UPDATE users SET password_hash = $1, pending_email = NULL')) {
        const u = state.users.get(params[1]);
        if (u) { u.password_hash = params[0]; u.pending_email = null; u.pending_email_token_hash = null; u.pending_email_expires = null; }
        return { rows: [] };
      }
      throw new Error('unexpected SQL: ' + s.slice(0, 70));
    },
  };
}

function fullState() {
  return {
    users: new Map([[7, {
      username: 'jay', email: 'acct@a.test',
      pending_email: 'swap@b.test', pending_email_token_hash: 'h', pending_email_expires: '2099-01-01',
      payment_forward_token: 'fwd-SURVIVES', inbound_email_alias: 'user-x@inbound.test',
    }]]),
    sessions: [
      { sid: 'sid-current', userId: 7 },
      { sid: 'sid-laptop', userId: 7 },
      { sid: 'sid-phone', userId: 7 },
      { sid: 'sid-other-user', userId: 8 },
    ],
    resetTokens: [
      { token: 't1', user_id: 7 }, { token: 't2', user_id: 7 },
      { token: 't-other', user_id: 8 },
    ],
    verifs: [
      { user_id: 7, field: 'notification_email' }, { user_id: 7, field: 'alert_phone' },
      { user_id: 8, field: 'alert_phone' },
    ],
    pushSubs: [
      { user_id: 7, endpoint: 'e1' }, { user_id: 7, endpoint: 'e2' },
      { user_id: 8, endpoint: 'e-other' },
    ],
  };
}

const quiet = { error: () => {}, log: () => {} };

(async () => {
  // ---- K1: keepSid — others die, current + other-user survive ----
  {
    const st = fullState();
    const counts = await cred.burnCredentialArtifacts(makeDb(st), 7, { keepSid: 'sid-current', logger: quiet });
    check('K1: keepSid semantics — 2 other sessions die; current sid and the other user survive',
      counts.sessions === 2
        && st.sessions.some((x) => x.sid === 'sid-current')
        && st.sessions.some((x) => x.sid === 'sid-other-user')
        && st.sessions.length === 2,
      JSON.stringify({ counts, sessions: st.sessions }));
  }

  // ---- K2: no keepSid — the reset case keeps NOTHING ----
  {
    const st = fullState();
    const counts = await cred.burnCredentialArtifacts(makeDb(st), 7, { logger: quiet });
    check('K2: no keepSid — all 3 of the user\'s sessions die, the other user\'s survives',
      counts.sessions === 3 && st.sessions.length === 1 && st.sessions[0].sid === 'sid-other-user',
      JSON.stringify({ counts, sessions: st.sessions }));
  }

  // ---- K3: every artifact class dies, exact counts, user-scoped ----
  {
    const st = fullState();
    const counts = await cred.burnCredentialArtifacts(makeDb(st), 7, { keepSid: 'sid-current', logger: quiet });
    check('K3: reset tokens (2), pending swap (1), verifications (2), push subs (2) all burn — other user\'s artifacts untouched',
      counts.reset_tokens === 2 && counts.pending_email === 1
        && counts.contact_verifications === 2 && counts.push_subscriptions === 2
        && st.resetTokens.length === 1 && st.resetTokens[0].user_id === 8
        && st.verifs.length === 1 && st.verifs[0].user_id === 8
        && st.pushSubs.length === 1 && st.pushSubs[0].user_id === 8
        && st.users.get(7).pending_email === null,
      JSON.stringify(counts));
  }

  // ---- K4: survivors survive — routing identities are not ammunition ----
  {
    const st = fullState();
    await cred.burnCredentialArtifacts(makeDb(st), 7, { logger: quiet });
    const u = st.users.get(7);
    check('K4: payment_forward_token and inbound_email_alias untouched by the burn',
      u.payment_forward_token === 'fwd-SURVIVES' && u.inbound_email_alias === 'user-x@inbound.test',
      JSON.stringify({ fwd: u.payment_forward_token, alias: u.inbound_email_alias }));
  }

  // ---- K5: independence — one exploding burn never stops the rest ----
  {
    const st = fullState();
    const logs = [];
    const counts = await cred.burnCredentialArtifacts(
      makeDb(st, { failOn: 'contact_verifications' }), 7,
      { keepSid: 'sid-current', logger: { error: (...a) => logs.push(a.join(' ')), log: () => {} } }
    );
    check('K5: contact_verifications burn explodes -> null count + loud log; sessions/tokens/pending/push all still burned',
      counts.contact_verifications === null
        && counts.sessions === 2 && counts.reset_tokens === 2 && counts.push_subscriptions === 2
        && st.verifs.filter((v) => v.user_id === 7).length === 2
        && logs.some((l) => /\[kill-switch\] contact_verifications burn failed/.test(l)),
      JSON.stringify({ counts, logs }));
  }

  // ---- K6: idempotence — the second burn finds nothing, errors nothing ----
  {
    const st = fullState();
    const db = makeDb(st);
    await cred.burnCredentialArtifacts(db, 7, { logger: quiet });
    const again = await cred.burnCredentialArtifacts(db, 7, { logger: quiet });
    check('K6: second burn — all zero counts, no errors',
      again.sessions === 0 && again.reset_tokens === 0 && again.pending_email === 0
        && again.contact_verifications === 0 && again.push_subscriptions === 0,
      JSON.stringify(again));
  }

  // ---- K7: interplay with the real changePassword — idempotent overlap ----
  {
    const HASH = await bcrypt.hash('correct-horse-9', ROUNDS);
    const st = fullState();
    st.users.get(7).password_hash = HASH;
    const db = makeDb(st);
    const r = await cred.changePassword(db, 7, {
      current_password: 'correct-horse-9', new_password: 'brand-new-pw-1', confirm_password: 'brand-new-pw-1',
    }, new Map(), 1_000_000, { rounds: ROUNDS });
    const counts = await cred.burnCredentialArtifacts(db, 7, { keepSid: 'sid-current', logger: quiet });
    check('K7: changePassword clears the pending swap itself; the follow-up burn reports 0 there and burns the rest',
      r.changed === true && r.pendingCancelled === true
        && counts.pending_email === 0 && counts.reset_tokens === 2 && counts.push_subscriptions === 2,
      JSON.stringify({ pendingCancelled: r.pendingCancelled, counts }));
  }

  // ---- K8: source pins — two triggers, correct shapes, true notice ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const calls = src.split('burnCredentialArtifacts(').length - 1;
    const block = (marker) => {
      const s = src.indexOf(marker);
      return s === -1 ? null : src.slice(s, src.indexOf('\napp.', s + 10));
    };
    const changeBlock = block("app.post('/api/credentials/change-password'");
    const changeOk = changeBlock && /burnCredentialArtifacts\(pool, req\.session\.userId, \{ keepSid: req\.sessionID \}\)/.test(changeBlock);
    const resetBlock = block("app.post('/api/auth/reset-password'");
    const burnIdx = resetBlock ? resetBlock.indexOf('burnCredentialArtifacts') : -1;
    const resetOk = resetBlock
      && burnIdx !== -1
      && !/keepSid/.test(resetBlock.slice(burnIdx, burnIdx + 80))
      && resetBlock.indexOf('COMMIT') < burnIdx
      && burnIdx < resetBlock.indexOf('sendSecurityNotice')
      && resetBlock.includes('every signed-in device has been signed out');
    check('K8: exactly 2 trigger call sites; change keeps sid, reset keeps nothing; reset burns after COMMIT and before the notice; approved wording present',
      calls === 2 && Boolean(changeOk) && Boolean(resetOk),
      JSON.stringify({ calls, changeOk: Boolean(changeOk), resetOk: Boolean(resetOk) }));
  }

  // ---- K9: trigger-list completeness — a new hash site must trip this row ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'credentials.js'), 'utf8');
    const serverHashes = src.split('bcrypt.hash(').length - 1;
    const libHashes = lib.split('bcrypt.hash(').length - 1;
    check('K9: bcrypt.hash site census — 4 in server.js (seed/reset/draft/legacy signup, all mapped) + 1 in lib; a 5th server site means an unwired password write',
      serverHashes === 4 && libHashes === 1,
      JSON.stringify({ serverHashes, libHashes }));
  }

  console.log(`${pass}/${pass + fail} — kill-switch suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

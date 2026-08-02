// scripts/test-contact-verify.js — AD5 c4 suite.
//
// Drives the REAL libs (lib/contact-verify, lib/owner-alert,
// lib/contact-settings) with one fixture DB. Every ruled row is
// executed, not asserted: grandfathered delivery, unverified silence
// (emergencies included — ruling 1), guess lockout, expiry, resumed
// delivery, and the full first-set -> verify round-trip on both
// channels. Source pins cover the two places the law lives outside a
// lib (migration 059, sendNotificationEmail).
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const cv = require(path.join(__dirname, '..', 'lib', 'contact-verify'));
const { sendOwnerAlert } = require(path.join(__dirname, '..', 'lib', 'owner-alert'));
const { saveContactSettings } = require(path.join(__dirname, '..', 'lib', 'contact-settings'));

const ROUNDS = 4;
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// One fixture DB: users Map + contact_verifications array.
function makeDb(users, opts = {}) {
  const verifs = opts.verifs || [];
  let nextId = verifs.reduce((m, v) => Math.max(m, v.id), 0) + 1;
  const db = {
    verifs,
    query: async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT notification_email, notification_email_verified_at FROM users')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ notification_email: u.notification_email || null, notification_email_verified_at: u.notification_email_verified_at || null }] : [] };
      }
      if (s.startsWith('SELECT alert_phone, alert_phone_verified_at FROM users')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ alert_phone: u.alert_phone || null, alert_phone_verified_at: u.alert_phone_verified_at || null }] : [] };
      }
      if (s.startsWith('SELECT id, alert_phone, notification_email, email, notifications_enabled')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ id: params[0], ...u }] : [] };
      }
      if (s.startsWith('SELECT notification_email, alert_phone FROM users')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ notification_email: u.notification_email || null, alert_phone: u.alert_phone || null }] : [] };
      }
      if (s.startsWith('SELECT id, username, password_hash, email FROM users')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ id: params[0], username: u.username || 'u', password_hash: u.password_hash || '', email: u.email || '' }] : [] };
      }
      if (s.startsWith('DELETE FROM contact_verifications WHERE user_id')) {
        const before = verifs.length;
        for (let i = verifs.length - 1; i >= 0; i--) {
          if (verifs[i].user_id === params[0] && verifs[i].field === params[1]) verifs.splice(i, 1);
        }
        return { rowCount: before - verifs.length };
      }
      if (s.startsWith('INSERT INTO contact_verifications')) {
        verifs.push({ id: nextId++, user_id: params[0], field: params[1], target_value: params[2], code_hash: params[3], expires_at: params[4], attempts: 0 });
        return { rows: [] };
      }
      if (s.startsWith('SELECT cv.id, cv.user_id, cv.target_value, cv.expires_at, u.notification_email')) {
        const row = verifs.find((v) => v.code_hash === params[0] && v.field === 'notification_email');
        if (!row) return { rows: [] };
        const u = users.get(row.user_id);
        return { rows: [{ id: row.id, user_id: row.user_id, target_value: row.target_value, expires_at: row.expires_at, notification_email: u ? u.notification_email : null }] };
      }
      if (s.startsWith('SELECT cv.id, cv.target_value, cv.code_hash, cv.expires_at, cv.attempts, u.alert_phone')) {
        const row = verifs.find((v) => v.user_id === params[0] && v.field === 'alert_phone');
        if (!row) return { rows: [] };
        const u = users.get(params[0]);
        return { rows: [{ id: row.id, target_value: row.target_value, code_hash: row.code_hash, expires_at: row.expires_at, attempts: row.attempts, alert_phone: u ? u.alert_phone : null }] };
      }
      if (s.startsWith('UPDATE users SET notification_email_verified_at = $1')) {
        const u = users.get(params[1]);
        if (u) u.notification_email_verified_at = params[0];
        return { rows: [] };
      }
      if (s.startsWith('UPDATE users SET alert_phone_verified_at = $1')) {
        const u = users.get(params[1]);
        if (u) u.alert_phone_verified_at = params[0];
        return { rows: [] };
      }
      if (s.startsWith('UPDATE contact_verifications SET attempts')) {
        const row = verifs.find((v) => v.id === params[1]);
        if (row) row.attempts = params[0];
        return { rows: [] };
      }
      if (s.startsWith('DELETE FROM contact_verifications WHERE id')) {
        const i = verifs.findIndex((v) => v.id === params[0]);
        if (i !== -1) verifs.splice(i, 1);
        return { rowCount: i === -1 ? 0 : 1 };
      }
      if (s.startsWith('DELETE FROM contact_verifications WHERE expires_at < NOW()')) {
        const now = opts.sweepNowMs === undefined ? Date.now() : opts.sweepNowMs;
        const before = verifs.length;
        for (let i = verifs.length - 1; i >= 0; i--) {
          if (new Date(verifs[i].expires_at).getTime() < now) verifs.splice(i, 1);
        }
        return { rowCount: before - verifs.length };
      }
      if (s.startsWith('UPDATE users SET notification_email = $1')) {
        const hasPhone = s.includes('alert_phone = $3');
        const id = hasPhone ? params[3] : params[2];
        const u = users.get(id);
        if (!u) return { rows: [] };
        u.notification_email = params[0];
        u.notifications_enabled = params[1];
        if (hasPhone) u.alert_phone = params[2];
        const emailChg = hasPhone ? params[4] : params[3];
        if (emailChg) u.notification_email_verified_at = null;
        if (hasPhone && params[5]) u.alert_phone_verified_at = null;
        const row = { notification_email: u.notification_email, notifications_enabled: u.notifications_enabled };
        if (hasPhone) row.alert_phone = u.alert_phone;
        return { rows: [row] };
      }
      throw new Error('unexpected SQL: ' + s.slice(0, 70));
    },
  };
  return db;
}

function makeChannels(opts = {}) {
  const sent = [];
  return {
    sent,
    ctx: {
      db: null,
      twilio: { messages: { create: async (m) => { if (opts.smsFails) throw new Error('down'); sent.push({ channel: 'sms', to: m.to }); return {}; } } },
      sendgrid: { send: async (m) => { sent.push({ channel: 'email', to: m.to }); return {}; } },
      env: { TWILIO_PHONE_NUMBER: '+15550000000' },
      logger: { error: () => {}, log: () => {} },
    },
  };
}

const T0 = 1_754_000_000_000; // fixed clock base
const STAMP = '2026-07-01T00:00:00.000Z';

(async () => {
  const HASH = await bcrypt.hash('right-horse-4', ROUNDS);
  const mkUser = (over = {}) => ({
    username: 'jay', password_hash: HASH, email: 'acct@a.test',
    notification_email: 'n@a.test', notifications_enabled: true,
    alert_phone: '+14435550199',
    notification_email_verified_at: null, alert_phone_verified_at: null,
    ...over,
  });

  // ---- V1: grandfathered values still receive alerts ----
  {
    const users = new Map([[7, mkUser({ notification_email_verified_at: STAMP, alert_phone_verified_at: STAMP })]]);
    const fx = makeChannels();
    fx.ctx.db = makeDb(users);
    const got = await sendOwnerAlert(fx.ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: true });
    check('V1: grandfather-stamped phone receives SMS exactly as before the law',
      got === 'sms' && fx.sent[0].to === '+14435550199', JSON.stringify(fx.sent));
  }

  // ---- V2: unverified values are SILENT — emergencies included (ruling 1) ----
  {
    const users = new Map([[7, mkUser()]]); // values set, no stamps
    const fx = makeChannels();
    fx.ctx.db = makeDb(users);
    const got = await sendOwnerAlert(fx.ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: false }); // EMERGENCY path
    check('V2: unverified phone AND email skipped on the EMERGENCY path — account email carries it',
      got === 'email' && fx.sent.length === 1 && fx.sent[0].channel === 'email' && fx.sent[0].to === 'acct@a.test',
      JSON.stringify({ got, sent: fx.sent }));
  }

  // ---- V3: wrong guesses count down, then lock out even the right code ----
  {
    const users = new Map([[7, mkUser()]]);
    const db = makeDb(users);
    const req = await cv.requestPhoneVerification(db, 7, T0, { codeGen: () => '123456' });
    const msgs = [];
    for (let i = 0; i < 5; i++) {
      const r = await cv.submitPhoneCode(db, 7, '000000', T0 + (i + 1) * 1000);
      msgs.push(r.body.error);
    }
    const rightAfterLock = await cv.submitPhoneCode(db, 7, '123456', T0 + 7000);
    check('V3: five wrong guesses count down and burn the code — the RIGHT code is refused after lockout',
      req.status === 200 && req.code === '123456'
        && /4 guesses left/.test(msgs[0]) && /1 guess left/.test(msgs[3]) && /Too many wrong guesses/.test(msgs[4])
        && rightAfterLock.status === 400 && /Too many wrong guesses/.test(rightAfterLock.body.error)
        && !users.get(7).alert_phone_verified_at,
      JSON.stringify({ msgs, rightAfterLock: rightAfterLock.body }));
  }

  // ---- V4: expired codes fail ----
  {
    const users = new Map([[7, mkUser()]]);
    const db = makeDb(users);
    await cv.requestPhoneVerification(db, 7, T0, { codeGen: () => '123456' });
    const late = await cv.submitPhoneCode(db, 7, '123456', T0 + 11 * 60 * 1000);
    check('V4: the RIGHT code after 11 minutes -> expired, nothing stamped',
      late.status === 400 && /expired/.test(late.body.error) && !users.get(7).alert_phone_verified_at,
      JSON.stringify(late.body));
  }

  // ---- V5: verification resumes delivery ----
  {
    const users = new Map([[7, mkUser()]]);
    const db = makeDb(users);
    await cv.requestPhoneVerification(db, 7, T0, { codeGen: () => '654321' });
    const ok = await cv.submitPhoneCode(db, 7, '654321', T0 + 60 * 1000);
    const fx = makeChannels();
    fx.ctx.db = db;
    const got = await sendOwnerAlert(fx.ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: false });
    check('V5: verified phone resumes SMS delivery; artifact deleted (single-use)',
      ok.status === 200 && got === 'sms' && db.verifs.length === 0,
      JSON.stringify({ ok: ok.body, got, verifs: db.verifs.length }));
  }

  // ---- V6: the full first-set -> verify round-trip, BOTH channels ----
  {
    const users = new Map([[7, mkUser({ notification_email: null, alert_phone: null, email: 'acct@a.test' })]]);
    const db = makeDb(users);
    // first-set needs no password (AD4) and starts unverified (AD5)
    const saved = await saveContactSettings(db, 7, {
      notification_email: 'fresh@a.test', notifications_enabled: true, alert_phone: '(443) 555-0199',
    }, new Map());
    const fx1 = makeChannels();
    fx1.ctx.db = db;
    const before = await sendOwnerAlert(fx1.ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: false });
    // email channel: link round-trip
    const eReq = await cv.requestEmailVerification(db, 7, T0);
    const eVer = await cv.verifyEmailToken(db, eReq.token, T0 + 5 * 60 * 1000);
    // phone channel: spoken-code round-trip
    const pReq = await cv.requestPhoneVerification(db, 7, T0 + 6 * 60 * 1000, { codeGen: () => '246810' });
    const pVer = await cv.submitPhoneCode(db, 7, '246810', T0 + 7 * 60 * 1000);
    const fx2 = makeChannels();
    fx2.ctx.db = db;
    const after = await sendOwnerAlert(fx2.ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: false });
    check('V6: first-set silent (account-email fallback) -> both channels verified -> SMS delivery live',
      saved.status === 200 && before === 'email' && fx1.sent[0].to === 'acct@a.test'
        && eVer.ok === true && Boolean(users.get(7).notification_email_verified_at)
        && pVer.status === 200 && Boolean(users.get(7).alert_phone_verified_at)
        && after === 'sms',
      JSON.stringify({ before, eVer, pVer: pVer.body, after }));
  }

  // ---- V7: value changed after the link was sent -> link dies ----
  {
    const users = new Map([[7, mkUser({ alert_phone: null })]]);
    const db = makeDb(users);
    const req = await cv.requestEmailVerification(db, 7, T0);
    const changed = await saveContactSettings(db, 7, {
      notification_email: 'other@b.test', notifications_enabled: true, current_password: 'right-horse-4',
    }, new Map());
    const ver = await cv.verifyEmailToken(db, req.token, T0 + 60 * 1000);
    check('V7: mid-flight value change kills the old link; nothing stamped; artifact deleted',
      changed.status === 200 && ver.ok === false && ver.reason === 'value_changed'
        && !users.get(7).notification_email_verified_at && db.verifs.length === 0,
      JSON.stringify(ver));
  }

  // ---- V8: replace-don't-stack — a new request kills the old token ----
  {
    const users = new Map([[7, mkUser({ alert_phone: null })]]);
    const db = makeDb(users);
    const req1 = await cv.requestEmailVerification(db, 7, T0);
    const req2 = await cv.requestEmailVerification(db, 7, T0 + 1000);
    const oldTry = await cv.verifyEmailToken(db, req1.token, T0 + 2000);
    const newTry = await cv.verifyEmailToken(db, req2.token, T0 + 3000);
    check('V8: one active row per field — the earlier token is dead, the fresh one verifies',
      oldTry.ok === false && newTry.ok === true && db.verifs.length === 0,
      JSON.stringify({ oldTry, newTry }));
  }

  // ---- V9: changing a value resets ITS trust only ----
  {
    const users = new Map([[7, mkUser({ notification_email_verified_at: STAMP, alert_phone_verified_at: STAMP })]]);
    const db = makeDb(users);
    const r = await saveContactSettings(db, 7, {
      notification_email: 'n@a.test', notifications_enabled: true,
      alert_phone: '(410) 555-0100', current_password: 'right-horse-4',
    }, new Map());
    const u = users.get(7);
    check('V9: phone change clears ONLY the phone stamp; unchanged email keeps its trust',
      r.status === 200 && u.alert_phone_verified_at === null && u.notification_email_verified_at === STAMP,
      JSON.stringify({ phone: u.alert_phone_verified_at, email: u.notification_email_verified_at }));
  }

  // ---- V10: the sweep clears only expired artifacts ----
  {
    const users = new Map([[7, mkUser()]]);
    const db = makeDb(users, {
      sweepNowMs: T0,
      verifs: [
        { id: 1, user_id: 7, field: 'alert_phone', target_value: '+14435550199', code_hash: 'x', expires_at: new Date(T0 - 1000).toISOString(), attempts: 0 },
        { id: 2, user_id: 7, field: 'notification_email', target_value: 'n@a.test', code_hash: 'y', expires_at: new Date(T0 + 60_000).toISOString(), attempts: 0 },
      ],
    });
    const n = await cv.sweepExpiredContactVerifications(db);
    check('V10: sweep deletes the expired artifact, keeps the live one, value untouched',
      n === 1 && db.verifs.length === 1 && db.verifs[0].id === 2 && users.get(7).alert_phone === '+14435550199',
      JSON.stringify({ n, left: db.verifs }));
  }

  // ---- V11: source pins — migration grandfathering + notice gating ----
  {
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '059_contact_verification.sql'), 'utf8');
    const migOk = (mig.match(/ADD COLUMN IF NOT EXISTS \w+_verified_at/g) || []).length === 2
      && /UPDATE users SET notification_email_verified_at = NOW\(\)/.test(mig)
      && /UPDATE users SET alert_phone_verified_at = NOW\(\)/.test(mig)
      && mig.includes('CREATE TABLE IF NOT EXISTS contact_verifications');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fnStart = src.indexOf('async function sendNotificationEmail');
    const fnBlock = src.slice(fnStart, fnStart + 1500);
    const noticeGated = fnBlock.includes('notification_email_verified_at')
      && fnBlock.includes('user.notification_email_verified_at ? user.notification_email : null');
    check('V11: migration 059 additive + grandfathers both fields; sendNotificationEmail gated on verified',
      migOk && noticeGated, JSON.stringify({ migOk, noticeGated }));
  }

  // ---- V12: the spoken TwiML — digits spaced, repeated, XML-sane ----
  {
    const twiml = cv.buildCodeTwiml('123456');
    const spacedCount = twiml.split('1. 2. 3. 4. 5. 6.').length - 1;
    check('V12: TwiML speaks the code digit-by-digit and repeats it; digits-only payload',
      spacedCount === 2 && twiml.startsWith('<Response>') && twiml.endsWith('</Response>')
        && !/[<>&]/.test('123456'),
      twiml);
  }

  console.log(`${pass}/${pass + fail} — contact-verify suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

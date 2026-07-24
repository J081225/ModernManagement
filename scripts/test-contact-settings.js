// scripts/test-contact-settings.js — AD2 c4 suite.
//
// Drives the REAL libs with fixtures: lib/contact-settings (the one
// settings save path), lib/owner-alert (the routing chain — proving
// AD2 changed its UI, not its behavior), and the test-alert limiter.
// Plus a source pin: the business-phone display source stays the
// WORKSPACE copy (the c2 drift finding must not silently regress).
const path = require('path');
const fs = require('fs');
const { saveContactSettings, testAlertGate } = require(path.join(__dirname, '..', 'lib', 'contact-settings'));
const { sendOwnerAlert } = require(path.join(__dirname, '..', 'lib', 'owner-alert'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// Fixture DB: a users table as a Map, answering exactly the SQL shapes
// the two libs issue.
function makeDb(users) {
  return {
    query: async (sql, params) => {
      if (sql.includes('UPDATE users')) {
        const id = params[params.length - 1];
        const u = users.get(id);
        if (!u) return { rows: [] };
        u.notification_email = params[0];
        u.notifications_enabled = params[1];
        if (sql.includes('alert_phone = $3')) u.alert_phone = params[2];
        const row = { notification_email: u.notification_email, notifications_enabled: u.notifications_enabled };
        if (sql.includes('alert_phone = $3')) row.alert_phone = u.alert_phone;
        return { rows: [row] };
      }
      if (sql.includes('SELECT id, alert_phone, notification_email, email, notifications_enabled')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ id: params[0], ...u }] : [] };
      }
      throw new Error('unexpected SQL: ' + sql.slice(0, 60));
    },
  };
}

// Fixture channels for owner-alert: record what would have gone out.
function makeChannels(opts = {}) {
  const sent = [];
  const twilio = {
    messages: {
      create: async (msg) => {
        if (opts.smsFails) throw new Error('twilio down (fixture)');
        sent.push({ channel: 'sms', to: msg.to });
        return { sid: 'SM_fixture' };
      },
    },
  };
  const sendgrid = {
    send: async (msg) => {
      sent.push({ channel: 'email', to: msg.to });
      return [{ statusCode: 202 }];
    },
  };
  const quiet = { error: () => {}, log: () => {} };
  return { sent, ctx: { db: null, twilio, sendgrid, env: { TWILIO_PHONE_NUMBER: '+15550000000' }, logger: quiet } };
}

(async () => {
  // ---- CS1: round-trip — save then read back, phone stored E.164 ----
  {
    const users = new Map([[7, { notification_email: null, notifications_enabled: true, alert_phone: null, email: 'acct@a.test' }]]);
    const db = makeDb(users);
    const r = await saveContactSettings(db, 7, {
      notification_email: '  owner@a.test  ',
      notifications_enabled: true,
      alert_phone: '(443) 555-0199',
    });
    check('CS1: round-trip — trimmed email + E.164 phone come back from the row',
      r.status === 200 && r.body.notification_email === 'owner@a.test' && r.body.alert_phone === '+14435550199'
        && users.get(7).alert_phone === '+14435550199',
      JSON.stringify(r));
  }

  // ---- CS2: phone input formats all normalize to one E.164 ----
  {
    const forms = ['4435550199', '443-555-0199', '(443) 555 0199', '+1 443 555 0199', '1 (443) 555-0199'];
    let allSame = true;
    for (const f of forms) {
      const users = new Map([[7, { notifications_enabled: true }]]);
      const r = await saveContactSettings(makeDb(users), 7, { alert_phone: f });
      if (r.status !== 200 || r.body.alert_phone !== '+14435550199') { allSame = false; break; }
    }
    check('CS2: five input formats -> one stored E.164', allSame);
  }

  // ---- CS3/CS4: malformed inputs rejected server-side, field-tagged ----
  {
    const r = await saveContactSettings(makeDb(new Map()), 7, { notification_email: 'not-an-email' });
    check('CS3: malformed email -> 400 with field notification_email',
      r.status === 400 && r.body.field === 'notification_email', JSON.stringify(r));
    const r2 = await saveContactSettings(makeDb(new Map()), 7, { alert_phone: '555-0199' });
    check('CS4: short phone -> 400 with field alert_phone',
      r2.status === 400 && r2.body.field === 'alert_phone', JSON.stringify(r2));
  }

  // ---- CS5: length caps ----
  {
    const longEmail = 'a'.repeat(250) + '@b.com'; // 256 chars
    const r = await saveContactSettings(makeDb(new Map()), 7, { notification_email: longEmail });
    const r2 = await saveContactSettings(makeDb(new Map()), 7, { alert_phone: '9'.repeat(33) });
    check('CS5: oversize email and phone both rejected',
      r.status === 400 && r.body.field === 'notification_email'
        && r2.status === 400 && r2.body.field === 'alert_phone');
  }

  // ---- CS6: clearing stores NULL, never '' ----
  {
    const users = new Map([[7, { notification_email: 'old@a.test', notifications_enabled: true, alert_phone: '+14435550199' }]]);
    const r = await saveContactSettings(makeDb(users), 7, { notification_email: '', notifications_enabled: true, alert_phone: '' });
    const u = users.get(7);
    check('CS6: cleared fields stored as NULL (not empty string)',
      r.status === 200 && u.notification_email === null && u.alert_phone === null
        && u.notification_email !== '' && u.alert_phone !== '', JSON.stringify(u));
  }

  // ---- CS7: onboarding contract — no alert_phone key, phone untouched ----
  {
    const users = new Map([[7, { notification_email: null, notifications_enabled: true, alert_phone: '+14435550199' }]]);
    const r = await saveContactSettings(makeDb(users), 7, { notification_email: 'on@board.test', notifications_enabled: true });
    check('CS7: body without alert_phone key never clobbers the stored phone',
      r.status === 200 && users.get(7).alert_phone === '+14435550199'
        && !('alert_phone' in r.body), JSON.stringify(r));
  }

  // ---- CS8: the owner-alert chain with a CLEARED (NULL) fixture ----
  // behavior must be identical to pre-AD2 ('' era): fall through to
  // the account email.
  {
    const users = new Map([[7, { alert_phone: null, notification_email: null, email: 'acct@a.test', notifications_enabled: true }]]);
    const { sent, ctx } = makeChannels();
    ctx.db = makeDb(users);
    const got = await sendOwnerAlert(ctx, 7, { smsBody: 'x', emailSubject: 's', emailText: 't', respectEnabled: false });
    check('CS8: NULL phone + NULL notif email -> account-email fallback fires',
      got === 'email' && sent.length === 1 && sent[0].to === 'acct@a.test', JSON.stringify(sent));
  }

  // ---- CS9: '' vs NULL — byte-identical chain behavior ----
  {
    const outcomes = [];
    for (const val of ['', null]) {
      const users = new Map([[7, { alert_phone: val, notification_email: val, email: 'acct@a.test', notifications_enabled: true }]]);
      const { sent, ctx } = makeChannels();
      ctx.db = makeDb(users);
      const got = await sendOwnerAlert(ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: true });
      outcomes.push(JSON.stringify({ got, sent }));
    }
    check("CS9: '' and NULL settings produce identical routing outcomes", outcomes[0] === outcomes[1], outcomes.join(' vs '));
  }

  // ---- CS10: phone-first, email on SMS failure — chain order intact ----
  {
    const users = new Map([[7, { alert_phone: '+14435550199', notification_email: 'n@a.test', email: 'acct@a.test', notifications_enabled: true }]]);
    const { sent, ctx } = makeChannels();
    ctx.db = makeDb(users);
    const got = await sendOwnerAlert(ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: false });
    const c1 = got === 'sms' && sent[0].channel === 'sms' && sent[0].to === '+14435550199';
    const fx2 = makeChannels({ smsFails: true });
    fx2.ctx.db = makeDb(new Map([[7, { alert_phone: '+14435550199', notification_email: 'n@a.test', email: 'acct@a.test', notifications_enabled: true }]]));
    const got2 = await sendOwnerAlert(fx2.ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: false });
    const c2 = got2 === 'email' && fx2.sent[0].to === 'n@a.test';
    check('CS10: phone first; SMS failure falls back to notification email', c1 && c2, JSON.stringify({ got, got2 }));
  }

  // ---- CS11: the toggle truth — respectEnabled honored, emergencies not silenced ----
  {
    const mk = () => new Map([[7, { alert_phone: '+14435550199', notification_email: 'n@a.test', email: 'acct@a.test', notifications_enabled: false }]]);
    const a = makeChannels(); a.ctx.db = makeDb(mk());
    const gotRespect = await sendOwnerAlert(a.ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: true });
    const b = makeChannels(); b.ctx.db = makeDb(mk());
    const gotEmergency = await sendOwnerAlert(b.ctx, 7, { smsBody: 'x', emailSubject: 's', respectEnabled: false });
    check('CS11: notifications off silences pings (null) but never emergencies (sms)',
      gotRespect === null && a.sent.length === 0 && gotEmergency === 'sms', JSON.stringify({ gotRespect, gotEmergency }));
  }

  // ---- CS12: test-alert rate limit — second call inside the window -> blocked ----
  {
    const map = new Map();
    const t0 = 1_000_000;
    const first = testAlertGate(map, 7, t0);
    const second = testAlertGate(map, 7, t0 + 30 * 1000);
    const otherUser = testAlertGate(map, 8, t0 + 30 * 1000);
    const later = testAlertGate(map, 7, t0 + 61 * 1000);
    check('CS12: 1st allowed; 2nd at +30s blocked with 30s honesty; other user unaffected; +61s allowed',
      first.allowed && !second.allowed && second.retryAfterSeconds === 30
        && otherUser.allowed && later.allowed, JSON.stringify({ first, second, otherUser, later }));
  }

  // ---- CS13: isolation — A's save never touches B ----
  {
    const users = new Map([
      [7, { notification_email: 'a@a.test', notifications_enabled: true, alert_phone: '+14435550100' }],
      [8, { notification_email: 'b@b.test', notifications_enabled: true, alert_phone: '+14435550200' }],
    ]);
    const before = JSON.stringify(users.get(8));
    await saveContactSettings(makeDb(users), 7, { notification_email: 'new@a.test', notifications_enabled: false, alert_phone: '' });
    check("CS13: user A's save leaves user B's row byte-identical", JSON.stringify(users.get(8)) === before);
  }

  // ---- CS14: the drift pin — display source stays the WORKSPACE copy ----
  // c2 found users.twilio_phone_number stale (dev ws 17: NULL while the
  // workspace holds the live number). Pin GET /api/settings to the
  // workspace copy so a refactor can't silently flip it back.
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const getStart = src.indexOf("app.get('/api/settings'");
    const getEnd = src.indexOf("app.put('/api/settings'", getStart);
    const block = src.slice(getStart, getEnd);
    const readsWorkspace = /SELECT twilio_phone_number FROM workspaces/.test(block) && block.includes('business_phone');
    const usersSelect = block.match(/SELECT[^']*FROM users/);
    const usersCopyGone = usersSelect && !usersSelect[0].includes('twilio_phone_number');
    check('CS14: GET /api/settings sources business_phone from workspaces; users copy not selected',
      Boolean(getStart !== -1 && readsWorkspace && usersCopyGone),
      JSON.stringify({ readsWorkspace, usersSelect: usersSelect && usersSelect[0].slice(0, 80) }));
  }

  console.log(`${pass}/${pass + fail} — contact-settings suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

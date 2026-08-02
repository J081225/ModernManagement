// scripts/test-security-notices.js — AD6 c3 suite.
//
// Drives the notice machinery (lib/credentials.maskPhone +
// sendSecurityNotice, lib/contact-settings.buildContactChangeNotices
// + the changes report) with fixtures, and pins the two adapter
// hookpoints plus the zero-lines clause on the AD3 events.
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const cred = require(path.join(__dirname, '..', 'lib', 'credentials'));
const { saveContactSettings, buildContactChangeNotices } = require(path.join(__dirname, '..', 'lib', 'contact-settings'));

const ROUNDS = 4;
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

function makeDb(users) {
  return {
    query: async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT notification_email, alert_phone FROM users')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ notification_email: u.notification_email || null, alert_phone: u.alert_phone || null }] : [] };
      }
      if (s.startsWith('SELECT id, username, password_hash, email FROM users')) {
        const u = users.get(params[0]);
        return { rows: u ? [{ id: params[0], username: u.username || 'u', password_hash: u.password_hash || '', email: u.email || '' }] : [] };
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
}

function makeMail(opts = {}) {
  const sent = [];
  const logs = [];
  return {
    sent,
    logs,
    sendgrid: { send: async (m) => { if (opts.fails) throw new Error('sendgrid down (fixture)'); sent.push(m); return {}; } },
    logger: { error: (...a) => logs.push(a.join(' ')), log: () => {} },
  };
}

const BASE = 'https://example.test';

(async () => {
  const HASH = await bcrypt.hash('right-horse-4', ROUNDS);

  // ---- S1: maskPhone — the AD3 masking rule's sibling ----
  {
    check('S1: maskPhone — (443) ***-**99 for E.164; last-2 for odd shapes; empty stays empty',
      cred.maskPhone('+14435550199') === '(443) ***-**99'
        && cred.maskPhone('5550199') === '***99'
        && cred.maskPhone('') === '',
      cred.maskPhone('+14435550199'));
  }

  // ---- S2: the sender — delivers, skips loudly, fails soft, never consults the toggle ----
  {
    const m1 = makeMail();
    const ok = await cred.sendSecurityNotice({ sendgrid: m1.sendgrid, env: { SENDGRID_FROM_EMAIL: 'ops@x.test' }, logger: m1.logger }, 'to@a.test', { subject: 'S', text: 'T' });
    const m2 = makeMail();
    const skipped = await cred.sendSecurityNotice({ sendgrid: m2.sendgrid, env: {}, logger: m2.logger }, '  ', { subject: 'S2', text: 'T' });
    const m3 = makeMail({ fails: true });
    const failed = await cred.sendSecurityNotice({ sendgrid: m3.sendgrid, env: {}, logger: m3.logger }, 'to@a.test', { subject: 'S3', text: 'T' });
    check('S2: sender delivers on the account-mail identity; empty recipient -> loud skip, no send; sendgrid failure -> soft null, loud log',
      ok === 'sent' && m1.sent.length === 1 && m1.sent[0].from.email === 'noreply@modernmanagementapp.com'
        && skipped === null && m2.sent.length === 0 && m2.logs.some((l) => /notice skipped/.test(l))
        && failed === null && m3.logs.some((l) => /send failed/.test(l)),
      JSON.stringify({ ok, skipped, failed, logs2: m2.logs, logs3: m3.logs }));
  }

  // ---- S3: email set->set — retiring address + distinct anchor, masked target ----
  {
    const notices = buildContactChangeNotices({
      changes: { emailChanged: true, phoneChanged: false, oldEmail: 'old@a.test', newEmail: 'new@b.test' },
      anchorEmail: 'anchor@c.test',
      publicBaseUrl: BASE,
    });
    check('S3: email change -> exactly 2 notices (old + distinct anchor); masked target; reset line; no revert mechanism',
      notices.length === 2
        && notices[0].to === 'old@a.test' && notices[1].to === 'anchor@c.test'
        && notices.every((n) => n.text.includes('n***@b***.test'))
        && notices.every((n) => n.text.includes(BASE + '/forgot-password'))
        && notices.every((n) => !/revert|undo|click here to restore/i.test(n.text)),
      JSON.stringify(notices));
  }

  // ---- S4: old === anchor (case-flipped) -> deduped to ONE notice ----
  {
    const notices = buildContactChangeNotices({
      changes: { emailChanged: true, phoneChanged: false, oldEmail: 'Same@a.test', newEmail: 'new@b.test' },
      anchorEmail: 'same@a.test',
      publicBaseUrl: BASE,
    });
    check('S4: retiring address == anchor (case-insensitive) -> exactly one notice',
      notices.length === 1 && notices[0].to === 'Same@a.test', JSON.stringify(notices));
  }

  // ---- S5: first-set email -> exactly one notice, to the anchor ----
  {
    const notices = buildContactChangeNotices({
      changes: { emailChanged: true, phoneChanged: false, oldEmail: null, newEmail: 'fresh@b.test' },
      anchorEmail: 'anchor@c.test',
      publicBaseUrl: BASE,
    });
    check('S5: FIRST-SET fires (ruling 1 — the self-verify takeover is loud): one notice to the anchor, "once it\'s verified"',
      notices.length === 1 && notices[0].to === 'anchor@c.test'
        && /just added/.test(notices[0].text) && /once it's verified/.test(notices[0].text),
      JSON.stringify(notices));
  }

  // ---- S6: clear email -> old + anchor told the honest fallback truth ----
  {
    const notices = buildContactChangeNotices({
      changes: { emailChanged: true, phoneChanged: false, oldEmail: 'old@a.test', newEmail: null },
      anchorEmail: 'anchor@c.test',
      publicBaseUrl: BASE,
    });
    check('S6: CLEAR fires: retiring + anchor, text states the account-email fallback truth',
      notices.length === 2 && /removed/.test(notices[0].text) && /fall back to your account email/.test(notices[0].text),
      JSON.stringify(notices));
  }

  // ---- S7: phone change/first-set/clear -> one anchor notice, masked ----
  {
    const changed = buildContactChangeNotices({
      changes: { emailChanged: false, phoneChanged: true, oldPhone: '+14435550100', newPhone: '+14435550199' },
      anchorEmail: 'anchor@c.test', publicBaseUrl: BASE,
    });
    const firstSet = buildContactChangeNotices({
      changes: { emailChanged: false, phoneChanged: true, oldPhone: null, newPhone: '+14435550199' },
      anchorEmail: 'anchor@c.test', publicBaseUrl: BASE,
    });
    const cleared = buildContactChangeNotices({
      changes: { emailChanged: false, phoneChanged: true, oldPhone: '+14435550199', newPhone: null },
      anchorEmail: 'anchor@c.test', publicBaseUrl: BASE,
    });
    check('S7: phone edit/first-set/clear each -> exactly one anchor notice; number rendered MASKED only',
      changed.length === 1 && changed[0].to === 'anchor@c.test'
        && changed[0].text.includes('(443) ***-**99') && !changed[0].text.includes('+14435550199')
        && firstSet.length === 1 && /just added/.test(firstSet[0].text)
        && cleared.length === 1 && /removed/.test(cleared[0].text),
      JSON.stringify({ changed, firstSet, cleared }));
  }

  // ---- S8: phone recipient fallback chain; both-empty reaches the loud skip ----
  {
    const viaFallback = buildContactChangeNotices({
      changes: { emailChanged: false, phoneChanged: true, oldPhone: null, newPhone: '+14435550199', fallbackEmail: 'verified@n.test' },
      anchorEmail: '', publicBaseUrl: BASE,
    });
    const nowhere = buildContactChangeNotices({
      changes: { emailChanged: false, phoneChanged: true, oldPhone: null, newPhone: '+14435550199', fallbackEmail: null },
      anchorEmail: '', publicBaseUrl: BASE,
    });
    const m = makeMail();
    const skipResult = await cred.sendSecurityNotice({ sendgrid: m.sendgrid, env: {}, logger: m.logger }, nowhere[0].to, nowhere[0]);
    check('S8: empty anchor -> verified notification email carries the phone notice; nothing reachable -> loud skip, change unblocked',
      viaFallback[0].to === 'verified@n.test'
        && nowhere.length === 1 && nowhere[0].to === ''
        && skipResult === null && m.sent.length === 0 && m.logs.some((l) => /notice skipped/.test(l)),
      JSON.stringify({ viaFallback, nowhere, logs: m.logs }));
  }

  // ---- S9: both fields in one save -> exactly two notices, one per field ----
  {
    const notices = buildContactChangeNotices({
      changes: { emailChanged: true, phoneChanged: true, oldEmail: 'anchor@c.test', newEmail: 'new@b.test', oldPhone: null, newPhone: '+14435550199' },
      anchorEmail: 'anchor@c.test', publicBaseUrl: BASE,
    });
    const subjects = notices.map((n) => n.subject);
    check('S9: a save changing both fields -> exactly 2 notices, one per field',
      notices.length === 2 && new Set(subjects).size === 2, JSON.stringify(subjects));
  }

  // ---- S10: the changes report from the REAL save path ----
  {
    const users = new Map([[7, { notifications_enabled: true, email: 'acct@a.test', password_hash: HASH }]]);
    const db = makeDb(users);
    const first = await saveContactSettings(db, 7, {
      notification_email: 'n@a.test', notifications_enabled: true, alert_phone: '(443) 555-0199',
    }, new Map());
    const toggle = await saveContactSettings(db, 7, {
      notification_email: 'n@a.test', notifications_enabled: false, alert_phone: '443-555-0199',
    }, new Map());
    const clear = await saveContactSettings(db, 7, {
      notification_email: '', notifications_enabled: false, alert_phone: '', current_password: 'right-horse-4',
    }, new Map());
    check('S10: save reports first-set (old null), toggle-only (nothing changed -> NO notice case), and clear (old values reported)',
      first.changes.emailChanged === true && first.changes.oldEmail === null && first.changes.newPhone === '+14435550199'
        && toggle.changes.emailChanged === false && toggle.changes.phoneChanged === false
        && clear.changes.emailChanged === true && clear.changes.oldEmail === 'n@a.test'
        && clear.changes.phoneChanged === true && clear.changes.oldPhone === '+14435550199' && clear.changes.newPhone === null,
      JSON.stringify({ first: first.changes, toggle: toggle.changes, clear: clear.changes }));
  }

  // ---- S11: source pins — hookpoints in, AD3 events untouched, toggle never consulted ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const block = (marker) => {
      const s = src.indexOf(marker);
      return s === -1 ? null : src.slice(s, src.indexOf('\napp.', s + 10));
    };
    const resetBlock = block("app.post('/api/auth/reset-password'");
    const resetOk = resetBlock
      && resetBlock.indexOf('COMMIT') < resetBlock.indexOf('sendSecurityNotice')
      && resetBlock.includes('Your Modern Management password was reset');
    const putBlock = block("app.put('/api/settings'");
    const putOk = putBlock && putBlock.includes('buildContactChangeNotices') && putBlock.includes('sendSecurityNotice');
    const ad3Clean = ["app.post('/api/credentials/change-password'", "app.post('/api/credentials/change-username'", "app.post('/api/credentials/request-email-change'", "app.post('/api/credentials/cancel-email-change'"]
      .every((m) => { const b = block(m); return b && !b.includes('sendSecurityNotice') && !b.includes('buildContactChangeNotices'); });
    const ad3Subjects = ['Your Modern Management password was changed', 'Your Modern Management username was changed', 'Security notice: email change requested']
      .every((subj) => src.split(subj).length - 1 === 1);
    const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'credentials.js'), 'utf8');
    const senderStart = lib.indexOf('async function sendSecurityNotice');
    const senderCode = lib.slice(senderStart, lib.indexOf('\nfunction', senderStart + 10))
      .split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
    const noToggle = !senderCode.includes('notifications_enabled');
    check('S11: reset notice sits after COMMIT; PUT adapter wired; the four AD3 endpoints untouched (subjects intact, no new senders); the sender CODE never consults notifications_enabled',
      Boolean(resetOk && putOk && ad3Clean && ad3Subjects && noToggle),
      JSON.stringify({ resetOk: Boolean(resetOk), putOk: Boolean(putOk), ad3Clean, ad3Subjects, noToggle }));
  }

  console.log(`${pass}/${pass + fail} — security-notices suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

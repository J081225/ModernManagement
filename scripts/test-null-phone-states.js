// scripts/test-null-phone-states.js — SP2 suite.
//
// Honest NULL-phone states everywhere a workspace phone renders: the
// welcome-email builders are driven directly (pure functions, all four
// paths); the signup-success screen and the AD2 business-identity card
// are source-pinned (inline page JS). Plus the SP4 debt pin: the four
// send paths that fall back to the platform number are INVENTORIED —
// a fifth appearing untracked trips a row.
const path = require('path');
const fs = require('fs');
const { welcomeEmailHtml, welcomeEmailText } = require(path.join(__dirname, '..', 'lib', 'signup-orchestrator'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const ARGS = { businessName: 'Snip', username: 'snip', plan: 'starter', billing: 'monthly', baseUrl: 'https://x.test' };
const PHONE = '+14435550100';

(async () => {
  // ---- NP1: all four builder paths render the number when present ----
  {
    let ok = true, details = [];
    for (const vertical of ['property-management', 'professional-services']) {
      const h = welcomeEmailHtml({ ...ARGS, vertical, twilioPhone: PHONE });
      const t = welcomeEmailText({ ...ARGS, vertical, twilioPhone: PHONE });
      if (!h.includes(PHONE) || !t.includes(PHONE)) { ok = false; details.push(vertical + ':missing'); }
      if (h.includes('Being set up') || t.includes('Being set up')) { ok = false; details.push(vertical + ':pending-copy-leaked'); }
      if (!/Share this number/.test(h) || !/Share this number/.test(t)) { ok = false; details.push(vertical + ':share-line-missing'); }
    }
    check('NP1: with a number, all four welcome paths render it + the share line; no pending copy leaks', ok, details.join(','));
  }

  // ---- NP2: all four builder paths render the STATE when the phone is null ----
  {
    let ok = true, details = [];
    for (const vertical of ['property-management', 'professional-services']) {
      for (const phone of [null, undefined, '']) {
        const h = welcomeEmailHtml({ ...ARGS, vertical, twilioPhone: phone });
        const t = welcomeEmailText({ ...ARGS, vertical, twilioPhone: phone });
        if (!h.includes('Being set up') || !t.includes('Being set up')) { ok = false; details.push(vertical + ':no-state'); }
        if (/\bnull\b|\bundefined\b/.test(t)) { ok = false; details.push(vertical + ':leak'); }
        if (/>null<|>undefined</.test(h)) { ok = false; details.push(vertical + ':html-leak'); }
        if (/Share this number/.test(h) || /Share this number/.test(t)) { ok = false; details.push(vertical + ':empty-promise'); }
        if (!/still being provisioned/.test(t)) { ok = false; details.push(vertical + ':no-honest-help'); }
      }
    }
    check('NP2: without a number, all four paths render "Being set up" + honest help; never null/undefined; never a share-this-number promise with nothing to share', ok, details.join(','));
  }

  // ---- NP3: source-pin — the signup-success lie is dead ----
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'signup-success.html'), 'utf8');
    const lieGone = !html.includes("|| '(provisioned)'");
    const branch = /if \(ws\.twilio_phone_number\) \{/.test(html);
    const stateCopy = html.includes("phoneEl.textContent = 'Being set up'");
    const honestHelp = html.includes('still being provisioned') && html.includes('you can sign in now');
    check("NP3: signup-success — the || '(provisioned)' fallback is GONE; success branches on the phone and renders a Being-set-up state with honest help",
      lieGone && branch && stateCopy && honestHelp, JSON.stringify({ lieGone, branch, stateCopy, honestHelp }));
  }

  // ---- NP4: regression pin — the AD2 business-identity card stays honest ----
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const nullState = app.includes("bizPhone.textContent = 'Not set up yet'");
    const banner = app.includes('bizNoPhoneBanner') && app.includes("isn't set up yet");
    const noCopyBtn = /Not set up yet[\s\S]{0,200}copyBtn\.style\.display = 'none'/.test(app);
    check('NP4: the AD2 card still renders NULL as "Not set up yet" + warning banner, copy button hidden (regression pin on the already-honest surface)',
      nullState && banner && noCopyBtn, JSON.stringify({ nullState, banner, noCopyBtn }));
  }

  // ---- NP5: the SP4 debt pin — exactly 4 platform-number fallbacks ----
  {
    const files = {
      'server.js': fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'),
      'lib/appointment-engine.js': fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8'),
      'lib/payment-requests.js': fs.readFileSync(path.join(__dirname, '..', 'lib', 'payment-requests.js'), 'utf8'),
      'lib/receipts.js': fs.readFileSync(path.join(__dirname, '..', 'lib', 'receipts.js'), 'utf8'),
    };
    let count = 0;
    for (const src of Object.values(files)) {
      count += (src.match(/twilio_phone_number \|\| (process\.env\.|env\.)TWILIO_PHONE_NUMBER/g) || []).length;
    }
    check('NP5: exactly 4 send paths fall back to the PLATFORM number (inventoried SP4 debt — hold-vs-fallback is SP4\'s ruling); a 5th appearing untracked fails this row',
      count === 4, 'count=' + count);
  }

  console.log(`${pass}/${pass + fail} — null-phone-states suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

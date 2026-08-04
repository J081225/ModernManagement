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

  // ---- NP4 [evolved]: the AD2 card is honest AND now state-specific ----
  // SP2 pinned the generic "Not set up yet". SP4b made the card say
  // WHICH not-set-up state it is ("Being set up" vs "Setup failed",
  // with the retry offered only when there's something to retry) —
  // strictly more honest, so the pin follows the improvement rather
  // than freezing the older, vaguer copy.
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
    const stateSpecific = app.includes("st === 'failed' ? 'Setup failed' : 'Being set up'");
    const banner = app.includes('bizNoPhoneBanner') && app.includes('bizNoPhoneText');
    const noCopyBtn = /'Setup failed' : 'Being set up'[\s\S]{0,240}copyBtn\.style\.display = 'none'/.test(app);
    const retryOnlyWhenFailed = /retryBtn\.style\.display = st === 'failed' \? '' : 'none'/.test(app);
    check('NP4 [evolved]: the AD2 card renders the SPECIFIC no-phone state (Being set up / Setup failed) with the banner, the copy button hidden, and the retry offered only when failed',
      stateSpecific && banner && noCopyBtn && retryOnlyWhenFailed,
      JSON.stringify({ stateSpecific, banner, noCopyBtn, retryOnlyWhenFailed }));
  }

  // ---- NP5 [EVOLVED]: the fallback is RETIRED, so the pin asserts ZERO ----
  // SP2 inventoried four platform-number fallbacks as SP4 debt. SP4b's
  // ruling retired them: customer sends leave from the workspace's own
  // number or HOLD. The census now guards the retirement — a
  // reintroduced fallback fails this row.
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
    const viaHelper = ['lib/appointment-engine.js', 'lib/payment-requests.js', 'lib/receipts.js']
      .every((f) => files[f].includes('customerSmsFrom'))
      && files['server.js'].includes('customerSmsFrom(ws)');
    check('NP5 [evolved]: ZERO customer-facing platform-number fallbacks remain (the SP4b retirement) and all four sites route through customerSmsFrom',
      count === 0 && viaHelper, JSON.stringify({ count, viaHelper }));
  }

  console.log(`${pass}/${pass + fail} — null-phone-states suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

// scripts/test-settings-claims.js — ST2 gate.
//
// The claims census: every DIRECTIONAL claim in outbound copy (welcome
// emails, owner tasks) must name a surface that actually exists in the
// product. ST1 found the welcome emails pointing at a "Settings" page
// that had never existed and at "Admin" for a toggle that lives on My
// Business — this gate makes that class of drift impossible: copy and
// surfaces are pinned to EACH OTHER, so renaming either side without
// the other fails a row.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');
const orch = fs.readFileSync(path.join(__dirname, '..', 'lib', 'signup-orchestrator.js'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'lib', 'provisioning-worker.js'), 'utf8');

(async () => {
  // ---- SC1: the surfaces the copy points at EXIST ----
  {
    const navSettings = />\s*Settings\s*<\/a>/.test(app.replace(/<span[^>]*>[^<]*<\/span>/g, ''))
      || /<\/span> Settings<\/a>/.test(app);
    const planCard = app.includes('Plan &amp; usage') || app.includes('Plan & usage');
    const reachCard = app.includes('How Modern Management reaches you');
    const assistantCard = app.includes('How your assistant works');
    const myBusinessNav = app.includes('My Business</a>');
    check('SC1: every surface the outbound copy names exists — the Settings nav entry, Plan & usage, "How Modern Management reaches you", My Business, "How your assistant works"',
      navSettings && planCard && reachCard && assistantCard && myBusinessNav,
      JSON.stringify({ navSettings, planCard, reachCard, assistantCard, myBusinessNav }));
  }

  // ---- SC2: the welcome emails point at those real surfaces ----
  {
    const billing = (orch.match(/Manage billing in Settings under Plan &(amp;)? usage/g) || []).length === 4;
    const alertPhone = orch.includes('Set your alert phone in Settings &rarr; &ldquo;How Modern Management reaches you&rdquo;')
      && orch.includes('Set your alert phone in Settings > "How Modern Management reaches you"');
    const autoRespond = orch.includes('open My Business and turn on auto-respond under &ldquo;How your assistant works&rdquo;')
      // the text variant lives in a double-quoted JS string, so the
      // source carries escaped quotes
      && orch.includes('open My Business and turn on auto-respond under \\"How your assistant works\\"');
    check('SC2: all four welcome-email variants direct billing to Settings/Plan & usage; the alert-phone pointer names the real card; auto-respond points at MY BUSINESS (the ST1 misdirection, corrected in both HTML and text variants)',
      billing && alertPhone && autoRespond,
      JSON.stringify({ billing, alertPhone, autoRespond }));
  }

  // ---- SC3: no copy points at surfaces that do not exist ----
  {
    // The stale claims must be GONE, everywhere in outbound copy.
    const staleAdminArrow = /Admin (&rarr;|>|→) Notification Settings/.test(orch);
    const staleOpenAdmin = /open Admin and turn on/.test(orch);
    const staleWorkerAdmin = /retry from Admin/.test(worker);
    // "Notification Settings" as a named destination exists nowhere in
    // the product — no copy may claim it.
    const phantomCard = /Notification Settings/.test(orch) || /Notification Settings/.test(worker);
    check('SC3: zero stale pointers remain — no "Admin → Notification Settings", no "open Admin" for auto-respond, no "retry from Admin", no phantom card names anywhere in outbound copy',
      !staleAdminArrow && !staleOpenAdmin && !staleWorkerAdmin && !phantomCard,
      JSON.stringify({ staleAdminArrow, staleOpenAdmin, staleWorkerAdmin, phantomCard }));
  }

  // ---- SC4: the rename is complete on the UI side ----
  {
    // No user-visible "Admin" label remains (internal ids/routes keep
    // 'admin' by design — they are not user-visible).
    const navAdminLabel = /<\/span> Admin<\/a>/.test(app);
    const tileAdmin = /quick-tile-title">Admin</.test(app);
    const heroIntact = app.includes('Your account'); // the page hero was already honest
    check('SC4: no user-visible "Admin" label remains (nav + quick tile renamed; internal ids deliberately keep admin); the page hero stays "Your account"',
      !navAdminLabel && !tileAdmin && heroIntact,
      JSON.stringify({ navAdminLabel, tileAdmin, heroIntact }));
  }

  // ---- SC5: Sarah stays silent about settings ----
  {
    // ST1's census: the customer-facing engine makes NO settings
    // claims. Pin it — a future prompt edit that tells customers
    // about settings pages fails here.
    const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    const claims = /[Ss]ettings page|in Settings|your settings/.test(engine);
    check('SC5: the customer-facing engine (Sarah) makes zero settings claims — customers are never pointed at owner surfaces', !claims);
  }

  console.log(`${pass}/${pass + fail} — settings-claims gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

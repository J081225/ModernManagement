// scripts/test-direct-payments.js — VZ item 1 gate ("How you get paid"
// card redesign + Venmo/Zelle manual-confirm fields).
//
// Drives the REAL validators, source-pins the persistence path
// (endpoint + plan-summary + migration), and pins the UI contract:
// the processors are NAMED, the direct-payment inputs are REAL (wired
// to the endpoint, not decorative), and the copy passes the claims
// census — per-method truth (manual), and nothing promising behavior
// that isn't live (VZ 2-5 stay queued).
const path = require('path');
const fs = require('fs');
const { normalizeVenmoHandle, normalizeZelleInfo } = require(path.join(__dirname, '..', 'lib', 'direct-payments'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');

(async () => {
  // ---- DP1: Venmo validator — canonicalizes, rejects garbage, clears ----
  {
    const accepts = normalizeVenmoHandle('@jay-horton').value === 'jay-horton'   // strips '@'
      && normalizeVenmoHandle('jayhorton').value === 'jayhorton'
      && normalizeVenmoHandle('  Coffee_Shop-5 ').value === 'Coffee_Shop-5';       // trims
    const clears = normalizeVenmoHandle('').value === null
      && normalizeVenmoHandle('   ').value === null
      && normalizeVenmoHandle('@').value === null
      && normalizeVenmoHandle(null).value === null;
    const rejects = ['ab', 'has space', 'jay;DROP', 'bad@handle', 'x'.repeat(31), 42, {}]
      .every((h) => !!normalizeVenmoHandle(h).error);
    check('DP1: Venmo validator strips @/trims to a canonical handle, clears on empty, and rejects too-short / bad-char / injection / >30 / non-string',
      accepts && clears && rejects, JSON.stringify({ accepts, clears, rejects }));
  }

  // ---- DP2: Zelle validator — email OR phone, rejects neither ----
  {
    const email = normalizeZelleInfo('jay@example.com').value === 'jay@example.com';
    const phones = normalizeZelleInfo('313-631-8389').value === '313-631-8389'
      && !normalizeZelleInfo('+1 (313) 631-8389').error;                          // 11 digits ok
    const clears = normalizeZelleInfo('').value === null && normalizeZelleInfo(null).value === null;
    const rejects = !!normalizeZelleInfo('nota valid thing').error
      && !!normalizeZelleInfo('x'.repeat(101)).error
      && !!normalizeZelleInfo(42).error;
    check('DP2: Zelle validator accepts an email or a US-shaped phone, clears on empty, and rejects plainly-neither / too-long / non-string',
      email && phones && clears && rejects, JSON.stringify({ email, phones, clears, rejects }));
  }

  // ---- DP3: migration 068 — additive, idempotent, both columns ----
  {
    const mig = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '068_direct_payment_handles.sql'), 'utf8');
    const venmo = /ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS venmo_handle TEXT/.test(mig);
    const zelle = /ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS zelle_info\s+TEXT/.test(mig);
    check('DP3: migration 068 adds workspaces.venmo_handle + zelle_info, additive and idempotent (ADD COLUMN IF NOT EXISTS)',
      venmo && zelle, JSON.stringify({ venmo, zelle }));
  }

  // ---- DP4: the endpoint — real, validated, partial, workspace-scoped, NOT re-auth ----
  {
    const start = srv.indexOf("app.patch('/api/workspace/direct-payments'");
    const block = start === -1 ? '' : srv.slice(start, srv.indexOf('[PATCH /api/workspace/direct-payments]'));
    const authed = block.includes("app.patch('/api/workspace/direct-payments', requireAuth");
    const usesValidators = block.includes('normalizeVenmoHandle') && block.includes('normalizeZelleInfo');
    const partial = block.includes("'venmo_handle' in body") && block.includes("'zelle_info' in body");
    const validates400 = /\.error\)?\s*return res\.status\(400\)/.test(block) || block.includes('return res.status(400)');
    const scoped = /UPDATE workspaces SET \$\{updates\.join\(', '\)\} WHERE id = \$\$\{i\}/.test(block)
      || /UPDATE workspaces SET .*WHERE id = /.test(block);
    // per the ruling these are display info, NOT credential-class — so
    // the handler must NOT re-auth (over-gating would be dishonest UX).
    const notReauth = !block.includes('_reauth');
    check('DP4: PATCH /api/workspace/direct-payments is authed, runs the real validators, updates only present keys (partial), writes workspace-scoped, 400s on bad input, and does NOT re-auth (not credential-class)',
      !!authed && usesValidators && partial && validates400 && scoped && notReauth,
      JSON.stringify({ authed, usesValidators, partial, validates400, scoped, notReauth }));
  }

  // ---- DP5: plan-summary surfaces the saved handles (pre-fill, no 2nd fetch) ----
  {
    const inSelect = /SELECT[\s\S]{0,240}venmo_handle, zelle_info[\s\S]{0,80}FROM workspaces WHERE id = \$1/.test(srv);
    const inJson = /venmo_handle: venmoHandle/.test(srv) && /zelle_info: zelleInfo/.test(srv);
    check('DP5: /api/plan-summary selects venmo_handle + zelle_info and returns them (nullable) so the card pre-fills without a second fetch',
      inSelect && inJson, JSON.stringify({ inSelect, inJson }));
  }

  // ---- DP6: the card is renamed and the processors are NAMED rows ----
  {
    const title = app.includes('<div class="card-head-title">How you get paid</div>');
    // Stripe + Square each appear as a named row label (min-width row name).
    const stripeNamed = /min-width:80px;">Stripe<\/div>/.test(app);
    const squareNamed = /min-width:80px;">Square<\/div>/.test(app);
    // chip vocabulary present in the render logic
    const chips = app.includes("'Not connected'") && app.includes("'In progress'")
      && app.includes("badge.textContent = isActive ? '✓ Active' : 'Connected'");
    check('DP6: the card reads "How you get paid"; Stripe and Square are parallel NAMED rows; the chip vocabulary (Not connected / In progress / Connected / Active) is in the render',
      title && stripeNamed && squareNamed && chips,
      JSON.stringify({ title, stripeNamed, squareNamed, chips }));
  }

  // ---- DP7: the Venmo/Zelle inputs are REAL, not decorative (no fake controls) ----
  {
    const inputs = app.includes('id="venmoHandleInput"') && app.includes('id="zelleInfoInput"');
    const wired = /onclick="saveVenmoHandle\(\)"/.test(app) && /onclick="saveZelleInfo\(\)"/.test(app);
    const hitEndpoint = (app.match(/fetch\('\/api\/workspace\/direct-payments'/g) || []).length >= 2;
    const prefill = app.includes('function renderDirectPayments(ps)')
      && app.includes("vIn.value = ps.venmo_handle ? '@' + ps.venmo_handle : ''");
    check('DP7: the Venmo/Zelle inputs persist through the real endpoint (both save fns PATCH /api/workspace/direct-payments) and pre-fill from the summary — real controls, not decorative',
      inputs && wired && hitEndpoint && prefill,
      JSON.stringify({ inputs, wired, hitEndpoint, prefill }));
  }

  // ---- DP8: claims census — per-method truth, nothing promising un-live behavior ----
  {
    const dpIdx = app.indexOf('Section: direct payments (VZ item 1)');
    const dp = dpIdx === -1 ? '' : app.slice(dpIdx, dpIdx + 2400);
    const manualTruth = dp.includes('confirm manually') && dp.includes('no automatic confirmation');
    // the stored-not-shown disclaimer appears on BOTH rows' helper lines
    // (unique phrase, counted across the file so long inline styles in
    // the slice can't hide the second row).
    const honestToday = (app.match(/isn't shown to customers yet/g) || []).length >= 2;
    const comingNotClaimed = dp.includes('is coming'); // framed as future, not present
    // no affirmative auto/live claim for these methods
    const noFalseAuto = !/automatically/i.test(dp) && !/instantly/i.test(dp)
      && !/customers can (now )?pay/i.test(dp);
    check('DP8: the Direct payments copy states per-method truth (confirm manually / no automatic confirmation), says honestly the info is stored-not-shown today with QR/requests "coming", and makes no false auto/live claim',
      manualTruth && honestToday && comingNotClaimed && noFalseAuto,
      JSON.stringify({ manualTruth, honestToday, comingNotClaimed, noFalseAuto }));
  }

  console.log(`${pass}/${pass + fail} — direct-payments gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

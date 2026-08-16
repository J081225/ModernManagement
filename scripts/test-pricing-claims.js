// scripts/test-pricing-claims.js — pricing claims census gate.
//
// The 2026-08-16 pricing collapse: ONE plan ($320/mo, $3,200/yr, $160
// founding), and a hard census rule — the landing "All live today" list and
// the signup funnel may claim ONLY features that exist. This gate pins that:
//
//   - the five nonexistent features (lib/plans.js ANTI_LIST) never surface;
//   - the two GATED claims (SMS "texts back"; additional languages) stay OUT
//     of active copy until they're claimable — kept as flip-ready comments;
//   - the retired Starter/Pro/Premium prices are gone;
//   - the ruled honest numbers + real headliners are present;
//   - plans.js is actually collapsed and legacy ids resolve safely.
//
// A future edit that re-lists a fictional feature, flips a gated line in
// early, or reintroduces a retired price fails a row here.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const plans = require('../lib/plans');
const landingRaw = fs.readFileSync(path.join(__dirname, '..', 'public', 'professional-services.html'), 'utf8');
const signupRaw  = fs.readFileSync(path.join(__dirname, '..', 'views', 'signup.html'), 'utf8');
// Active copy = what actually renders. HTML comments (where the gated,
// flip-ready lines live) are NOT active copy, so strip them first.
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const landing = stripComments(landingRaw);
const signup  = stripComments(signupRaw);

const ANTI = plans.ANTI_LIST; // [{ flag, label }]

(async () => {
  // ---- PC1: the five nonexistent features never appear (flags + copy) ----
  {
    const flagsFalse = ['trial', 'professional'].every(
      (p) => ANTI.every((a) => plans.hasFeature(p, a.flag) === false));
    const labelsAbsent = ANTI.every((a) => !landing.includes(a.label) && !signup.includes(a.label));
    check('PC1: the anti-list (5 nonexistent features) is false on trial+professional AND no label appears in active landing/signup copy',
      flagsFalse && labelsAbsent, JSON.stringify({ flagsFalse, labelsAbsent }));
  }

  // ---- PC2: the two GATED claims are OUT of active copy, kept as comments --
  {
    const smsAbsentActive = !/Texts back/i.test(landing) && !/handles SMS conversations/i.test(landing);
    const arabicAbsentActive = !/Arabic/i.test(landing) && !/Arabic/i.test(signup);
    const smsCommentKept  = /GATED.{1,4}SMS/.test(landingRaw);
    const langCommentKept = /GATED.{1,8}more languages/.test(landingRaw);
    check('PC2: SMS "texts back" + Arabic are absent from ACTIVE copy (A2P + language gates) and both flip-ready comments are preserved on the landing',
      smsAbsentActive && arabicAbsentActive && smsCommentKept && langCommentKept,
      JSON.stringify({ smsAbsentActive, arabicAbsentActive, smsCommentKept, langCommentKept }));
  }

  // ---- PC3: retired PS tier prices are gone ----
  {
    const landingClean = !landing.includes('$149') && !landing.includes('$295') && !landing.includes('$375');
    // signup keeps PM prices ($79/$149/$299) legitimately; only the uniquely
    // PS-retired numbers must be gone.
    const signupClean = !signup.includes('$295') && !signup.includes('$375');
    check('PC3: retired PS tier prices are gone ($149/$295/$375 off the landing; $295/$375 off signup)',
      landingClean && signupClean, JSON.stringify({ landingClean, signupClean }));
  }

  // ---- PC4: the ruled honest numbers are present on the landing ----
  {
    const monthly  = landing.includes('$320');
    const annual   = landing.includes('$3,200');
    const founding = landing.includes('$160');
    const fairUse  = /1,000 AI-handled voice minutes/.test(landing);
    const overage  = landing.includes("overages you didn't agree to");
    check('PC4: landing shows $320 monthly, $3,200 annual, $160 founding, the ~1,000-min fair-use line, and the no-surprise-overage clause',
      monthly && annual && founding && fairUse && overage,
      JSON.stringify({ monthly, annual, founding, fairUse, overage }));
  }

  // ---- PC5: the real live headliners + the "All live today" label ----
  {
    const receptionist = /AI phone receptionist/.test(landing);
    const spanish = /Spanish/.test(landing);
    const payments = /secure card link/.test(landing);
    const report = /transaction report/.test(landing);
    const allLive = /All live today/.test(landing);
    check('PC5: landing lists the real live headliners (AI phone receptionist, Spanish, honest payments, transaction report) under an "All live today" label',
      receptionist && spanish && payments && report && allLive,
      JSON.stringify({ receptionist, spanish, payments, report, allLive }));
  }

  // ---- PC6: the collapse actually holds in plans.js ----
  {
    const onePlan = plans.VALID_PLAN_IDS.length === 2
      && plans.VALID_PLAN_IDS.includes('professional')
      && plans.VALID_PLAN_IDS.includes('trial');
    // Every retired tier id (and an empty/unknown id) resolves to the one plan.
    const legacySafe = ['solo', 'team', 'enterprise', 'starter', 'pro', 'premium', '']
      .every((id) => plans.getPlan(id).name === 'Professional');
    const pro = plans.getPlan('professional');
    const price = pro.monthlyPrice === 320 && pro.annualPrice === 3200 && pro.foundingPrice === 160;
    check('PC6: plans.js is collapsed to trial+professional, every legacy tier id resolves to Professional, and the prices are $320 / $3,200 / $160',
      onePlan && legacySafe && price, JSON.stringify({ onePlan, legacySafe, price }));
  }

  console.log(`${pass}/${pass + fail} — pricing-claims gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

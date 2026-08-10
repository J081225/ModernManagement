// scripts/test-reports-vertical.js — RV2 gate.
//
// Pins the vertical-aware Reports build and, above all, the MONEY
// GUARDRAIL (ruling 4, LAW): any dollar figure in any narrative report
// sources from the TR composer (composeTransactionReport), never a
// fresh sum of raw rows. A future edit that totals total_cents inside
// report generation fails RV3 here.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');

// Isolate the report-generation region (buildReportSnapshot through the
// end of generateReportContent) so the money census targets report
// code specifically, not the whole server.
const genStart = srv.indexOf('async function buildReportSnapshot');
const genEnd = srv.indexOf('const userMessage = prompt || `Generate a ${type} report');
const reportRegion = genStart >= 0 && genEnd > genStart ? srv.slice(genStart, genEnd) : '';

(function () {
  // ---- RV1: the advisor voice is vertical-aware ----
  {
    const psVoice = srv.includes('You are an expert advisor for an appointment-based service business');
    const pmVoice = srv.includes('You are an expert property management advisor writing a written report');
    const branched = srv.includes('const isPSReport = reportVertical ===')
      && srv.includes('isPSReport ? psGuidance : pmGuidance');
    check('RV1: the report system prompt branches on vertical — PS gets the service-business advisor voice + guidance, PM keeps its property-management framing',
      psVoice && pmVoice && branched, JSON.stringify({ psVoice, pmVoice, branched }));
  }

  // ---- RV2: PS launch guidance covers exactly activity/customers/week_ahead ----
  {
    const g = srv.slice(srv.indexOf('const psGuidance ='), srv.indexOf('const pmGuidance ='));
    const covers = /activity report/.test(g) && /customers report/.test(g) && /week_ahead report/.test(g);
    const noMoneyType = !/revenue report|budget report/.test(g); // launch types are non-money
    check('RV2: PS guidance covers the ruled launch types (activity, customers, week_ahead) and defines no money-report type',
      covers && noMoneyType, JSON.stringify({ covers, noMoneyType }));
  }

  // ---- RV3: THE MONEY GUARDRAIL (law) ----
  {
    // (a) the composer is the money source in the snapshot
    const composerSourced = reportRegion.includes("require('./lib/transaction-report')")
      && reportRegion.includes('composeTransactionReport(')
      && reportRegion.includes('money_summary');
    // (b) the prompt forbids self-totalling raw rows
    const guardrailLine = srv.includes('NEVER add up recent_transactions')
      && srv.includes('cite ONLY the money_summary block');
    // (c) THE CENSUS: no hand-rolled money SUM over raw cents columns
    //     inside report generation. SQL SUM(...cents) or JS .reduce over
    //     a *_cents field would be a second money stack — forbidden.
    const sqlSum = /SUM\(\s*(total_cents|amount_cents|amount_paid_cents|owed_cents|price_amount)/i.test(reportRegion);
    const jsReduceCents = /\.reduce\([^)]*\bcents\b/.test(reportRegion);
    check('RV3 [MONEY GUARDRAIL, law]: report generation sources every dollar total from composeTransactionReport (money_summary), the prompt forbids self-totalling raw rows, and NO hand-rolled SUM/reduce over a cents column exists in the report region',
      composerSourced && guardrailLine && !sqlSum && !jsReduceCents,
      JSON.stringify({ composerSourced, guardrailLine, sqlSum, jsReduceCents }));
  }

  // ---- RV4: dropdowns vertical-gated, PS never sees PM-only types ----
  {
    const fn = app.slice(app.indexOf('function applyReportTypeOptions'), app.indexOf('function applyVerticalVisibility'));
    // isolate each list literal, then check membership within it
    const psLit = fn.slice(fn.indexOf('const PS ='), fn.indexOf('const types ='));
    const pmLit = fn.slice(fn.indexOf('const PM ='), fn.indexOf('const PS ='));
    const psList = ['activity', 'customers', 'week_ahead', 'general'].every((t) => psLit.includes(`'${t}'`));
    const pmList = ['budget', 'tenant', 'inventory'].every((t) => pmLit.includes(`'${t}'`));
    const psExcludesPM = !['tenant', 'inventory', 'budget'].some((t) => psLit.includes(`'${t}'`));
    const bothDropdowns = fn.includes("getElementById('reportTypeFilter')") && fn.includes("getElementById('newReportType')");
    const wired = app.includes('applyReportTypeOptions(isPS)');
    check('RV4: applyReportTypeOptions gates BOTH the list filter and the generation picker — PS gets activity/customers/week_ahead/general and never tenant/inventory/budget — and is wired into applyVerticalVisibility',
      psList && pmList && bothDropdowns && wired && psExcludesPM,
      JSON.stringify({ psList, pmList, bothDropdowns, wired, psExcludesPM }));
  }

  // ---- RV5: model tier unchanged (parity law) ----
  {
    const opus = srv.includes('model: config.ANTHROPIC_REPORT_MODEL');
    const cfg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'config.js'), 'utf8');
    const isOpus = /ANTHROPIC_REPORT_MODEL = 'claude-opus/.test(cfg);
    check('RV5: reports still run on ANTHROPIC_REPORT_MODEL (Opus) for both verticals — the quality-anchor parity law, unchanged by RV2',
      opus && isOpus, JSON.stringify({ opus, isOpus }));
  }

  console.log(`${pass}/${pass + fail} — reports-vertical gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

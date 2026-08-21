// scripts/test-ai-scope.js — AI-scope hardening gate (B1–B4, 2026-08-19).
//
// The "free therapist" guardrails, pinned: the per-call cap on EVERY
// relay line, the human-crisis keyword extension (behavior-tested with
// the rebuilt production regex — the "Cancel my 2pm" lesson), the
// never-counsel scope contract, the turn-counted redirect (N=4) and
// canned close (N=6), the owner-assistant scope contract, and the
// report cost-guard at both creation sites.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');

(async () => {
  // ---- AS1 (B1): every relay call is capped, not just the demo.
  // B1 refinement (Jay's ruled wording): business calls are TWO-stage —
  // the 520s check-in question, then the 580s wrap + end — and the cap
  // stamps the CALL RECORD, not just the console. ----
  {
    const capTernary = srv.includes("const capMs = isDemo ? 172000 : 580000;");
    const checkIn = srv.includes("I want to make sure I'm not keeping you — was there anything else about your appointment?")
      && srv.includes('}, 520000);');
    const businessWrap = srv.includes("I'm so sorry — I have to wrap up our call now.");
    const logged = /CAP fired \(' \+ \(isDemo \? 'demo\/172s' : 'business\/580s'\)/.test(srv);
    const onRecord = /appendCallTurn\(pool, transcriptId, 'System',[\s\S]{0,120}limit and was wrapped up/.test(srv);
    const ends = srv.includes("ws.send(JSON.stringify({ type: 'end' }))");
    const timerHygiene = srv.includes('let capCheckInTimer = null;')
      && srv.includes('if (capCheckInTimer) { clearTimeout(capCheckInTimer); capCheckInTimer = null; }');
    check('AS1 [B1]: every relay call is capped (demo 172s / business 580s); business gets the ruled 520s check-in THEN the wrap; the cap stamps the call record as a System turn; timers cleared on close',
      capTernary && checkIn && businessWrap && logged && onRecord && ends && timerHygiene,
      JSON.stringify({ capTernary, checkIn, businessWrap, logged, onRecord, ends, timerHygiene }));
  }

  // ---- AS1b (B5): the demo line's existing caps are UNCHANGED ----
  {
    const demoWrap = srv.includes("This demo call is wrapping up — thanks for trying it!");
    const demo172 = srv.includes('172000');
    const dailyCeiling = srv.includes('const DEMO_DAILY_MINUTES_CAP = 35;');
    const noCheckInForDemo = /if \(!isDemo\) \{\s*\n\s*capCheckInTimer = setTimeout/.test(srv);
    check('AS1b [B5]: demo caps unchanged — 172s single-stage wrap with the demo line, 35-min daily ceiling, and the new check-in stage explicitly excludes demo calls',
      demoWrap && demo172 && dailyCeiling && noCheckInForDemo,
      JSON.stringify({ demoWrap, demo172, dailyCeiling, noCheckInForDemo }));
  }

  // ---- AS2 (B2): crisis keywords — behavior-tested with the REAL regex ----
  {
    // Rebuild the production regex from the production list (literal
    // array extracted from source, same escape + \b construction).
    const m = srv.match(/AUTOREPLY_EMERGENCY_KEYWORDS = \[([\s\S]*?)\];/);
    let keywords = [];
    try { keywords = eval('[' + m[1] + ']'); } catch (e) { /* fails the check */ }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b(' + keywords.map(esc).join('|') + ')\\b', 'gi');
    const hits = (t) => (String(t).match(re) || []).length > 0;
    const crisisCaught = hits('I want to kill myself') && hits('thinking about suicide')
      && hits('I might hurt myself tonight') && hits("I'm going to kill you");
    const bookingClean = !hits('Cancel my 2pm appointment please')
      && !hits('Can I book a fade for tomorrow?')
      && !hits('How much is a beard trim?');
    const propertyIntact = hits('there is a gas leak') && hits('fire in the kitchen');
    check('AS2 [B2]: the production keyword regex catches self-harm/violence intent, keeps property emergencies, and stays CLEAN on normal booking talk',
      keywords.length > 20 && crisisCaught && bookingClean && propertyIntact,
      JSON.stringify({ n: keywords.length, crisisCaught, bookingClean, propertyIntact }));
  }

  // ---- AS3 (B2): the never-counsel scope contract in the customer prompt ----
  {
    const scope = eng.includes('## Scope')
      && eng.includes('not a general assistant, advisor, or counselor')
      && eng.includes('never advice, never counseling')
      && eng.includes('988');
    check('AS3 [B2]: the engine prompt carries the Scope contract — receptionist not counselor, one warm sentence for emotional content, crisis reply minimal + 988',
      scope);
  }

  // ---- AS4 (B3): the turn-counted redirect is structural ----
  {
    const counter = eng.includes('BUSINESS_INTENT_RE') && eng.includes('off_topic_turns');
    const redirectAt4 = /offTopicTurns === 4\s*\?/.test(eng) && eng.includes('## Redirect now');
    const closeAt6 = eng.includes('offTopicTurns >= 6') && eng.includes("customerString(closeLang, 'off_topic_close'");
    const toolReset = eng.includes("aiResponse.content.some((b) => b.type === 'tool_use')");
    const migration = fs.existsSync(path.join(__dirname, '..', 'migrations', 'phase1-additive', '077_off_topic_turns.sql'));
    const voiceClose = srv.includes('result.close_conversation') && /close_conversation[\s\S]{0,400}type: 'end'/.test(srv);
    check('AS4 [B3]: off-topic turns counted in code (migration 077), redirect directive at exactly 4, canned close at 6 with zero model cost, tool-use resets, voice ends politely after the close',
      counter && redirectAt4 && closeAt6 && toolReset && migration && voiceClose,
      JSON.stringify({ counter, redirectAt4, closeAt6, toolReset, migration, voiceClose }));
  }

  // ---- AS5 (B3): the canned close is census-legal — all three variants ----
  {
    const { customerString } = require(path.join(__dirname, '..', 'lib', 'customer-strings'));
    const en = customerString('en', 'off_topic_close', { businessName: 'Northside' });
    const es = customerString('es', 'off_topic_close', { businessName: 'Northside' });
    const ar = customerString('ar', 'off_topic_close', { businessName: 'Northside' });
    check('AS5 [B3]: off_topic_close declares en/es/ar variants, each carrying the business name and a warm non-scolding close',
      [en, es, ar].every((s) => typeof s === 'string' && s.includes('Northside') && s.length > 40) && en !== es && es !== ar);
  }

  // ---- AS6 (B4): owner-assistant scope contract, wired into the prompt ----
  {
    const contract = srv.includes('const scopeContract')
      && srv.includes('not a general-purpose AI')
      && srv.includes('warm, brief, never scolding');
    const wired = srv.includes('${businessFraming}${scopeContract}');
    check('AS6 [B4]: the owner prompt carries the scope contract (generous on business, ONE friendly redirect for personal asks) and it is actually interpolated',
      contract && wired, JSON.stringify({ contract, wired }));
  }

  // ---- AS7 (B4): the report cost-guard at BOTH creation sites ----
  {
    const cap = require(path.join(__dirname, '..', 'lib', 'report-cap'));
    const capRight = cap.DAILY_REPORT_CAP === 10 && /resets at midnight/.test(cap.REPORT_CAP_MESSAGE);
    const endpointWired = /reportCapExceeded\(pool, workspaceId\)[\s\S]{0,120}429/.test(srv);
    const toolSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'generate_report.js'), 'utf8');
    const toolWired = toolSrc.includes('reportCapExceeded(ctx.db, ctx.workspace.id)');
    // Generation-only: the endpoint gate sits on the prompt-without-content path.
    const generationOnly = /if \(prompt && !content\) \{\s*\n\s*const \{ reportCapExceeded/.test(srv);
    check('AS7 [B4]: report generations capped at 10/workspace/day at BOTH sites (endpoint 429 + tool refusal), honest message, generation-only (saving content uncapped)',
      capRight && endpointWired && toolWired && generationOnly,
      JSON.stringify({ capRight, endpointWired, toolWired, generationOnly }));
  }

  // ---- AS8 (B5): crisis coverage per channel — the four call sites +
  // a channel-shaped fixture through the REAL rebuilt regex for each ----
  {
    // Site pins: 3× rows[0].text (SMS :~7572, email :~7330, voicemail
    // :~7727 with re-alert dedup), 1× utterance (relay voice FD3-CP2),
    // 1× display recompute — all feeding the ONE shared gate.
    const rowSites = (srv.match(/detectEmergency\(rows\[0\]\.text\)/g) || []).length;
    const voiceSite = srv.includes('detectEmergency(utterance)');
    const displaySite = srv.includes('msg.emergency_keywords = detectEmergency(msg.text)');
    // Channel-shaped fixtures through the regex rebuilt from source.
    const m = srv.match(/AUTOREPLY_EMERGENCY_KEYWORDS = \[([\s\S]*?)\];/);
    let kws = [];
    try { kws = eval('[' + m[1] + ']'); } catch (e) { /* fails below */ }
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b(' + kws.map(esc).join('|') + ')\\b', 'gi');
    const hits = (t) => (String(t).match(re) || []).length > 0;
    const fixtures = {
      sms: hits("I don't want to be here anymore, I want to end my life"),
      email: hits('I have been thinking about suicide and I need someone to talk to'),
      voicemail: hits('he said he would kill her if she ever came back to the shop'),
      voice: hits("I'm going to hurt myself after this appointment, I mean it"),
    };
    const allChannels = Object.values(fixtures).every(Boolean);
    check('AS8 [B5]: all four channel call sites feed the one gate (3× rows[0].text + relay utterance + display recompute) and a channel-shaped crisis fixture alerts on each',
      rowSites === 3 && voiceSite && displaySite && allChannels,
      JSON.stringify({ rowSites, voiceSite, displaySite, fixtures }));
  }

  console.log(`${pass}/${pass + fail} — ai-scope gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

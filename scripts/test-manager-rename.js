// scripts/test-manager-rename.js — MR1 gate (Manager rename, unit 1:
// app UI + welcome email + prompts + voice disclosure).
//
// Pins: (a) no user-visible "assistant" survives in the swept surfaces
// (app.html outside code identifiers, welcome email, customer strings);
// (b) the voice greeting carries the ruled "automated manager"
// disclosure in ALL THREE languages; (c) "Owner review" replaced
// "Manager review"; (d) the legal pages' "property manager" (the
// HUMAN) counts are untouched; (e) the engine self-conception says
// automated manager AND keeps the plain-yes robot honesty, while the
// B2 scope-contract line stays verbatim; (f) the welcome email's card
// cross-reference matches the live card title; (g) the 'assistant'
// message ROLE (wire contract) is intact everywhere.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const app = R('views/app.html');
const orch = R('lib/signup-orchestrator.js');
const engine = R('lib/appointment-engine.js');
const serverSrc = R('server.js');

// MR1 — app.html: strip the allowed CODE identifiers (kept by standing
// rule), then assert zero /assistant/i remains. Any new user-visible
// "assistant" trips this.
{
  const ALLOWED = [
    'assistant-open', 'openAssistant', 'collapseAssistant',
    'buildAssistantContext', 'assistantOpen', "appendCCMessage('assistant'",
  ];
  let stripped = app;
  for (const t of ALLOWED) stripped = stripped.split(t).join('');
  const leftover = stripped.match(/assistant/gi) || [];
  check('MR1: app.html has ZERO "assistant" outside the kept code identifiers',
    leftover.length === 0, leftover.length + ' leftover occurrence(s)');
}

// MR2 — voice greeting discloses the automated manager in en/es/ar
// (behavioral: call the actual string builders).
{
  delete require.cache[require.resolve('../lib/customer-strings')];
  const cs = require('../lib/customer-strings');
  const en = cs.customerString('en', 'voice_greeting', { businessName: 'Test Biz' });
  const es = cs.customerString('es', 'voice_greeting', { businessName: 'Test Biz' });
  const ar = cs.customerString('ar', 'voice_greeting', { businessName: 'Test Biz' });
  check('MR2: greeting discloses automation in all three languages (en "automated manager", es "automatizado", ar "الآلي")',
    en.includes('automated manager') && es.includes('automatizado') && ar.includes('الآلي'),
    JSON.stringify({ en: en.includes('automated manager'), es: es.includes('automatizado'), ar: ar.includes('الآلي') }));
}

// MR3 — the auto-reply-OFF mode is "Owner review"; the colliding old
// name is gone.
check('MR3: "Owner review" renders and "Manager review" is gone',
  app.includes('<span class="mode-card-title">Owner review</span>') && !/manager review/i.test(app));

// MR4 — "property manager" = the HUMAN on legal pages: counts pinned
// at their pre-rename baselines (rename must never touch them).
{
  const counts = {
    'public/privacy.html': 9,
    'public/terms.html': 1,
    'public/sms-consent.html': 7,
  };
  const actual = {};
  let ok = true;
  for (const [f, expect] of Object.entries(counts)) {
    const n = (R(f).match(/property manager/gi) || []).length;
    actual[f] = n;
    if (n !== expect) ok = false;
  }
  check('MR4: legal pages\' "property manager" counts unchanged (9/1/7)', ok, JSON.stringify(actual));
}

// MR5 — engine self-conception: automated manager + plain-yes robot
// honesty; the B2 scope-contract line is verbatim-untouched.
check('MR5: engine says "automated manager for", keeps robot honesty, and the B2 scope line is untouched',
  engine.includes('You are the automated manager for ${workspace.business_name || workspace.name}')
  && engine.includes('say plainly that you are an automated AI manager — never claim to be human')
  && engine.includes('You are not a general assistant, advisor, or counselor.'));

// MR6 — welcome email: zero assistant, and its card cross-reference
// matches the LIVE card title exactly (they renamed together).
check('MR6: welcome email is assistant-free and cross-references the real card title',
  !/assistant/i.test(orch)
  && orch.includes('How your Manager works')
  && app.includes('How your Manager works'));

// MR7 — wire contract: the 'assistant' message ROLE survives at the
// API/history seams (standing rule: never renamed).
check('MR7: the \'assistant\' role wire contract is intact (server history + panel)',
  serverSrc.includes("r.role === 'assistant'")
  && serverSrc.includes("{ role: 'assistant', content: turnResponse.content }")
  && app.includes("appendCCMessage('assistant'"));

// MR8 — the panel self-intro and update_ai_settings owner strings
// carry the new brand.
{
  const uas = R('lib/tools/update_ai_settings.js');
  check('MR8: panel self-intro says "automated manager"; tool messages say Manager',
    app.includes("I'm your automated manager. Ask me anything about your")
    && uas.includes('Only the business owner can change Manager settings.')
    && uas.includes('Manager settings updated:'));
}

// MR9 (unit 2) — marketing surfaces carry NEITHER "assistant" NOR
// "receptionist", except the allowed human-role price anchors
// ("a full-time receptionist runs $3-4k" — comparisons to the HUMAN
// job, kept by the untouchables rule) and the assistant.png asset
// filename (code identifier).
{
  const MARKETING = [
    'public/index.html', 'public/landing-next.html',
    'public/professional-services.html', 'public/property-management.html',
    'public/why-ai.html', 'public/features/knowledge-base.html',
    'views/signup.html',
  ];
  const ALLOWED = ['full-time receptionist runs', 'assistant.png'];
  const offenders = {};
  for (const f of MARKETING) {
    let s = R(f);
    for (const t of ALLOWED) s = s.split(t).join('');
    const n = (s.match(/assistant|receptionist/gi) || []).length;
    if (n) offenders[f] = n;
  }
  check('MR9: marketing surfaces have zero assistant/receptionist outside the human price anchors + asset filename',
    Object.keys(offenders).length === 0, JSON.stringify(offenders));
}

// MR10 (unit 2) — the human price anchors themselves survive (claims
// census: the comparison to a human receptionist's cost is a distinct
// claim and must not be silently reworded).
check('MR10: the three full-time-receptionist price anchors are intact',
  (R('public/landing-next.html').match(/full-time receptionist runs/g) || []).length === 2
  && (R('public/professional-services.html').match(/full-time receptionist runs/g) || []).length === 1);

// MR11 (unit 3, NARROW) — prompt self-descriptions where the model
// speaks to a person: command center + resident-facing draft/SMS
// prompts say AI Manager. The JSON-only task extractor and every
// behavior-constraining role noun (B2 scope line, advisor prompts)
// are intentionally NOT renamed — MR5 pins B2 verbatim.
check('MR11: person-facing prompt self-descriptions say AI Manager (command center ×2, draft/SMS ×3); JSON task prompt untouched',
  (serverSrc.match(/You are the AI Manager — the command center —/g) || []).length === 2
  && (serverSrc.match(/You are a professional property management AI Manager\./g) || []).length === 3
  && serverSrc.includes('You are a property management assistant that identifies follow-up tasks'));

console.log(`${pass}/${pass + fail} — manager-rename gate ${fail ? 'FAILED' : 'PASSED'}`);
process.exit(fail ? 1 : 0);

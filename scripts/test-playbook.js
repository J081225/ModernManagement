// scripts/test-playbook.js — AD9, rebuild of the lost `behaviors` +
// `playbook` gates (FD3-CP5), folded: both are the one buildSystemPrompt
// playbook block. Drives the real PURE buildSystemPrompt and asserts the
// situation rules, the three flagged behaviors, and the
// channel-agnostic-behavior / channel-only-style contract. The tool
// allowlist is source-pinned (buildToolListForEngine isn't exported;
// AD9 exports nothing purely for a test).
const path = require('path');
const fs = require('fs');
const { buildSystemPrompt } = require(path.join(__dirname, '..', 'lib', 'appointment-engine'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const WS = { business_name: 'Snip', timezone: 'America/New_York', vertical: 'professional-services' };
function prompt(over = {}) {
  return buildSystemPrompt({
    workspace: { ...WS, ...(over.workspace || {}) },
    contact: over.contact !== undefined ? over.contact : null,
    knowledge: over.knowledge || [],
    callerAppointments: over.callerAppointments || [],
    menu: over.menu || [],
    thread: over.thread || { context_summary: '', inbound_channel: 'sms' },
    channel: over.channel || 'sms',
  });
}

// Extract the playbook block (situation rules) — from its header to the
// channel-style header — so it can be compared across channels.
function playbookBlock(p) {
  const start = p.indexOf('## Conversation playbook');
  const end = p.indexOf('## Channel style', start);
  return p.slice(start, end);
}

(async () => {
  const base = prompt();

  // ---- PB1: every situation row is present ----
  {
    const rows = ['BOOKING:', 'CHANGE/CANCEL:', 'AVAILABILITY:', 'PRICES/SERVICES:', 'DAY-OF LOGISTICS:',
      'COMPLAINT:', 'UNKNOWN QUESTION:', 'VENDOR/WRONG NUMBER/SPAM:', 'EMERGENCY:', 'CALLBACK:'];
    const missing = rows.filter((r) => !base.includes(r));
    check('PB1: all 10 playbook situation rows present', missing.length === 0, 'missing: ' + missing.join(', '));
  }

  // ---- PB2: the three FD3-CP5 behaviors, exactly ----
  {
    const dayOf = base.includes('append_appointment_note') && base.includes('falls back to add_task');
    const complaint = /COMPLAINT:[^\n]*NEVER promise refunds[^\n]*escalate_appointment_to_owner with kind "complaint"/.test(base)
      && base.includes('NEVER argue');
    const unknown = /UNKNOWN QUESTION:[^\n]*escalate_appointment_to_owner with kind "question"/.test(base)
      && base.includes('NEVER bluff or invent an answer');
    check('PB2: day-of -> append_appointment_note (fallback add_task); complaint -> escalate kind complaint, never refunds; unknown -> escalate kind question, never bluff',
      dayOf && complaint && unknown, JSON.stringify({ dayOf, complaint, unknown }));
  }

  // ---- PB3: emergency + spam disengagement rules ----
  {
    check('PB3: EMERGENCY tells callers to call 911 and promises the owner is alerted; SPAM uses NO tools and just disengages',
      base.includes('call 911') && base.includes('the alert fires automatically')
        && /VENDOR\/WRONG NUMBER\/SPAM:[^\n]*Use NO tools/.test(base));
  }

  // ---- PB4: the playbook is BYTE-IDENTICAL across channels; style differs ----
  {
    const sms = prompt({ channel: 'sms' });
    const email = prompt({ channel: 'email' });
    const voice = prompt({ channel: 'voice' });
    const samePlaybook = playbookBlock(sms) === playbookBlock(email) && playbookBlock(email) === playbookBlock(voice);
    const styleDiffers = sms.includes('Channel style (text message)')
      && email.includes('Channel style (email)')
      && voice.includes('Channel style (live phone call)');
    const contract = sms.includes('The playbook applies on every channel — style changes, behavior does not.');
    check('PB4: the playbook block is identical across sms/email/voice while the channel-style block differs — behavior is channel-agnostic',
      samePlaybook && styleDiffers && contract, JSON.stringify({ samePlaybook, styleDiffers, contract }));
  }

  // ---- PB5: live channel drives style, not the thread's origin channel ----
  {
    // A voice call continuing an SMS-created thread must speak in VOICE
    // style (the FD3.5 fix — style keys off the live channel).
    const p = prompt({ channel: 'voice', thread: { context_summary: '', inbound_channel: 'sms' } });
    check('PB5: a voice turn on an SMS-origin thread uses VOICE style (live channel wins, not thread.inbound_channel)',
      p.includes('Channel style (live phone call)') && !p.includes('Channel style (text message)'));
  }

  // ---- PB6: the name-ask-once behavior (the "behaviors" gate core) ----
  {
    const named = prompt({ contact: { name: 'Dana Reeves' } });
    const placeholder = prompt({ contact: { name: 'Caller +1 443-555-0100' } });
    const unknown = prompt({ contact: null });
    check('PB6: a real-name contact -> "do NOT ask"; a "Caller ..." placeholder is treated as unnamed (ask once); no contact -> not on file',
      named.includes('Do NOT ask for their name') && named.includes('a known contact')
        && placeholder.includes('ask for it before finalizing') && placeholder.includes('do not have their name on file')
        && unknown.includes('not yet on file'),
      JSON.stringify({ named: named.includes('Do NOT ask'), ph: placeholder.includes('ask for it'), unk: unknown.includes('not yet on file') }));
  }

  // ---- PB7: tone + sales posture fire off workspace config, channel-independent ----
  {
    const warm = prompt({ workspace: { ai_tone: 'warm', ai_sales_posture: 'proactive' }, channel: 'voice' });
    const prof = prompt({ workspace: { ai_tone: 'professional', ai_sales_posture: 'reactive' }, channel: 'sms' });
    const none = prompt({ workspace: {} });
    check('PB7: ai_tone/ai_sales_posture inject their blocks when set (any channel) and are absent when unset',
      warm.includes('Speak warmly and personally') && warm.includes('gently suggest ONE relevant add-on')
        && prof.includes('polished, professional manner') && prof.includes('Focus on what the customer asks for')
        && !none.includes('## Tone') && !none.includes('## Sales approach'),
      JSON.stringify({ warm: warm.includes('warmly'), prof: prof.includes('professional manner'), none: !none.includes('## Tone') }));
  }

  // ---- PB8: menu pricing is "starting from"; empty menu is honest ----
  {
    const withMenu = prompt({ menu: [{ type: 'service', name: 'Cut', base_price_cents: 3000, duration_minutes: 30 }] });
    const noMenu = prompt({ menu: [] });
    check('PB8: a configured menu is priced "starting from"; an empty menu says so honestly (never invents offerings)',
      withMenu.includes('Cut') && withMenu.includes('$30.00') && withMenu.includes('"starting from"')
        && noMenu.includes('No menu items configured yet'),
      JSON.stringify({ withMenu: withMenu.includes('$30.00'), noMenu: noMenu.includes('No menu items') }));
  }

  // ---- PB9: source-pin — the appointment tool allowlist ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    const listIdx = src.indexOf('const APPOINTMENT_TOOL_NAMES = [');
    const listBlock = src.slice(listIdx, src.indexOf('];', listIdx));
    const expected = ['book_appointment', 'update_appointment', 'cancel_appointment', 'propose_appointment_times',
      'escalate_appointment_to_owner', 'add_task', 'append_appointment_note'];
    const allPresent = expected.every((n) => listBlock.includes("'" + n + "'"));
    // buildToolListForEngine filters getToolsForPlan down to this allowlist.
    const filtersOnAllowlist = src.includes('.filter((t) => APPOINTMENT_TOOL_NAMES.includes(t.name))');
    check('PB9: APPOINTMENT_TOOL_NAMES is exactly the 7 appointment tools and buildToolListForEngine filters the plan tools down to it',
      listIdx !== -1 && allPresent && filtersOnAllowlist, JSON.stringify({ allPresent, filtersOnAllowlist }));
  }

  console.log(`${pass}/${pass + fail} — playbook gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

// scripts/test-speech-grade.js — SPEECH-GRADE gate.
//
// Behavioral rows drive the REAL executeAIResult with a registered
// test tool whose message is deliberately TTS-hostile ("Booked: ...
// (30 min). Calendar updated." + ISO dates). Pins: on voice the raw
// tool message NEVER reaches the spoken reply (composed speech only,
// bridge spoken separately, speech-grade fallbacks); text channels
// keep the original concatenation; the live-call thread stays OPEN at
// booking (completed at teardown by the existing close seam);
// transcript turns carry timestamps.

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const registry = require(path.join(__dirname, '..', 'lib', 'tool-registry'));
const engine = require(path.join(__dirname, '..', 'lib', 'appointment-engine'));

const HOSTILE = 'Booked: Classic Cut for James on Thu, Sep 3, 5:30 PM (30 min). Calendar updated. Slots: 2026-09-03 — 9:00 AM.';
registry.register({
  name: 'sg_test_tool',
  description: 'test-only tool for the speech-grade gate',
  vertical: 'professional-services',
  category: 'read',
  schema: { type: 'object', properties: {} },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute() { return { success: true, message: HOSTILE }; },
});

function baseArgs(channel, extra) {
  return {
    aiResponse: { content: [
      { type: 'text', text: 'Let me get that for you.' },
      { type: 'tool_use', id: 'tu_1', name: 'sg_test_tool', input: {} },
    ] },
    workspace: { id: 21, owner_user_id: 18, business_name: 'X', vertical: 'professional-services' },
    contact: null, thread: { id: 7 }, channel, body: 'book it',
    customer_phone: '+15550001111', customer_email: null,
    db: { query: async () => ({ rows: [] }) },
    twilio: null, sendgrid: null, env: {}, logger: { error: () => {}, log: () => {} },
    ...extra,
  };
}

(async () => {
  // SP1 — voice: composed speech only; bridge spoken via the hook; raw
  // tool message absent from BOTH; tool data preserved for the pass.
  {
    const bridges = [];
    let sawResults = null;
    const r = await engine.executeAIResult(baseArgs('voice', {
      onSpeechSegment: (t) => bridges.push(t),
      composeSpeech: async ({ toolResults }) => { sawResults = toolResults; return "You're booked, James — Thursday September third at five thirty."; },
    }));
    check('SP1: voice reply = composed speech only; bridge = pre-tool text; raw "Booked:"/ISO/"Calendar updated" NEVER in either; tool data reached the pass',
      r.outbound_text === "You're booked, James — Thursday September third at five thirty."
      && bridges.length === 1 && bridges[0] === 'Let me get that for you.'
      && !/Booked:|Calendar updated|\d{4}-\d{2}-\d{2}/.test(r.outbound_text + bridges.join(' '))
      && sawResults && sawResults[0].content === HOSTILE && sawResults[0].tool_use_id === 'tu_1',
      JSON.stringify({ out: r.outbound_text, bridges }));
  }

  // SP2 — text channels unchanged: raw message concatenated, no pass.
  {
    let composeCalled = false;
    const r = await engine.executeAIResult(baseArgs('sms', {
      composeSpeech: async () => { composeCalled = true; return 'nope'; },
    }));
    check('SP2: SMS keeps the original concatenation (tool message present, compose pass never runs)',
      r.outbound_text.includes(HOSTILE) && composeCalled === false,
      JSON.stringify({ out: r.outbound_text.slice(0, 80), composeCalled }));
  }

  // SP3 — compose failure: speech-grade fallback, never the raw message.
  {
    const r = await engine.executeAIResult(baseArgs('voice', {
      composeSpeech: async () => { throw new Error('api down'); },
    }));
    registry.register({
      name: 'sg_test_tool_fail', description: 'test-only failing tool',
      vertical: 'professional-services', category: 'read',
      schema: { type: 'object', properties: {} },
      navigationPolicy: 'never', navigateTo: null, requiresApproval: false,
      async execute() { return { success: false, message: 'boom on 2026-01-01' }; },
    });
    const failTool = await engine.executeAIResult(baseArgs('voice', {
      aiResponse: { content: [{ type: 'tool_use', id: 'tu_2', name: 'sg_test_tool_fail', input: {} }] },
      composeSpeech: async () => { throw new Error('api down'); },
    }));
    check('SP3: compose failure -> speech-grade fallback lines; raw tool message still never spoken (success + failure variants)',
      /anything else I can help you with/.test(r.outbound_text)
      && !/Booked:|Calendar updated|\d{4}-\d{2}-\d{2}/.test(r.outbound_text)
      && /hit a snag/.test(failTool.outbound_text),
      JSON.stringify({ ok: r.outbound_text, fail: failTool.outbound_text }));
  }

  // SP4 — source: the real compose pass + directive + passthrough.
  {
    const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    check('SP4: _composeSpokenResult exists with the data-not-dialogue directive (no "Booked:", VERBATIM first-person rule, no tool calls) and processInboundMessage passes systemPrompt/tools/onSpeechSegment',
      eng.includes('async function _composeSpokenResult')
      && eng.includes('DATA, not dialogue')
      && eng.includes('never "Booked:" and never "Calendar updated"')
      && eng.includes('say that sentence VERBATIM')
      && eng.includes('systemPrompt, tools, onSpeechSegment,'));
  }

  // SP5 — live-call thread continuity: voice+confirmed booking sets
  // appointment_id WITHOUT touching state; other channels keep the
  // original complete/awaiting lifecycle; teardown close seam intact.
  {
    const book = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'book_appointment.js'), 'utf8');
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const liveBranch = /liveCall && initialStatus === 'confirmed'/.test(book)
      && /SET appointment_id = \$1, updated_at = NOW\(\)\s*\n\s*WHERE id = \$2/.test(book);
    const textBranch = book.includes("initialStatus === 'confirmed' ? 'complete' : 'awaiting_confirmation'");
    const teardown = srv.includes("if (lastThreadId) closeConversationThread(lastThreadId, 'voice');");
    check('SP5: live-call confirmed booking leaves thread state UNTOUCHED (findable all call); text channels unchanged; hangup close seam completes it',
      liveBranch && textBranch && teardown, JSON.stringify({ liveBranch, textBranch, teardown }));
  }

  // SP6 — telemetry: every transcript turn carries a UTC stamp.
  {
    const vt = require(path.join(__dirname, '..', 'lib', 'voice-transcript'));
    let captured = null;
    await vt.appendCallTurn({ query: async (sql, params) => { captured = params[2]; return { rows: [] }; } }, 42, 'Customer', 'hello world');
    check('SP6: appendCallTurn stamps [HH:MM:SSZ] on every line',
      typeof captured === 'string' && /^\[\d{2}:\d{2}:\d{2}Z\] Customer: hello world$/.test(captured),
      JSON.stringify({ captured }));
  }

  // SP7 — relay wiring: the bridge hook sends to TTS AND the transcript.
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const idx = srv.indexOf('onSpeechSegment: (segment) => {');
    const slice = idx > -1 ? srv.slice(idx, idx + 400) : '';
    check('SP7: relay onSpeechSegment -> sendText(segment) + AI transcript append',
      idx > -1 && slice.includes('sendText(segment)')
      && slice.includes("appendCallTurn(pool, transcriptId, 'AI', segment)"));
  }

  console.log(`${pass}/${pass + fail} — speech-grade gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('gate crashed:', err.stack || err.message); process.exit(1); });

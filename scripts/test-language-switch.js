// scripts/test-language-switch.js — LS gate: the mid-call spoken language
// switch (switch_language tool), 2026-08-22.
//
// Pins: the tool is voice-only and explicit-request-only; it fires ONLY
// on voice-ready ENABLED languages (the voiceLanguageFor fixed point);
// Arabic is a full peer gated solely by ARABIC_VOICE_ENABLED — BOTH flag
// states are exercised in this one process (fresh-require of
// customer-strings per state); the conversation is re-stamped; the
// confirmation is spoken in the NEW language; declines in the CURRENT
// one; the demo line's caps are untouched by the ws21 bilingual change.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const CS_PATH = path.join(__dirname, '..', 'lib', 'customer-strings.js');
function freshStrings(flag) {
  delete require.cache[require.resolve(CS_PATH)];
  if (flag) process.env.ARABIC_VOICE_ENABLED = 'true'; else delete process.env.ARABIC_VOICE_ENABLED;
  return require(CS_PATH);
}

// Load the registry + the tool once (flag off at load is fine: the tool
// re-requires customer-strings INSIDE execute).
delete process.env.ARABIC_VOICE_ENABLED;
require(path.join(__dirname, '..', 'lib', 'tools', 'index.js'));
const registry = require(path.join(__dirname, '..', 'lib', 'tool-registry'));
const tool = registry.getTool('switch_language');

// A ctx factory: captures the relay hook + the thread re-stamp query.
function makeCtx({ current = 'en', enabled = ['en', 'es'], channel = 'voice', withHook = true } = {}) {
  const calls = { hook: [], queries: [] };
  return {
    calls,
    ctx: {
      workspace: { id: 21, customer_language: current, enabled_languages: enabled },
      db: { query: async (sql, params) => { calls.queries.push({ sql, params }); return { rows: [] }; } },
      logger: { error: () => {} },
      onLanguageSwitch: withHook ? async (lang, code) => { calls.hook.push({ lang, code }); } : undefined,
      origin: { channel: 'ai_inbound', channel_detail: channel, appointment_thread_id: 777 },
    },
  };
}

(async () => {
  // ---- LS1: registered, voice-only in the engine, explicit-request-only ----
  {
    const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    const registered = !!tool && tool.requiresApproval === false;
    const allowlisted = /APPOINTMENT_TOOL_NAMES = \[[\s\S]{0,200}'switch_language'/.test(eng);
    const voiceOnly = eng.includes(".filter((t) => channel === 'voice' || t.name !== 'switch_language')");
    const explicitOnly = /ONLY when the caller EXPLICITLY asks/.test(tool.description)
      && /NEVER call it because of the language the caller happens to be speaking/.test(tool.description);
    const hookThreaded = eng.includes('onLanguageSwitch = null,')
      && /customer_email: customer_email \|\| null,[\s\S]{0,300}onLanguageSwitch,[\s\S]{0,200}origin: \{/.test(eng);
    check('LS1: switch_language is registered (no approval gate), allowlisted for the engine, offered on VOICE only, explicit-request-only by description, and the relay hook is threaded into tool ctx',
      registered && allowlisted && voiceOnly && explicitOnly && hookThreaded,
      JSON.stringify({ registered, allowlisted, voiceOnly, explicitOnly, hookThreaded }));
  }

  // ---- LS2: Spanish switch fires — hook called with es-US, thread re-stamped, confirmation IN SPANISH ----
  {
    freshStrings(false);
    const { ctx, calls } = makeCtx({ current: 'en', enabled: ['en', 'es'] });
    const r = await tool.execute({ language: 'es' }, ctx);
    const hooked = calls.hook.length === 1 && calls.hook[0].lang === 'es' && calls.hook[0].code === 'es-US';
    const restamped = calls.queries.some((q) => /UPDATE appointment_threads SET language = \$1/.test(q.sql) && q.params[0] === 'es' && q.params[1] === 777);
    const confirmedInSpanish = r.success === true && /seguimos en español/.test(r.message);
    check('LS2: an explicit Spanish request on a bilingual workspace fires the relay hook (es-US), re-stamps the conversation, and confirms IN SPANISH',
      hooked && restamped && confirmedInSpanish, JSON.stringify({ hooked, restamped, msg: r.message }));
  }

  // ---- LS3: not-enabled language is declined in the CURRENT language; hook never called ----
  {
    freshStrings(false);
    const { ctx, calls } = makeCtx({ current: 'en', enabled: ['en'] });
    const r = await tool.execute({ language: 'es' }, ctx);
    const declined = r.success === false && /Spanish isn't available for this business/.test(r.message);
    check('LS3: a language the business has NOT enabled is declined in the current language (localized name), and the relay hook is never called',
      declined && calls.hook.length === 0 && calls.queries.length === 0, JSON.stringify({ msg: r.message, hooks: calls.hook.length }));
  }

  // ---- LS4: ARABIC, FLAG OFF — enabled but not voice-ready → "coming soon" in the current language, no switch ----
  {
    const cs = freshStrings(false);
    const { ctx, calls } = makeCtx({ current: 'en', enabled: ['en', 'es', 'ar'] });
    const r = await tool.execute({ language: 'ar' }, ctx);
    const gateHolds = cs.voiceLanguageFor('ar') === 'en';
    const comingSoon = r.success === false && r.coming_soon === 'ar' && /Arabic on the phone is coming soon/.test(r.message)
      && /keep going in English, or I can take a message/.test(r.message);
    check('LS4 [flag OFF]: an explicit Arabic request gets "coming soon" + continue-or-message in the CURRENT language; no relay switch, no re-stamp — the gate is voiceLanguageFor alone',
      gateHolds && comingSoon && calls.hook.length === 0 && calls.queries.length === 0,
      JSON.stringify({ gateHolds, msg: r.message, hooks: calls.hook.length }));
  }

  // ---- LS5: ARABIC, FLAG ON — full peer: switches exactly like Spanish, zero code change ----
  {
    const cs = freshStrings(true);
    const { ctx, calls } = makeCtx({ current: 'en', enabled: ['en', 'es', 'ar'] });
    const r = await tool.execute({ language: 'ar' }, ctx);
    const voiceReady = cs.voiceLanguageFor('ar') === 'ar';
    const hooked = calls.hook.length === 1 && calls.hook[0].lang === 'ar' && calls.hook[0].code === 'ar';
    const restamped = calls.queries.some((q) => /UPDATE appointment_threads SET language/.test(q.sql) && q.params[0] === 'ar');
    const confirmedInArabic = r.success === true && /نكمل بالعربية/.test(r.message);
    check('LS5 [flag ON]: ARABIC_VOICE_ENABLED=true makes Arabic a full peer — the same tool switches (hook ar), re-stamps, and confirms IN ARABIC, with no code change',
      voiceReady && hooked && restamped && confirmedInArabic,
      JSON.stringify({ voiceReady, hooked, restamped, msg: r.message }));
    freshStrings(false); // restore the real (off) state for later rows
  }

  // ---- LS6: the coming-soon line localizes the requested language's NAME into the current language ----
  {
    freshStrings(false);
    const { ctx } = makeCtx({ current: 'es', enabled: ['en', 'es', 'ar'] });
    const r = await tool.execute({ language: 'ar' }, ctx);
    check('LS6: a Spanish-primary caller asking for Arabic hears "árabe … llegará pronto" — the name and the line are both Spanish',
      /árabe por teléfono llegará pronto/.test(r.message), r.message);
  }

  // ---- LS7: never fires off-voice or without the relay hook ----
  {
    freshStrings(false);
    const a = makeCtx({ current: 'en', enabled: ['en', 'es'], channel: 'sms' });
    const ra = await tool.execute({ language: 'es' }, a.ctx);
    const b = makeCtx({ current: 'en', enabled: ['en', 'es'], withHook: false });
    const rb = await tool.execute({ language: 'es' }, b.ctx);
    check('LS7: on a non-voice channel or without the relay hook the switch refuses politely and never fires',
      ra.success === false && a.calls.hook.length === 0 && rb.success === false && b.calls.hook.length === 0 && b.calls.queries.length === 0);
  }

  // ---- LS8: every new canned string declares en/es/ar (census) ----
  {
    const cs = freshStrings(false);
    const keys = ['language_switched', 'language_coming_soon', 'language_not_offered'];
    const allDeclared = keys.every((k) => cs.LANGUAGES.every((l) => typeof cs.STRINGS[k][l] === 'function'));
    const names = cs.languageName('ar', 'en') === 'Arabic' && cs.languageName('ar', 'es') === 'árabe' && cs.languageName('es', 'ar') === 'الإسبانية';
    check('LS8: language_switched / language_coming_soon / language_not_offered declare all three variants, and languageName localizes every pair',
      allDeclared && names);
  }

  // ---- LS9: the relay handler wires the hook; demo caps untouched ----
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const wired = srv.includes("onLanguageSwitch: async (lang, relayCode) => {")
      && srv.includes("ws.send(JSON.stringify({ type: 'language', ttsLanguage: relayCode, transcriptionLanguage: relayCode }))")
      && srv.includes("workspace = { ...workspace, customer_language: lang, _session_language: lang };");
    const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
    const demoCapsIntact = srv.includes("const capMs = isDemo ? 172000 : 580000;")
      && srv.includes('const DEMO_DAILY_MINUTES_CAP = 35;')
      // the never-texts block lives at the engine's send seam
      && eng.includes("SUPPRESSED outbound SMS from DEMO workspace");
    check('LS9: the relay closure sends the ConversationRelay language message + overrides the session workspace (the DTMF-pin mechanism); demo caps and never-texts are language-agnostic and untouched',
      wired && demoCapsIntact, JSON.stringify({ wired, demoCapsIntact }));
  }

  console.log(`${pass}/${pass + fail} — language-switch gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

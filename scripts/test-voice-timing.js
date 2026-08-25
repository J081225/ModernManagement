// scripts/test-voice-timing.js — VE-TIMING gate.
//
// Pins: (a) the production ConversationRelay TwiML carries an explicit
// env-driven speechTimeout (clamped to Twilio's 600-5000ms, default
// 1500) and ignoreBackchannel; (b) interruptible/interruptSensitivity
// are NOT set (defaults, by ruling); (c) the fragment belt — bare
// function-word finals are held and merged, real one-word turns pass;
// (d) the WS handler guards BEFORE the transcript, the emergency gate,
// and the model.

const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const { isBareFragment, makeFragmentGuard } = require(path.join(__dirname, '..', 'lib', 'voice-fragments'));

// VT1 — TwiML: env-driven speechTimeout + ignoreBackchannel; clamp shape.
check('VT1: relay TwiML has speechTimeout (VOICE_SPEECH_TIMEOUT_MS, default 1500, clamped 600-5000) + ignoreBackchannel="true"',
  srv.includes(`' speechTimeout="' + speechTimeoutMs + '" ignoreBackchannel="true" />`)
  && srv.includes("Math.min(5000, Math.max(600, parseInt(process.env.VOICE_SPEECH_TIMEOUT_MS, 10) || 1500))"));

// VT2 — defaults kept by ruling: no interruption tuning on the
// production relay TwiML.
check('VT2: interruptible / interruptSensitivity are NOT set anywhere (defaults by ruling — callers can talk over Sarah)',
  !/interruptible=|interruptSensitivity=/.test(srv));

// VT3 — classifier: fragments vs real one-word turns.
{
  const frags = ['', '  ', 'the', 'The.', 'a', 'um', 'Uh', 'and', 'hmm'].every((w) => isBareFragment(w) === true);
  const real = ['yes', 'no', 'ok', 'stop', 'tomorrow', 'haircut', 'the 2nd', 'at noon'].every((w) => isBareFragment(w) === false);
  check('VT3: "the"/"um"/empty are fragments; "yes"/"no"/"ok"/"stop"/"tomorrow" and ALL multi-word finals are speech (conservative)',
    frags && real, JSON.stringify({ frags, real }));
}

// VT4 — guard behavior: hold + merge, nothing lost, no double-delivery.
{
  const g = makeFragmentGuard();
  const a = g.take('the');
  const b = g.take('2nd works for me');
  const c = g.take('yes');
  const g2 = makeFragmentGuard();
  const d = g2.take('um');
  const e = g2.take('the');
  const f = g2.take('cancel my booking');
  check('VT4: fragment held then MERGED into the next real final; consecutive fragments accumulate; clean turns pass through',
    a.deliver === false && b.deliver === true && b.text === 'the 2nd works for me'
    && c.deliver === true && c.text === 'yes'
    && d.deliver === false && e.deliver === false && f.deliver === true && f.text === 'um the cancel my booking',
    JSON.stringify({ a, b, c, f }));
}

// VT5 — wiring: guard runs BEFORE transcript append, emergency gate,
// and the engine; all three consume the MERGED text.
{
  const iGuard = srv.indexOf('fragmentGuard.take(utterance)');
  const iTranscript = srv.indexOf("appendCallTurn(pool, transcriptId, 'Customer', turnText)");
  const iEmergency = srv.indexOf('detectEmergency(turnText)');
  const iBody = srv.indexOf('body: turnText');
  check('VT5: guard precedes transcript/emergency/engine, and all three use the merged turnText',
    iGuard > -1 && iTranscript > iGuard && iEmergency > iGuard && iBody > iGuard,
    JSON.stringify({ iGuard, iTranscript, iEmergency, iBody }));
}

// ---- GN1-GN4 (GREET-BY-NAME) ----
{
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'customer-strings'))];
  const cs = require(path.join(__dirname, '..', 'lib', 'customer-strings'));
  const kEn = cs.customerString('en', 'voice_greeting_known', { businessName: 'Test Biz', firstName: 'James' });
  const kEs = cs.customerString('es', 'voice_greeting_known', { businessName: 'Test Biz', firstName: 'James' });
  const kAr = cs.customerString('ar', 'voice_greeting_known', { businessName: 'Test Biz', firstName: 'James' });
  const gEn = cs.customerString('en', 'voice_greeting', { businessName: 'Test Biz' });
  check('GN1: known-caller greeting carries the FIRST name + the automated-manager disclosure in en/es/ar; generic unchanged with its disclosure',
    kEn.startsWith('Hi James — thanks for calling Test Biz, this is their automated manager.')
    && kEs.includes('Hola James') && kEs.includes('automatizado')
    && kAr.includes('James') && kAr.includes('الآلي')
    && gEn.includes('Hi, thanks for calling Test Biz — this is their automated manager.'));
}
{
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // GN2: the lookup is try/catch'd with a generic fallback, excludes
  // "Caller " placeholders, takes the FIRST token only, and the
  // known/generic choice is a ternary on the found name.
  check('GN2: ring-answer lookup is failure-tolerant (try/catch -> generic), placeholder-excluded, first-token-only',
    s.includes('greet-by-name lookup failed (generic greeting)')
    && s.includes("!/^Caller /.test(nm)")
    && s.includes('String(nm).trim().split(/\\s+/)[0]')
    && s.includes("callerFirstName\n    ? voiceString(vlang, 'voice_greeting_known'"));
  // GN3: XML-escape still wraps the greeting (a name like O'Brien or
  // one with quotes cannot break the TwiML attribute).
  check('GN3: the greeting (both variants) passes through escapeXmlAttr',
    s.includes('const greeting = escapeXmlAttr(callerFirstName'));
}
{
  const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appointment-engine.js'), 'utf8');
  check('GN4: prompt tells the model to adapt when the caller is not the recognized person and never reuse the wrong name',
    eng.includes('greeted by name but indicates they are someone else')
    && eng.includes('NEVER reuse the wrong name'));
}

console.log(`${pass}/${pass + fail} — voice-timing gate ${fail ? 'FAILED' : 'PASSED'}`);
process.exit(fail ? 1 : 0);

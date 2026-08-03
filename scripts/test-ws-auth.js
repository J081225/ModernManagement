// scripts/test-ws-auth.js — AD9, rebuild of the lost `ws` gate
// (FD3-CP4). handleRelayUpgrade is module-scoped in server.js, so this
// is a slim gate: REPLAY the upgrade-auth decision (valid per-workspace
// token path -> DB match; bare legacy path -> boot-grace only;
// everything else -> silent destroy) and SOURCE-PIN that
// handleRelayUpgrade implements exactly that. The socket answers only
// legitimate Twilio ConversationRelay upgrades.
const path = require('path');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const TOKEN_RE = /^\/twilio-relay\/v2\/([a-f0-9]{48})$/;
const GRACE_MS = 15 * 60 * 1000; // pinned against server.js in WS6

// Replay of the upgrade decision. tokens: known voice_relay_token set.
// Returns 'accept' | 'destroy'. bootAgeMs = now - RELAY_BOOT_TIME.
function decideUpgrade(pathname, { tokens = new Set(), bootAgeMs = Infinity } = {}) {
  const m = pathname.match(TOKEN_RE);
  if (m) return tokens.has(m[1]) ? 'accept' : 'destroy';
  if (pathname === '/twilio-relay' && bootAgeMs < GRACE_MS) return 'accept';
  return 'destroy';
}

const VALID = 'a'.repeat(48); // 48 hex chars
const OTHER = 'b'.repeat(48);

(async () => {
  // ---- WS1: a valid per-workspace token path is accepted ----
  {
    check('WS1: /twilio-relay/v2/<valid 48-hex token> with a matching workspace -> accept',
      decideUpgrade('/twilio-relay/v2/' + VALID, { tokens: new Set([VALID]) }) === 'accept');
  }

  // ---- WS2: a well-formed but UNKNOWN token is destroyed ----
  {
    check('WS2: a syntactically valid token that matches no workspace -> destroy',
      decideUpgrade('/twilio-relay/v2/' + OTHER, { tokens: new Set([VALID]) }) === 'destroy');
  }

  // ---- WS3: a malformed token path is destroyed (wrong length / bad chars) ----
  {
    const short = decideUpgrade('/twilio-relay/v2/' + 'a'.repeat(47), { tokens: new Set([VALID]) });
    const long = decideUpgrade('/twilio-relay/v2/' + 'a'.repeat(49), { tokens: new Set([VALID]) });
    const nonHex = decideUpgrade('/twilio-relay/v2/' + 'g'.repeat(48), { tokens: new Set([VALID]) });
    check('WS3: 47/49-char or non-hex tokens fail the regex -> destroy',
      short === 'destroy' && long === 'destroy' && nonHex === 'destroy');
  }

  // ---- WS4: the bare legacy path is accepted ONLY inside the boot grace ----
  {
    const inGrace = decideUpgrade('/twilio-relay', { bootAgeMs: 5 * 60 * 1000 });
    const afterGrace = decideUpgrade('/twilio-relay', { bootAgeMs: 20 * 60 * 1000 });
    check('WS4: bare /twilio-relay accepted within the 15-min boot grace, destroyed after it',
      inGrace === 'accept' && afterGrace === 'destroy');
  }

  // ---- WS5: unrelated paths are destroyed ----
  {
    check('WS5: any other path -> destroy',
      decideUpgrade('/', {}) === 'destroy'
        && decideUpgrade('/twilio-relay/v2/', {}) === 'destroy'
        && decideUpgrade('/ws', {}) === 'destroy');
  }

  // ---- WS6: source-pins — handleRelayUpgrade implements this ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fnIdx = src.indexOf('async function handleRelayUpgrade');
    const fn = src.slice(fnIdx, src.indexOf("server.on('upgrade'", fnIdx));
    const regexOk = fn.includes('/^\\/twilio-relay\\/v2\\/([a-f0-9]{48})$/');
    const dbMatch = /SELECT id FROM workspaces WHERE voice_relay_token = \$1/.test(fn);
    const graceOk = fn.includes("pathname === '/twilio-relay'") && fn.includes('RELAY_BOOT_TIME')
      && fn.includes('LEGACY_RELAY_GRACE_MS');
    const constsOk = src.includes('const LEGACY_RELAY_GRACE_MS = 15 * 60 * 1000;');
    // every reject path is a silent socket.destroy()
    const destroys = (fn.match(/socket\.destroy\(\)/g) || []).length;
    const boundToServer = src.includes("server.on('upgrade', handleRelayUpgrade)");
    check('WS6: handleRelayUpgrade uses the 48-hex regex, matches voice_relay_token, honors the 15-min grace, and socket.destroy()s every reject',
      fnIdx !== -1 && regexOk && dbMatch && graceOk && constsOk && destroys >= 3 && boundToServer,
      JSON.stringify({ regexOk, dbMatch, graceOk, constsOk, destroys, boundToServer }));
  }

  // ---- WS7: source-pin — a validated token binds the workspace id (cross-workspace refuse) ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function handleRelayUpgrade'), src.indexOf("server.on('upgrade'"));
    check('WS7: a matched token stamps req._relayWorkspaceId so the call setup can refuse a cross-workspace number',
      fn.includes('req._relayWorkspaceId = rows[0].id'));
  }

  console.log(`${pass}/${pass + fail} — ws-auth gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

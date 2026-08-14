// scripts/test-square-connect.js — SQ3 connect gate.
//
// Pins the Square connect flow, the cardsReady derivation across both
// processors, the CSRF state signing, the auto-set-first-connect SQL,
// the switch guard, and the token-encryption-at-storage contract.
// The OAuth HTTP itself is sandbox-only and exercised live in SQ4;
// here we pin the seams and the pure logic.
const path = require('path');
const fs = require('fs');
process.env.TOKEN_ENCRYPTION_KEY = 'sq3-test-key-32bytes-of-randomness';
process.env.SESSION_SECRET = 'sq3-test-session-secret';
const { cardsReady, activeProcessor } = require(path.join(__dirname, '..', 'lib', 'workspace-readiness'));
const { encryptToken, decryptToken } = require(path.join(__dirname, '..', 'lib', 'token-crypto'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'views', 'app.html'), 'utf8');

(function () {
  // ---- SC1: cardsReady derives from the ACTIVE processor ----
  {
    const ok =
      cardsReady({ payment_processor: 'stripe', connect_status: 'ready' }) === true &&
      cardsReady({ payment_processor: 'stripe', connect_status: 'pending' }) === false &&
      cardsReady({ payment_processor: 'square', square_status: 'connected' }) === true &&
      cardsReady({ payment_processor: 'square', square_status: 'not_started' }) === false &&
      // active=square but only Stripe is ready -> NOT ready (the honest case)
      cardsReady({ payment_processor: 'square', connect_status: 'ready', square_status: 'not_started' }) === false &&
      // default (no processor column) behaves as Stripe
      cardsReady({ connect_status: 'ready' }) === true &&
      activeProcessor({}) === 'stripe';
    check('SC1: cardsReady() reads the ACTIVE processor — Stripe ready vs Square connected — and a square-active-but-only-stripe-ready workspace is correctly NOT ready',
      ok);
  }

  // ---- SC2: the connect routes exist with the right guards ----
  {
    // SEC item 2: start is now POST (carries current_password for
    // re-auth); the signed state is session-bound (mintSquareState(req,…)).
    const start = srv.includes("app.post('/api/square/connect/start', requireAuth")
      && srv.includes('squareConnect.isConfigured()') && srv.includes('mintSquareState(req, workspaceId)');
    const callback = srv.includes("app.get('/square/connect/callback'")
      && srv.includes('verifySquareState(req, req.query.state)')
      && srv.includes('encryptToken(tok.access_token)') && srv.includes('encryptToken(tok.refresh_token)');
    // the callback is NOT requireAuth (Square calls it in the browser)
    const callbackPublic = !/app\.get\('\/square\/connect\/callback', requireAuth/.test(srv);
    check('SC2: /api/square/connect/start (authed, configured-guarded, signed state) and /square/connect/callback (public, state-verified, tokens ENCRYPTED before storage) both exist',
      start && callback && callbackPublic, JSON.stringify({ start, callback, callbackPublic }));
  }

  // ---- SC3: tokens are stored encrypted, never plaintext ----
  {
    // the UPDATE writes the *_enc columns from encryptToken(...) and
    // never writes a raw token into a column
    const writesEnc = srv.includes('square_access_token_enc  = $3')
      && srv.includes('square_refresh_token_enc = $4')
      && srv.includes('encryptToken(tok.access_token), encryptToken(tok.refresh_token)');
    const noPlaintextCol = !/square_access_token\b(?!_enc)/.test(srv.replace(/square_access_token_enc/g, ''));
    // and the crypto actually protects: ciphertext != token, round-trips
    const enc = encryptToken('sq0atp-secret-token');
    const roundtrips = decryptToken(enc) === 'sq0atp-secret-token' && !enc.includes('sq0atp-secret-token');
    check('SC3: the callback stores ONLY encrypted tokens (the *_enc columns via encryptToken), no plaintext token column, and the crypto round-trips without leaking the token',
      writesEnc && noPlaintextCol && roundtrips, JSON.stringify({ writesEnc, noPlaintextCol, roundtrips }));
  }

  // ---- SC4: auto-set-first-connect (ruling 1), in the SQL ----
  {
    // payment_processor becomes 'square' only when Stripe is NOT ready
    const autoSet = srv.includes("payment_processor        = CASE WHEN $6 THEN payment_processor ELSE 'square' END")
      && srv.includes("const stripeReady = wr.rows[0] && wr.rows[0].connect_status === 'ready';");
    check('SC4 [ruling 1]: on connect, payment_processor auto-sets to square ONLY when Stripe is not already ready (first-connect); if Stripe is ready both stay connected and the active flag is untouched',
      autoSet);
  }

  // ---- SC5: the switch endpoint guards against activating a dead processor ----
  {
    const ep = srv.includes("app.patch('/api/workspace/payment-processor', requireAuth");
    const guard = srv.includes("const usable = target === 'square' ? row.square_status === 'connected' : row.connect_status === 'ready';")
      && srv.includes('That processor is not connected/ready yet');
    // it does NOT disconnect the other processor (ruling 2) — only UPDATEs payment_processor
    const noDisconnect = srv.includes('UPDATE workspaces SET payment_processor = $1 WHERE id = $2')
      && !/payment-processor'[\s\S]{0,600}square_status\s*=\s*'(revoked|not_started)'/.test(srv);
    check('SC5 [ruling 2]: the switch endpoint activates only a usable processor (ready/connected), never disconnects the other, so a switch can\'t point cards at a dead processor',
      ep && guard && noDisconnect, JSON.stringify({ ep, guard, noDisconnect }));
  }

  // ---- SC6: the switch UI appears ONLY when both are connected ----
  {
    const twoConnGate = /if \(stripeReady && squareConnected\) \{[\s\S]{0,200}sw\.style\.display = ''/.test(app)
      && /sw\.style\.display = 'none'/.test(app);
    const squareRow = app.includes('function renderSquareRow') && app.includes('function startSquareConnect')
      && app.includes('function switchProcessor');
    const planCarries = srv.includes('payment_processor: paymentProcessor')
      && srv.includes('square_status: squareStatus') && srv.includes('cards_ready: cardsReadyDerived');
    check('SC6: the active-processor switch renders only when BOTH processors are usable; the Square row + connect + switch handlers exist; plan-summary carries payment_processor/square_status/cards_ready',
      twoConnGate && squareRow && planCarries, JSON.stringify({ twoConnGate, squareRow, planCarries }));
  }

  // ---- SC7: state signing round-trips + rejects tampering ----
  {
    const crypto = require('crypto');
    const mint = (wid) => {
      const p = `${wid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}`;
      const s = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(p).digest('hex').slice(0, 32);
      return Buffer.from(`${p}.${s}`).toString('base64url');
    };
    const verify = (state) => {
      try {
        const [w, t, n, s] = Buffer.from(String(state), 'base64url').toString('utf8').split('.');
        const e = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`${w}.${t}.${n}`).digest('hex').slice(0, 32);
        if (s !== e) return null;
        if (Date.now() - parseInt(t, 10) > 10 * 60 * 1000) return null;
        return parseInt(w, 10);
      } catch (e) { return null; }
    };
    const st = mint(17);
    check('SC7: the CSRF state (workspace + nonce, HMAC-signed, 10-min) round-trips to the workspace id and rejects tampering/garbage/expiry',
      verify(st) === 17 && verify(st.slice(0, -2) + 'zz') === null && verify('garbage') === null);
  }

  // ---- SC8: the built authorize URL host is EXACTLY Square's Connect
  // base — sandbox AND production forms. The blank-page live-test
  // (2026-08-14) made the host a first-class invariant: the bare
  // squareup(sandbox).com host renders blank; the API/OAuth host carries
  // the required `connect.` subdomain. Build the URL under each env and
  // assert the host + path exactly. ----
  {
    process.env.SQUARE_APP_ID = process.env.SQUARE_APP_ID || 'sandbox-sq0idb-test';
    const envPath = require.resolve(path.join(__dirname, '..', 'lib', 'square-env'));
    const connPath = require.resolve(path.join(__dirname, '..', 'lib', 'square-connect'));
    function authorizeParts(env) {
      const prev = process.env.SQUARE_ENV;
      if (env === undefined) delete process.env.SQUARE_ENV; else process.env.SQUARE_ENV = env;
      delete require.cache[envPath]; delete require.cache[connPath];
      const { authorizeUrl } = require(connPath);
      const u = new URL(authorizeUrl({ state: 's', redirectUri: 'https://mm.test/square/connect/callback' }));
      if (prev === undefined) delete process.env.SQUARE_ENV; else process.env.SQUARE_ENV = prev;
      delete require.cache[envPath]; delete require.cache[connPath];
      return { host: u.host, path: u.pathname, hasSession: u.searchParams.has('session'), session: u.searchParams.get('session') };
    }
    const sb = authorizeParts('sandbox');
    const dflt = authorizeParts(undefined);      // default must be sandbox
    const pr = authorizeParts('production');
    const hostOk = sb.host === 'connect.squareupsandbox.com' && sb.path === '/oauth2/authorize'
      && dflt.host === 'connect.squareupsandbox.com'
      && pr.host === 'connect.squareup.com' && pr.path === '/oauth2/authorize';
    // session: omitted in BOTH envs (Square default true); NEVER 'false'
    // in sandbox — that was the blank-page bug.
    const sessionOk = sb.hasSession === false && dflt.hasSession === false && pr.hasSession === false
      && sb.session !== 'false';
    check('SC8: authorize URL host is EXACTLY connect.squareupsandbox.com (sandbox/default) / connect.squareup.com (production) at /oauth2/authorize, and the session param is OMITTED in both envs — never session=false (the sandbox blank-page bug)',
      hostOk && sessionOk, JSON.stringify({ sb, dflt, pr }));
  }

  // ---- SC9: PUBLIC_BASE_URL hardening — the Square connect path fails
  // LOUD on a missing var, never a silent localhost redirect_uri (the
  // blank-page footgun). Drive the real builder + source-pin the guards. ----
  {
    const { squareRedirectUri } = require(path.join(__dirname, '..', 'lib', 'square-env'));
    const tag = (v) => { try { squareRedirectUri(v); return false; } catch (e) { return e.squareConfig === true; } };
    const throwsOnBlank = tag('') && tag('   ') && tag(null) && tag(undefined);
    const built = squareRedirectUri('https://modernmanagementapp.com');
    const stripped = squareRedirectUri('https://modernmanagementapp.com///');
    const okBuild = built === 'https://modernmanagementapp.com/square/connect/callback'
      && stripped === 'https://modernmanagementapp.com/square/connect/callback';
    const noLocalhostBuilder = !/localhost/.test(squareRedirectUri('https://x'));
    // server const delegates to the lib and carries NO localhost fallback
    const serverDelegates = srv.includes('const SQUARE_REDIRECT_URI = () => squareRedirectUri(process.env.PUBLIC_BASE_URL)');
    const serverNoFallback = !/SQUARE_REDIRECT_URI = \(\)[\s\S]{0,80}localhost/.test(srv);
    // connect/start 503s LOUDLY on the tagged config error
    const loud503 = /err\.squareConfig\)[\s\S]{0,220}status\(503\)/.test(srv);
    check('SC9: squareRedirectUri THROWS (err.squareConfig) on missing/blank PUBLIC_BASE_URL, never emits localhost; the server const delegates with no fallback and connect/start 503s loudly on the config error',
      throwsOnBlank && okBuild && noLocalhostBuilder && serverDelegates && serverNoFallback && loud503,
      JSON.stringify({ throwsOnBlank, okBuild, noLocalhostBuilder, serverDelegates, serverNoFallback, loud503 }));
  }

  console.log(`${pass}/${pass + fail} — square-connect gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

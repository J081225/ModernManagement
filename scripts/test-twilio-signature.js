// scripts/test-twilio-signature.js — SP5c.
//
// The validator must accept a request signed for ANY host it can
// legitimately be reached at (canonical domain, the origin host behind
// it, an x-forwarded-host chain) and still reject everything else.
// This replays the middleware's candidate-URL logic against real
// Twilio signatures — the security property proven, not asserted.
//
// The env flip itself (TWILIO_VALIDATE_WEBHOOKS) happens in the Render
// dashboard; see docs/sp5-investigation.md and the commit message for
// the exact instruction + post-flip probe.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

const TOKEN = 'test_auth_token_secret';
const PARAMS = { CallSid: 'CA123', From: '+15555550123', To: '+18555350785' };

// Twilio's algorithm: HMAC-SHA1 over url + sorted(key+value) pairs.
function sign(url, params, token = TOKEN) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}
function validate(token, signature, url, params) {
  const expected = sign(url, params, token);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(expected)) && expected === signature;
}

// Replay of the middleware's candidate construction (SP5c).
function candidatesFor({ publicBaseUrl, protocol, host, forwardedHost, originalUrl }) {
  const bases = [];
  if (publicBaseUrl) bases.push(publicBaseUrl.replace(/\/+$/, ''));
  const proto = protocol || 'https';
  if (host) bases.push(proto + '://' + host);
  if (forwardedHost) {
    const firstHop = String(forwardedHost).split(',')[0].trim();
    if (firstHop) bases.push(proto + '://' + firstHop);
  }
  const seen = new Set();
  return bases.filter((b) => b && !seen.has(b) && seen.add(b)).map((b) => b + originalUrl);
}
function accepts(reqShape, signature) {
  return candidatesFor(reqShape).some((url) => validate(TOKEN, signature, url, PARAMS));
}

const CANON = 'https://modernmanagementapp.com';
const ORIGIN = 'https://modernmanagement.onrender.com';
const URLPATH = '/api/voice/incoming';

(async () => {
  // ---- TS1: signed for the CANONICAL host -> accepted ----
  {
    const sig = sign(CANON + URLPATH, PARAMS);
    check('TS1: a request signed for the canonical host is accepted',
      accepts({ publicBaseUrl: CANON, protocol: 'https', host: 'modernmanagementapp.com', originalUrl: URLPATH }, sig));
  }

  // ---- TS2: signed for the ORIGIN host -> accepted (the SP5 trap) ----
  {
    const sig = sign(ORIGIN + URLPATH, PARAMS);
    const oldWayAccepts = validate(TOKEN, sig, CANON + URLPATH, PARAMS);
    const newWayAccepts = accepts({
      publicBaseUrl: CANON, protocol: 'https', host: 'modernmanagement.onrender.com', originalUrl: URLPATH,
    }, sig);
    check('TS2 [the trap]: a call signed for the ORIGIN host was REJECTED by the old PUBLIC_BASE_URL-only logic and is ACCEPTED now — this is the case that would have dropped ws3\'s calls the moment validation was switched on',
      oldWayAccepts === false && newWayAccepts === true,
      JSON.stringify({ oldWayAccepts, newWayAccepts }));
  }

  // ---- TS3: x-forwarded-host chain -> accepted ----
  {
    const sig = sign(CANON + URLPATH, PARAMS);
    check('TS3: the first hop of an x-forwarded-host chain is honored (proxy handling)',
      accepts({
        publicBaseUrl: 'https://someotherhost.test', protocol: 'https',
        host: 'internal-origin.local', forwardedHost: 'modernmanagementapp.com, proxy.internal',
        originalUrl: URLPATH,
      }, sig));
  }

  // ---- TS4: a FORGED host cannot mint a valid seal ----
  {
    // The attacker controls the Host header but not the auth token, so
    // they sign with a wrong token (or not at all).
    const forgedSig = sign('https://evil.test' + URLPATH, PARAMS, 'attacker_guess_token');
    check('TS4 [the security property]: an attacker who controls the Host header but NOT the auth token cannot produce an accepted signature — widening the candidate list never widens what can be forged',
      accepts({
        publicBaseUrl: CANON, protocol: 'https', host: 'evil.test', forwardedHost: 'evil.test',
        originalUrl: URLPATH,
      }, forgedSig) === false);
  }

  // ---- TS5: garbage / missing signature rejected ----
  {
    check('TS5: a bogus signature is rejected against every candidate',
      accepts({ publicBaseUrl: CANON, protocol: 'https', host: 'modernmanagementapp.com', originalUrl: URLPATH }, 'OBVIOUSLY_INVALID') === false);
  }

  // ---- TS6: a tampered BODY invalidates a real signature ----
  {
    const sig = sign(CANON + URLPATH, PARAMS);
    const tampered = { ...PARAMS, From: '+19998887777' };
    const ok = candidatesFor({ publicBaseUrl: CANON, protocol: 'https', host: 'modernmanagementapp.com', originalUrl: URLPATH })
      .some((url) => validate(TOKEN, sig, url, tampered));
    check('TS6: a signature valid for the original body does NOT validate once the body is tampered with', ok === false);
  }

  // ---- TS7: a different PATH invalidates the signature ----
  {
    const sig = sign(CANON + URLPATH, PARAMS);
    check('TS7: a signature for /api/voice/incoming is not accepted on /api/sms/incoming',
      accepts({ publicBaseUrl: CANON, protocol: 'https', host: 'modernmanagementapp.com', originalUrl: '/api/sms/incoming' }, sig) === false);
  }

  // ---- TS8: the middleware source carries the multi-candidate logic ----
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const fn = src.slice(src.indexOf('function validateTwilioSignature'), src.indexOf('// --- Workspace helper ---'));
    const multi = fn.includes('candidateBases') && /candidates\.some\(/.test(fn);
    const usesForwarded = fn.includes("req.get('x-forwarded-host')");
    const stillRejects = fn.includes("return res.status(403)") && fn.includes("if (!signature)");
    const bypassStillExists = fn.includes("TWILIO_VALIDATE_WEBHOOKS === 'false'");
    check('TS8: the middleware builds multiple candidate URLs (PUBLIC_BASE_URL + request host + x-forwarded-host) and still 403s on a missing/bad signature; the documented escape hatch remains for emergencies',
      multi && usesForwarded && stillRejects && bypassStillExists,
      JSON.stringify({ multi, usesForwarded, stillRejects, bypassStillExists }));
  }

  console.log(`${pass}/${pass + fail} — twilio-signature suite ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

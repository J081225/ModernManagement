// scripts/test-token-crypto.js — SQ3 token crypto gate.
const path = require('path');
process.env.TOKEN_ENCRYPTION_KEY = 'test-key-32-bytes-of-randomness!!'; // set before require-use
const { encryptToken, decryptToken, isConfigured } =
  require(path.join(__dirname, '..', 'lib', 'token-crypto'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

(function () {
  // ---- TC1: round-trips, and ciphertext is not plaintext ----
  {
    const secret = 'sq0atp-SANDBOX-access-token-abc123';
    const enc = encryptToken(secret);
    check('TC1: encrypt then decrypt returns the original; the stored form is v1-tagged ciphertext, not the token',
      decryptToken(enc) === secret
        && enc.startsWith('v1:') && !enc.includes(secret)
        && enc.split(':').length === 4);
  }

  // ---- TC2: every encryption is unique (random IV) ----
  {
    const a = encryptToken('same-token');
    const b = encryptToken('same-token');
    check('TC2: encrypting the same token twice yields different ciphertext (fresh IV each time), both decrypting back',
      a !== b && decryptToken(a) === 'same-token' && decryptToken(b) === 'same-token');
  }

  // ---- TC3: tamper detection (GCM auth) ----
  {
    const enc = encryptToken('tamper-me');
    const parts = enc.split(':');
    // flip a byte in the ciphertext
    const ctBuf = Buffer.from(parts[3], 'base64'); ctBuf[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], ctBuf.toString('base64')].join(':');
    let threw = false;
    try { decryptToken(tampered); } catch (e) { threw = true; }
    check('TC3: a tampered ciphertext fails authentication and throws (GCM auth tag) — never returns garbage plaintext', threw);
  }

  // ---- TC4: the wrong key cannot decrypt (rotation consequence) ----
  {
    const enc = encryptToken('key-rotation-victim');
    // simulate a rotated key by re-requiring with a different env key
    const fresh = requireFresh();
    process.env.TOKEN_ENCRYPTION_KEY = 'a-completely-different-key-value!';
    let threw = false;
    try { fresh.decryptToken(enc); } catch (e) { threw = true; }
    process.env.TOKEN_ENCRYPTION_KEY = 'test-key-32-bytes-of-randomness!!'; // restore
    check('TC4 [rotation consequence]: ciphertext made under one key cannot be decrypted under a rotated key — it throws, which callers treat as "re-connect required"', threw);
  }

  // ---- TC5: null passthrough + isConfigured ----
  {
    check('TC5: null in -> null out (a workspace with no token stored); isConfigured() true when the key is set',
      encryptToken(null) === null && decryptToken(null) === null && isConfigured() === true);
  }

  // ---- TC6: missing key refuses to operate ----
  {
    const fresh = requireFresh();
    const saved = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    let threwEnc = false, cfg = true;
    try { fresh.encryptToken('x'); } catch (e) { threwEnc = true; }
    try { cfg = fresh.isConfigured(); } catch (e) {}
    process.env.TOKEN_ENCRYPTION_KEY = saved;
    check('TC6: with no TOKEN_ENCRYPTION_KEY set, encrypt refuses (throws) and isConfigured() is false — merchant tokens are never written in the clear',
      threwEnc && cfg === false);
  }

  console.log(`${pass}/${pass + fail} — token-crypto gate ${fail ? 'FAILED' : 'PASSED'}`);
  process.exit(fail ? 1 : 0);
})();

// Re-require the module fresh so an env change is picked up (getKey
// reads process.env at call time, but this keeps the intent explicit).
function requireFresh() {
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'token-crypto'))];
  return require(path.join(__dirname, '..', 'lib', 'token-crypto'));
}

// lib/token-crypto.js — SQ3.
//
// AES-256-GCM encryption for stored bearer credentials (Square OAuth
// access + refresh tokens). These are keys to a merchant's Square
// account; they must never sit in the database in plaintext.
//
// KEY (ruling 3): a DEDICATED env var, TOKEN_ENCRYPTION_KEY — NOT
// SESSION_SECRET. Session-secret rotation happens for its own reasons
// (leaked cookie, routine hygiene) and must never brick every
// merchant's stored tokens as a side effect. The two secrets have
// different lifecycles and must stay independent.
//
// ROTATION CONSEQUENCE (documented, ruling 3): rotating
// TOKEN_ENCRYPTION_KEY makes every previously-encrypted token
// undecryptable. There is no key-version migration here by design —
// the recovery is a re-connect: an affected workspace re-runs the
// Square OAuth flow and stores fresh tokens under the new key. So
// rotate this key ONLY with intent, and expect every Square-connected
// workspace to need a re-connect afterward. (A future key-rotation
// checkpoint could add versioned envelopes; today, simplicity + the
// re-connect path is the deliberate trade.)
//
// FORMAT: "v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>". The version
// prefix lets a later scheme coexist; decrypt rejects anything else.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

// The key is derived from TOKEN_ENCRYPTION_KEY with SHA-256 so any
// sufficiently-random env value yields a valid 32-byte key, exactly
// like a passphrase-to-key step. The env var itself should be a
// 32-byte random value (see the generate command in the SQ3 report).
function getKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw || String(raw).length < 16) {
    throw new Error('TOKEN_ENCRYPTION_KEY is not set (or too short) — refusing to encrypt/decrypt merchant tokens.');
  }
  return crypto.createHash('sha256').update(String(raw)).digest(); // 32 bytes
}

function encryptToken(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM standard nonce length
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

function decryptToken(payload) {
  if (payload == null) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('token-crypto: unrecognized ciphertext format (wrong version or corrupt).');
  }
  const key = getKey();
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  // If the key is wrong or the ciphertext was tampered with, final()
  // throws — GCM authentication. Callers treat a throw as "token
  // unusable; re-connect required" (the rotation consequence above).
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// isConfigured() — cheap check for route guards ("Square connect is
// unavailable until TOKEN_ENCRYPTION_KEY is set") without throwing.
function isConfigured() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  return !!(raw && String(raw).length >= 16);
}

module.exports = { encryptToken, decryptToken, isConfigured, VERSION };

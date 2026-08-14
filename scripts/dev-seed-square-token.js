// scripts/dev-seed-square-token.js — DEV-ONLY, SANDBOX-ONLY.
//
// Bypasses the OAuth ceremony for the sandbox Default Test Account when
// the dashboard-launch path for the test seller is unavailable. Jay
// pastes a dashboard-minted SANDBOX access token at runtime; the script
// encrypts it through the SAME token-crypto path the real callback uses,
// fetches the merchant_id LIVE from Square (so the three-way webhook
// check has a real merchant to verify against), and stores both on ws17
// with square_status='connected'.
//
// SECURITY: the token is read from stdin (or SQUARE_SEED_TOKEN) at
// runtime. It is NEVER committed and NEVER logged — only its ciphertext
// is written, to the square_access_token_enc column. The script refuses
// to run against production.
//
// This is a pragmatic sandbox seed, NOT the OAuth flow. The OAuth
// ceremony's sandbox verification is deferred to SQ6 (production
// cutover), where a real seller session exists — see the report/memory.
//
// Run:  node scripts/dev-seed-square-token.js        (prompts for token)

require('dotenv').config();
const path = require('path');
const readline = require('readline');
const { Pool } = require('pg');
const { squareBase, squareEnv } = require(path.join(__dirname, '..', 'lib', 'square-env'));
const { encryptToken, decryptToken, isConfigured } = require(path.join(__dirname, '..', 'lib', 'token-crypto'));

const WORKSPACE_ID = 17;
const SQUARE_VERSION = '2025-01-23';
const die = (msg) => { console.error('REFUSING: ' + msg); process.exit(1); };

// --- Guards: sandbox-only, crypto configured, DB present ---
if (squareEnv() === 'production' || process.env.SQUARE_ENV === 'production') {
  die('SQUARE_ENV is production — this dev seed is sandbox-only.');
}
if (!/squareupsandbox\.com/.test(squareBase())) {
  die('Square base is not the sandbox host (' + squareBase() + ') — refusing.');
}
if (!isConfigured()) {
  die('TOKEN_ENCRYPTION_KEY is not set/valid — cannot encrypt the token.');
}
if (!process.env.DATABASE_URL) {
  die('DATABASE_URL is not set.');
}

// Read the token WITHOUT persisting/echoing it. Prefer stdin so it never
// lands in shell history; SQUARE_SEED_TOKEN is an explicit opt-in.
function readToken() {
  const fromEnv = (process.env.SQUARE_SEED_TOKEN || '').trim();
  if (fromEnv) return Promise.resolve(fromEnv);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) process.stderr.write(s); };
    rl.question('Paste the SANDBOX access token, then Enter (input is hidden, never logged):\n> ', (ans) => {
      rl.close();
      process.stderr.write('\n');
      resolve(String(ans || '').trim());
    });
    muted = true; // suppress echo of the pasted token
  });
}

// Ask Square who this token belongs to — the real merchant_id the
// webhook's three-way check will verify against. Never logs the token.
async function fetchMerchantId(accessToken) {
  const res = await fetch(`${squareBase()}/v2/merchants`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error('Square /v2/merchants returned ' + res.status
      + (data.errors ? ' — ' + JSON.stringify(data.errors) : '') + ' (is the token valid/current?)');
  }
  const merchant = Array.isArray(data.merchant) && data.merchant[0];
  if (!merchant || !merchant.id) throw new Error('Square returned no merchant for this token.');
  return { id: merchant.id, businessName: merchant.business_name || null, country: merchant.country || null };
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });
  try {
    const ws = await pool.query('SELECT id, vertical, business_name FROM workspaces WHERE id = $1', [WORKSPACE_ID]);
    if (!ws.rows[0]) die('ws' + WORKSPACE_ID + ' not found.');
    console.log(`Seeding Square onto ws${WORKSPACE_ID} (${ws.rows[0].business_name}) in ${squareEnv()} @ ${squareBase()}`);

    const token = await readToken();
    if (!token) die('No token provided.');

    console.log('Fetching merchant_id from Square…');
    const merchant = await fetchMerchantId(token);
    console.log(`  merchant_id: ${merchant.id}` + (merchant.businessName ? ` (${merchant.businessName}, ${merchant.country})` : ''));

    // A dashboard token has NO refresh token and no delivered expiry.
    // Store refresh=NULL and a FUTURE expiry so the payment path uses the
    // token DIRECTLY (ensureFreshSquareToken only refreshes within 24h of
    // expiry — a NULL expiry would (mis)trigger an impossible refresh and
    // flip the row to 'expired'). Sandbox tokens live ~30 days; when this
    // lapses the row flips to 'expired' and you re-seed (or do real OAuth
    // at SQ6). This synthetic expiry is a dev-seed convenience, not a
    // claim about the token's true lifetime.
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // ws17 has Stripe only 'pending' (not ready), so making Square active
    // mirrors the real callback's first-connect auto-set exactly.
    await pool.query(
      `UPDATE workspaces
          SET square_merchant_id       = $2,
              square_access_token_enc  = $3,
              square_refresh_token_enc = NULL,
              square_token_expires_at  = $4,
              square_status            = 'connected',
              payment_processor        = 'square'
        WHERE id = $1`,
      [WORKSPACE_ID, merchant.id, encryptToken(token), expiresAt]
    );

    // Verify by READING THE ROW BACK — decrypt round-trip + merchant present.
    const back = await pool.query(
      `SELECT square_merchant_id, square_access_token_enc, square_refresh_token_enc,
              square_status, square_token_expires_at, payment_processor
         FROM workspaces WHERE id = $1`, [WORKSPACE_ID]
    );
    const row = back.rows[0];
    const decrypted = decryptToken(row.square_access_token_enc);
    const roundTrips = decrypted === token && decrypted.length > 0;

    console.log('\n--- read-back verification (ws' + WORKSPACE_ID + ') ---');
    console.log(JSON.stringify({
      square_status: row.square_status,
      payment_processor: row.payment_processor,
      merchant_id_present: !!row.square_merchant_id,
      merchant_id: row.square_merchant_id,
      refresh_token_enc: row.square_refresh_token_enc, // expect null
      token_expires_at: row.square_token_expires_at,
      decrypt_round_trip: roundTrips ? 'OK' : 'FAILED',
      access_token_enc_is_ciphertext: !row.square_access_token_enc.includes(token),
    }, null, 2));

    const ok = roundTrips && !!row.square_merchant_id
      && row.square_status === 'connected' && row.payment_processor === 'square'
      && !row.square_access_token_enc.includes(token);
    console.log('\n' + (ok ? 'SEED OK — ws' + WORKSPACE_ID + ' is Square-connected (sandbox). Run the payment half now.'
                            : 'SEED FAILED — see the row above.'));
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('SEED ERROR:', err.message); // never includes the token
    process.exit(1);
  } finally {
    await pool.end();
  }
})();

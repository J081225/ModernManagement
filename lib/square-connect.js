// lib/square-connect.js — SQ3.
//
// Square OAuth (SANDBOX). The seller already has a Square account; we
// OAuth for a scoped access + refresh token, unlike Stripe where we
// CREATE an Express account. Sandbox base: connect.squareupsandbox.com.
//
// SANDBOX FACTS (confirmed, refining SQ1): access tokens expire after
// 30 days; code-flow refresh tokens do NOT expire; authorization codes
// expire in 5 minutes and are single-use. So 'connected' is kept alive
// by refresh; a lapsed access token that also fails refresh is
// 'expired'.
//
// Nothing here touches production Square — SQUARE_ENV must be 'sandbox'
// for this checkpoint (guarded below). Tokens are encrypted by the
// caller (lib/token-crypto) before storage; this module only speaks
// HTTP to Square and never persists.

const { isConfigured: cryptoConfigured } = require('./token-crypto');

// The Square Connect API base (authorize, token, and /v2 all hang off
// it). Sandbox by default; SQ6's production cutover is the single env
// flip in lib/square-env — no host lives hardcoded here anymore.
const { squareBase } = require('./square-env');
const SQUARE_BASE = squareBase();
const SCOPES = ['PAYMENTS_WRITE', 'PAYMENTS_READ', 'ORDERS_WRITE', 'MERCHANT_PROFILE_READ'];

function isConfigured() {
  return !!(process.env.SQUARE_APP_ID && process.env.SQUARE_APP_SECRET && cryptoConfigured());
}

// The authorize URL the owner's browser is sent to. `state` is a
// CSRF/workspace token the caller mints and later verifies.
function authorizeUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    client_id: process.env.SQUARE_APP_ID,
    scope: SCOPES.join(' '),
    session: 'false',
    state,
    redirect_uri: redirectUri,
  });
  return `${SQUARE_BASE}/oauth2/authorize?${params.toString()}`;
}

// Exchange the one-time authorization code for tokens. Returns the raw
// Square token payload (access_token, refresh_token, expires_at,
// merchant_id) — the CALLER encrypts + stores.
async function exchangeCodeForToken({ code, redirectUri }) {
  const res = await fetch(`${SQUARE_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' },
    body: JSON.stringify({
      client_id: process.env.SQUARE_APP_ID,
      client_secret: process.env.SQUARE_APP_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error('square token exchange failed: ' + (data.errors ? JSON.stringify(data.errors) : res.status));
    err.squareStatus = res.status;
    throw err;
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || null,   // ISO string, ~30 days out
    merchant_id: data.merchant_id || null,
  };
}

// Refresh an access token using the (non-expiring) refresh token.
// Same return shape as exchange. A failure here is what flips a
// workspace from 'connected' to 'expired'.
async function refreshAccessToken({ refreshToken }) {
  const res = await fetch(`${SQUARE_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' },
    body: JSON.stringify({
      client_id: process.env.SQUARE_APP_ID,
      client_secret: process.env.SQUARE_APP_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error('square token refresh failed: ' + (data.errors ? JSON.stringify(data.errors) : res.status));
    err.squareStatus = res.status;
    throw err;
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken, // Square may omit; keep the old one
    expires_at: data.expires_at || null,
    merchant_id: data.merchant_id || null,
  };
}

module.exports = { isConfigured, authorizeUrl, exchangeCodeForToken, refreshAccessToken, SQUARE_BASE, SCOPES };

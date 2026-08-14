// lib/square-env.js — SQ6 prep. The ONE place Square's host lives, so
// the production cutover is a single env flip (SQUARE_ENV=production),
// not a hunt across files.
//
// Both values are Square's authoritative Connect API base, verified
// against Square's OAuth API reference (2026-08-14): the Authorize
// endpoint, the OAuth token endpoint, and every /v2 REST call all hang
// off this ONE base per environment. The `connect.` subdomain is
// REQUIRED — the bare squareup(sandbox).com host is not the API/OAuth
// host (a bare-host authorize URL lands on a blank page).
//
//   sandbox    → https://connect.squareupsandbox.com
//   production → https://connect.squareup.com
//
// Default is sandbox; production requires an EXPLICIT SQUARE_ENV, so the
// SQ6 go-live is a deliberate, single-switch decision.
const HOSTS = {
  sandbox: 'https://connect.squareupsandbox.com',
  production: 'https://connect.squareup.com',
};

function squareEnv() {
  return process.env.SQUARE_ENV === 'production' ? 'production' : 'sandbox';
}

function squareBase() {
  return HOSTS[squareEnv()];
}

// The OAuth redirect_uri Square sends the seller back to. PUBLIC_BASE_URL
// is REQUIRED on this path — a missing/blank value must THROW, never
// silently fall back to localhost. A localhost redirect_uri can't work
// with Square (it isn't a registered https URL), so the old fallback
// only produced a blank authorize page with no clue why; failing loud
// turns a silent misconfiguration into a diagnosable one. Callers pass
// process.env.PUBLIC_BASE_URL; the returned value must EXACTLY match the
// Redirect URL registered in the Square Developer Dashboard.
function squareRedirectUri(publicBaseUrl) {
  const base = String(publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    const err = new Error('PUBLIC_BASE_URL is not set — refusing to build a Square redirect_uri that would point at localhost.');
    err.squareConfig = true;
    throw err;
  }
  return base + '/square/connect/callback';
}

module.exports = { squareBase, squareEnv, squareRedirectUri, HOSTS };

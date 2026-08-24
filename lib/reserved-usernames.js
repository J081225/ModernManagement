// lib/reserved-usernames.js
//
// VE1: THE single reserved-usernames list. These names are refused at
// BOTH signup validation sites — the availability pre-check
// (/api/signup/check-username) and the checkout submit — with the SAME
// response shape as a taken username, so the reserved list itself is
// never advertised to a prober.
//
// Why: the vanity-email arc will mint <username>@modernmanagementapp.com
// addresses. These local parts are platform senders (noreply), RFC-
// expected addresses (postmaster, abuse, hostmaster, webmaster), ops
// addresses we use or will want (support, billing, security, ...), and
// brand names — none may ever belong to a customer
// (docs/vanity-email-findings.md §5).
//
// Existing user 'admin' (user 1) is GRANDFATHERED — this gate applies
// to NEW signups only; that account's retirement is a separately ruled
// item. This module is pure (no DB access): it can never touch an
// existing row.

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'noreply', 'no_reply', 'support', 'help',
  'billing', 'info', 'sales', 'mail', 'email', 'postmaster', 'abuse',
  'security', 'legal', 'root', 'system', 'contact', 'team', 'hello',
  'office', 'accounts', 'notifications', 'alerts', 'api',
  'mailer_daemon', 'mailer', 'hostmaster', 'webmaster', 'marketing',
  'press', 'privacy', 'staff', 'owner', 'moderator',
  'modernmanagement', 'modernmgmt', 'mm', 'r2labs', 'r2_labs',
]);

// Same normalization the signup routes apply before their own checks,
// so the answer can't diverge from what actually gets stored.
function isReservedUsername(username) {
  return RESERVED_USERNAMES.has(String(username || '').trim().toLowerCase());
}

module.exports = { RESERVED_USERNAMES, isReservedUsername };

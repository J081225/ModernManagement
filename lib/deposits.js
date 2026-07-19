// lib/deposits.js — FD3-CP6.
//
// Deposit policy in one testable module, shared by the settings
// endpoints (honest toggle), book_appointment (the flow), and the
// harness (dormancy proof).
//
// IRON LAW: no real payment link reaches a real customer until Stripe
// live mode exists. The entire payment path runs on the client built
// from STRIPE_TEST_SECRET_KEY (server.js — stripeSignup; the legacy
// STRIPE_SECRET_KEY client is deprecated), and there is no livemode
// branch anywhere in it. So live mode is detectable in exactly one
// honest place: the key's own prefix. sk_live_… means live;
// sk_test_… (or anything else) means the feature stays asleep.
// DEPOSITS_LIVE_OVERRIDE=true exists for staging tests only.

function depositsLive(env) {
  const e = env || {};
  if (e.DEPOSITS_LIVE_OVERRIDE === 'true') return true;
  return String(e.STRIPE_TEST_SECRET_KEY || '').startsWith('sk_live_');
}

const DEPOSIT_MODES = ['percent', 'flat'];

// NULL columns mean "never configured" — disabled, 20% default shown
// in the UI when the owner eventually can enable it.
function depositConfig(workspace) {
  const w = workspace || {};
  const mode = DEPOSIT_MODES.includes(w.deposit_mode) ? w.deposit_mode : 'percent';
  const value = Number.isInteger(w.deposit_value) && w.deposit_value > 0
    ? w.deposit_value
    : (mode === 'percent' ? 20 : null);
  return {
    enabled: w.deposit_enabled === true,
    mode,
    value,
  };
}

// The amount a booking should collect up front, or null for "no
// deposit". Percent mode applies to the QUOTED price (look-first (b):
// menu pricing is "starting from" — quoted_price_cents on the
// appointment is the number the customer actually heard); a booking
// with no quoted price gets NO percent deposit rather than a guessed
// one. Flat mode always applies. Deposits never exceed the quoted
// price when one exists.
function computeDepositCents(workspace, quotedPriceCents) {
  const cfg = depositConfig(workspace);
  if (!cfg.enabled || !cfg.value) return null;
  if (cfg.mode === 'flat') {
    if (quotedPriceCents > 0 && cfg.value > quotedPriceCents) return quotedPriceCents;
    return cfg.value;
  }
  if (!Number.isInteger(quotedPriceCents) || quotedPriceCents <= 0) return null;
  const cents = Math.round((quotedPriceCents * cfg.value) / 100);
  return cents > 0 ? cents : null;
}

module.exports = { depositsLive, depositConfig, computeDepositCents, DEPOSIT_MODES };

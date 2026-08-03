// scripts/test-deposits.js — AD9, rebuild of the lost `deposits` gate.
//
// The IRON LAW (FD3-CP6): no real payment link until Stripe live mode,
// detectable only from the key prefix. Plus the deposit config
// defaults and the quoted-price cents math. Pure module — driven
// directly.
const path = require('path');
const { depositsLive, depositConfig, computeDepositCents, DEPOSIT_MODES } =
  require(path.join(__dirname, '..', 'lib', 'deposits'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- DEP1: dormancy — live ONLY on sk_live_ or the explicit override ----
{
  check('DEP1: sk_test_ key -> asleep; sk_live_ key -> live; override -> live; empty -> asleep',
    depositsLive({ STRIPE_TEST_SECRET_KEY: 'sk_test_abc' }) === false
      && depositsLive({ STRIPE_TEST_SECRET_KEY: 'sk_live_abc' }) === true
      && depositsLive({ DEPOSITS_LIVE_OVERRIDE: 'true' }) === true
      && depositsLive({}) === false
      && depositsLive(undefined) === false,
    JSON.stringify({ test: depositsLive({ STRIPE_TEST_SECRET_KEY: 'sk_test_abc' }) }));
}

// ---- DEP2: the override is EXACT 'true' — no truthy leniency ----
{
  check('DEP2: DEPOSITS_LIVE_OVERRIDE only the string "true" flips it (not "1"/"yes"/true-ish)',
    depositsLive({ DEPOSITS_LIVE_OVERRIDE: 'true' }) === true
      && depositsLive({ DEPOSITS_LIVE_OVERRIDE: '1' }) === false
      && depositsLive({ DEPOSITS_LIVE_OVERRIDE: 'yes' }) === false
      && depositsLive({ DEPOSITS_LIVE_OVERRIDE: 'TRUE' }) === false);
}

// ---- DEP3: config defaults — NULL columns mean disabled, 20% shown ----
{
  const fresh = depositConfig({});
  const flat = depositConfig({ deposit_mode: 'flat' });
  check('DEP3: unconfigured workspace -> disabled, percent mode, 20 default; flat mode with no value -> null value',
    fresh.enabled === false && fresh.mode === 'percent' && fresh.value === 20
      && flat.mode === 'flat' && flat.value === null,
    JSON.stringify({ fresh, flat }));
}

// ---- DEP4: config honors stored values; bad mode falls back to percent ----
{
  const cfg = depositConfig({ deposit_enabled: true, deposit_mode: 'flat', deposit_value: 5000 });
  const badMode = depositConfig({ deposit_enabled: true, deposit_mode: 'garbage', deposit_value: 30 });
  const badValue = depositConfig({ deposit_enabled: true, deposit_mode: 'percent', deposit_value: -5 });
  check('DEP4: valid stored config passes through; unknown mode -> percent; non-positive value -> percent default 20',
    cfg.enabled === true && cfg.mode === 'flat' && cfg.value === 5000
      && badMode.mode === 'percent' && badMode.value === 30
      && badValue.value === 20,
    JSON.stringify({ cfg, badMode, badValue }));
}

// ---- DEP5: disabled or zero-value -> collects nothing ----
{
  check('DEP5: disabled workspace, or enabled-but-no-value, collects null',
    computeDepositCents({ deposit_enabled: false, deposit_mode: 'percent', deposit_value: 20 }, 10000) === null
      && computeDepositCents({ deposit_enabled: true, deposit_mode: 'flat', deposit_value: 0 }, 10000) === null);
}

// ---- DEP6: percent applies to the QUOTED price; no quote -> no percent deposit ----
{
  const ws = { deposit_enabled: true, deposit_mode: 'percent', deposit_value: 20 };
  check('DEP6: 20% of a $100 quote = 2000c; a booking with no quoted price gets NO guessed deposit (null)',
    computeDepositCents(ws, 10000) === 2000
      && computeDepositCents(ws, 0) === null
      && computeDepositCents(ws, null) === null
      && computeDepositCents(ws, undefined) === null);
}

// ---- DEP7: percent rounds to the nearest cent; a rounding-to-zero -> null ----
{
  const ws = { deposit_enabled: true, deposit_mode: 'percent', deposit_value: 20 };
  const tiny = { deposit_enabled: true, deposit_mode: 'percent', deposit_value: 1 };
  check('DEP7: 20% of 1013c rounds to 203c; 1% of 10c rounds to 0 -> null (never a zero-cent link)',
    computeDepositCents(ws, 1013) === 203 && computeDepositCents(tiny, 10) === null,
    JSON.stringify({ r: computeDepositCents(ws, 1013), z: computeDepositCents(tiny, 10) }));
}

// ---- DEP8: flat mode always applies but never exceeds the quoted price ----
{
  const ws = { deposit_enabled: true, deposit_mode: 'flat', deposit_value: 5000 };
  check('DEP8: flat $50 with no quote -> 5000c; with a $30 quote it caps at the quote (3000c), never over-collects',
    computeDepositCents(ws, null) === 5000
      && computeDepositCents(ws, 3000) === 3000
      && computeDepositCents(ws, 8000) === 5000,
    JSON.stringify({ noQuote: computeDepositCents(ws, null), under: computeDepositCents(ws, 3000) }));
}

// ---- DEP9: the mode allow-list is exactly percent + flat ----
{
  check('DEP9: DEPOSIT_MODES is exactly [percent, flat]',
    Array.isArray(DEPOSIT_MODES) && DEPOSIT_MODES.length === 2
      && DEPOSIT_MODES.includes('percent') && DEPOSIT_MODES.includes('flat'));
}

console.log(`${pass}/${pass + fail} — deposits gate ${fail ? 'FAILED' : 'PASSED'}`);
process.exit(fail ? 1 : 0);

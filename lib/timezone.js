// lib/timezone.js — ST3.
//
// The one validator for workspace time zones. IANA names only —
// validated by asking the runtime itself (Intl throws on unknown
// zones), so the accepted set is exactly what date math downstream
// (wsTz: calendar day-math, ledger/report dating) can actually honor.
// No hand-maintained list to drift.

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { isValidTimeZone };

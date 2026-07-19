// lib/phone.js
//
// Shared phone normalization (FD1). contacts.phone is free text — every
// writer stores whatever the caller typed ("(443) 555-1234", "4435551234",
// "+1 443 555 1234"), so equality checks must canonicalize BOTH sides.
// These helpers normalize the COMPARISON only; stored values are not
// rewritten.

// Canonical E.164-ish form. US-centric (the product's Twilio numbers are
// US local): 10 digits → +1XXXXXXXXXX; 11 starting with 1 → +1 + rest;
// an explicit + with more digits passes through as international.
// Anything shorter than 10 digits is too ambiguous to match → null.
function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (s.startsWith('+') && digits.length > 11) return '+' + digits;
  return null;
}

// Last 10 digits, for SQL-side comparison against free-text stored
// phones via RIGHT(regexp_replace(phone, '\D', '', 'g'), 10).
function phoneDigits10(raw) {
  const norm = normalizePhone(raw);
  if (!norm) return null;
  return norm.replace(/\D/g, '').slice(-10);
}

// Recoverable placeholder name for a contact created without a name:
// "Caller +1 443-555-1234".
function callerPlaceholderName(raw) {
  const norm = normalizePhone(raw);
  if (!norm) return 'Caller (unknown number)';
  const d = norm.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') {
    return `Caller +1 ${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  }
  return 'Caller ' + norm;
}

module.exports = { normalizePhone, phoneDigits10, callerPlaceholderName };

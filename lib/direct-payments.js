// lib/direct-payments.js — VZ item 1 validators.
//
// Pure normalize/validate for the two MANUAL-CONFIRM direct-payment
// handles the "How you get paid" card persists: a Venmo username and a
// Zelle contact (email or US phone). Format-sanity ONLY — we cannot and
// do NOT claim a handle exists or is reachable; that honesty is the
// whole point of the manual-confirm framing. Each returns either
// { value } (a canonical string, or null to CLEAR the field) or
// { error } (a human sentence for a 400). No I/O, unit-testable.

// Venmo usernames: 5–30 chars, letters/numbers/dashes/underscores. A
// leading '@' is display sugar and is stripped before validation. Empty
// clears the field.
function normalizeVenmoHandle(input) {
  if (input == null) return { value: null };
  if (typeof input !== 'string') return { error: 'Enter your Venmo username as text.' };
  let h = input.trim();
  if (h.startsWith('@')) h = h.slice(1).trim();
  if (h === '') return { value: null }; // explicit clear
  if (!/^[A-Za-z0-9_-]{5,30}$/.test(h)) {
    return { error: 'Enter a valid Venmo username: 5–30 letters, numbers, dashes, or underscores (no @).' };
  }
  return { value: h }; // stored WITHOUT the '@'
}

// Zelle is reached by an email OR a US phone number. Accept either;
// reject anything that is plainly neither. Store the trimmed original
// (owner-facing reference string, not a key we dispatch on). Empty
// clears the field.
function normalizeZelleInfo(input) {
  if (input == null) return { value: null };
  if (typeof input !== 'string') return { error: 'Enter your Zelle email or phone as text.' };
  const z = input.trim();
  if (z === '') return { value: null }; // explicit clear
  if (z.length > 100) return { error: 'That Zelle contact is too long.' };
  const looksEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(z);
  const digits = z.replace(/[\s().+-]/g, '');
  const looksPhone = /^\d{10,15}$/.test(digits);
  if (!looksEmail && !looksPhone) {
    return { error: 'Enter the email address or phone number linked to your Zelle.' };
  }
  return { value: z };
}

module.exports = { normalizeVenmoHandle, normalizeZelleInfo };

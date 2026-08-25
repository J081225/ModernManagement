// lib/voice-fragments.js — VE-TIMING: the engine-side fragment belt.
//
// Endpointing can fire mid-sentence and emit a bare function word
// ("the", "um") as its own final — call 92's fragment turn triggered a
// mid-call greeting-shaped model reply. This guard HOLDS such
// fragments and merges them into the next final, so no words are lost
// and the model never receives a contentless turn.
//
// CONSERVATIVE BY CONSTRUCTION (the ruling: when in doubt, it is
// speech): multi-word finals ALWAYS pass; a single word passes unless
// it is on the closed function-word/filler list below. Real one-word
// turns — "yes", "no", "ok", "stop", "tomorrow" — always reach the
// model.

const FRAGMENT_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at',
  'for', 'so', 'if', 'uh', 'um', 'er', 'erm', 'hmm', 'mm', 'mhm',
  'like',
]);

function isBareFragment(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[^a-z0-9' ]/g, '').trim();
  if (!t) return true;
  const tokens = t.split(/\s+/);
  if (tokens.length > 1) return false; // multi-word: always speech
  return FRAGMENT_WORDS.has(tokens[0]);
}

// Per-call state machine. take(final) -> { deliver, text }:
// fragment -> held (deliver:false); real speech -> delivered with any
// held fragments prepended, hold cleared.
function makeFragmentGuard() {
  let held = '';
  return {
    take(text) {
      const t = String(text || '').trim();
      if (isBareFragment(t)) {
        held = (held + ' ' + t).trim();
        return { deliver: false, text: '' };
      }
      const merged = (held + ' ' + t).trim();
      held = '';
      return { deliver: true, text: merged };
    },
  };
}

module.exports = { isBareFragment, makeFragmentGuard, FRAGMENT_WORDS };

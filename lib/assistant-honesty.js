// lib/assistant-honesty.js — the owner-assistant honesty guards.
//
// Born from a live defect: the Command Center told Jay it had added a
// menu item, updated its price, and blocked two weeks of calendar —
// and NONE of it happened. Three claimed mutations, zero database
// rows. Two mechanisms, both fixed here.
//
// 1. IMITATION. The history renderer used to append "[tools used: X]"
//    to replayed ASSISTANT turns. The model read that marker as part
//    of its own voice and started WRITING it as prose instead of
//    calling tools — a completion claim with nothing behind it.
//    Anything in the assistant channel is a few-shot example; tool
//    records must never live there.
//
// 2. UNVERIFIED CLAIMS. Nothing checked the reply against reality. A
//    turn that invoked zero tools could still say "I've added it."
//    verifyReplyClaims() is the gate: no tools ran, no completion
//    claim survives.

// Any form of the tool marker, wherever it landed (server-appended
// historically, or model-written since it learned the pattern).
const TOOL_MARKER_RE = /\n?\[tools used:[^\]]*\]?/gi;

function stripToolMarker(text) {
  if (text == null) return '';
  return String(text).replace(TOOL_MARKER_RE, '').trim();
}

function hasToolMarker(text) {
  TOOL_MARKER_RE.lastIndex = 0;
  return TOOL_MARKER_RE.test(String(text == null ? '' : text));
}

// First-person MUTATION claims — "I've added", "I have updated",
// "I've gone ahead and booked". Deliberately narrow: read-ish verbs
// (found, checked, looked) are NOT here, because a zero-tool turn
// saying "I found nothing" is merely unhelpful, while a zero-tool
// turn saying "I've added it" is a lie about the database.
const MUTATION_CLAIM_RE = new RegExp(
  "\\bI(?:'ve| have| already)?\\s+(?:just\\s+|gone ahead and\\s+|now\\s+)?" +
  "(?:added|created|updated|changed|set|saved|booked|scheduled|rescheduled|" +
  "canceled|cancelled|deleted|removed|archived|blocked(?: off)?|sent|" +
  "posted|logged|recorded|assigned|marked|refunded|voided|issued)\\b",
  'i'
);

// verifyReplyClaims({ reply, toolInvocationCount })
//   -> { ok: true, reply }                          nothing to correct
//   -> { ok: false, reply: <honest text>, reason }  claim without tools
//
// A turn that actually invoked tools is trusted: the tools' own
// results are the truth, and a wrong claim there is a different bug.
// This gate governs exactly the case the defect showed — a reply
// claiming a mutation when the model called nothing at all.
function verifyReplyClaims({ reply, toolInvocationCount }) {
  const text = String(reply == null ? '' : reply);
  if (toolInvocationCount > 0) return { ok: true, reply: text };

  const claimsMutation = MUTATION_CLAIM_RE.test(text);
  const claimsTools = hasToolMarker(text);
  if (!claimsMutation && !claimsTools) return { ok: true, reply: text };

  return {
    ok: false,
    reason: claimsTools ? 'tool_marker_without_tools' : 'mutation_claim_without_tools',
    reply: "I didn't actually complete that — nothing was changed. "
      + 'Please try again, and tell support if it keeps happening.',
  };
}

module.exports = {
  stripToolMarker,
  hasToolMarker,
  verifyReplyClaims,
  TOOL_MARKER_RE,
  MUTATION_CLAIM_RE,
};

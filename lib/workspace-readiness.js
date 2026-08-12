// lib/workspace-readiness.js — SP3.
//
// The derived, per-capability readiness view. Display surfaces read
// THIS instead of overloading either status column:
//   - cards  = the Stripe axis (connect_status, verbatim — SP3's
//     ruling keeps that column card-only forever).
//   - phone  = the Twilio axis (twilio_status, cross-checked against
//     the number so a pre-migration row or lying fixture reads as
//     what it IS, never as ready).
// Two independent facts, honestly rendered — a workspace can accept
// cards while its number is still arriving (SP4's legal pending
// state), and the copy for each capability tells its own truth.
//
// Also the code-side half of the 061 invariant: assertPhoneStatusLegal
// refuses the illegal pair before it ever reaches the DB CHECK, so
// SP4's async writer fails loudly at the call site, not as a
// constraint violation two layers down.

const TWILIO_STATUSES = ['not_started', 'provisioning', 'active', 'failed'];

function phoneAxis(workspace) {
  const w = workspace || {};
  const hasNumber = !!(w.twilio_phone_number && String(w.twilio_phone_number).trim());
  let status = TWILIO_STATUSES.includes(w.twilio_status) ? w.twilio_status : null;
  if (status === null) {
    // Pre-061 row (or a caller that didn't select the column): derive
    // from the number, the ground truth the CHECK ties status to.
    status = hasNumber ? 'active' : 'not_started';
  }
  // The DB makes divergence unwritable; if a fixture or stale read
  // lies anyway, the NUMBER wins — never render "active" without one.
  if (status === 'active' && !hasNumber) status = 'failed';
  if (status !== 'active' && hasNumber) status = 'active';
  return status;
}

// SQ3: "can this workspace accept a card payment right now?" — derived
// from the ACTIVE processor, not a raw column. The SP3 pattern extended
// to two processors: Stripe readiness is connect_status==='ready';
// Square readiness is square_status==='connected'. Every payment-gating
// surface reads THIS, never a raw status, so the two-processor logic
// lives in exactly one place and can't drift.
function activeProcessor(workspace) {
  return (workspace && workspace.payment_processor) || 'stripe';
}
function cardsReady(workspace) {
  const w = workspace || {};
  return activeProcessor(w) === 'square'
    ? w.square_status === 'connected'
    : w.connect_status === 'ready';
}

function workspaceReadiness(workspace) {
  const w = workspace || {};
  // The cards axis now reflects the ACTIVE processor's status, so the
  // derived view is honest whichever processor is in use.
  const proc = activeProcessor(w);
  const cards = proc === 'square' ? (w.square_status || 'not_started') : (w.connect_status || 'not_started');
  const phone = phoneAxis(w);
  const cards_ready = cardsReady(w);
  const phone_active = phone === 'active';
  return {
    cards,
    cards_ready,
    phone,
    phone_active,
    // 'ready' = everything attached; 'pending' = something is honestly
    // in flight; 'partial' = something needs owner/operator attention
    // or was never started.
    overall: (cards_ready && phone_active) ? 'ready'
      : (phone === 'provisioning' || cards === 'pending') ? 'pending'
      : 'partial',
  };
}

// Refuse the illegal pair in code (the 061 CHECK's sibling). Throws —
// a writer about to record "active with no number" (or a number with
// a non-active claim it should have flipped) is a bug to surface, not
// a row to store.
function assertPhoneStatusLegal({ twilio_status, twilio_phone_number }) {
  if (!TWILIO_STATUSES.includes(twilio_status)) {
    throw new Error('illegal twilio_status: ' + twilio_status);
  }
  const hasNumber = !!(twilio_phone_number && String(twilio_phone_number).trim());
  if ((twilio_status === 'active') !== hasNumber) {
    throw new Error(
      'twilio_status/number invariant violated: status=' + twilio_status +
      ', number=' + (hasNumber ? 'present' : 'absent')
    );
  }
  return true;
}

// SP4b: the ONE decision for "may we text this workspace's customer,
// and from what number?" Returns the workspace's own number, or null
// to HOLD.
//
// The customer-facing platform-number fallback is RETIRED (ruled).
// Sending from the shared platform number was doubly wrong: the
// customer sees an unfamiliar sender, and any reply lands on a number
// whose inbound routing (lookupWorkspaceByTwilioNumber) matches no
// workspace — an IB5 unroutable drop. Post-SP3 it could only fire in
// a broken or pending state anyway.
//
// The check is the NUMBER, not the status column, and that is exact:
// migration 061 makes (twilio_status='active') = (phone IS NOT NULL)
// a database invariant, so number-present IS status-active. Callers
// therefore need no extra column selected.
function customerSmsFrom(workspace) {
  const num = workspace && workspace.twilio_phone_number;
  const trimmed = num ? String(num).trim() : '';
  return trimmed || null;
}

module.exports = {
  TWILIO_STATUSES,
  phoneAxis,
  workspaceReadiness,
  assertPhoneStatusLegal,
  customerSmsFrom,
  cardsReady,
  activeProcessor,
};
